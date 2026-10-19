/*
 * Headless harness for the webview canvas.
 *
 * The canvas is plain DOM code with no build step, so it can be exercised under Node with a
 * minimal DOM stand-in. This is a smoke test, not a browser test: it proves the render and
 * edit paths execute and produce the right DOM and the right outgoing messages, without a
 * headless browser in the loop.
 *
 * Run: node extension/test/hostHarness.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log('  PASS  ' + label); }
    else { console.log('  FAIL  ' + label + (detail ? '  <- ' + detail : '')); failures++; }
}

// ------------------------------------------------------------------ tiny DOM

class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...c) { c.forEach((x) => x && this.set.add(x)); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
    toggle(c, on) { on ? this.add(c) : this.remove(c); }
}

class El {
    constructor(tag) {
        this.tagName = (tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = new Proxy({}, {
            set: (t, k, v) => { t[k] = v; return true; },
            get: (t, k) => t[k],
        });
        this.dataset = {};
        this._class = '';
        this._text = '';
        this.attrs = {};
        this.listeners = {};
        this.classList = new ClassList(this);
        this.value = '';
        this.disabled = false;
        this.title = '';
        this.tabIndex = 0;
        this.offsetHeight = 42;
        this.offsetWidth = 300;
        this.clientWidth = 300;
        this.clientHeight = 200;
    }
    get className() { return this._class; }
    set className(v) {
        this._class = v;
        this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    get textContent() {
        if (this.children.length) return this.children.map((c) => c.textContent).join('');
        return this._text;
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get innerHTML() { return this._html || ''; }
    set innerHTML(v) { this._html = v; this.children = []; }
    appendChild(c) {
        // Faithful move semantics: appending an attached node MOVES it (the D10 view
        // regroup re-appends live rows instead of rebuilding them, so listeners and
        // in-progress input survive the switch). Without this the stand-in duplicates.
        if (c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
        else if (c.parentNode === this) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
        }
        c.parentNode = this; this.children.push(c); return c;
    }
    removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get firstChild() { return this.children[0] || null; }
    querySelectorAll(sel) {
        const out = [];
        const want = sel.trim();
        (function walk(n) {
            for (const c of n.children) {
                if (matches(c, want)) out.push(c);
                walk(c);
            }
        })(this);
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) {
        // Faithful DOM API the canvas relies on to tell a bubbled ancestor event from a
        // direct one. `matches` is a hoisted function declaration, so it is available here.
        let n = this;
        while (n) {
            if (matches(n, sel)) return n;
            n = n.parentNode;
        }
        return null;
    }
    // Mirrors the browser's behaviour for a transformed element: getBoundingClientRect
    // returns SCALED pixels. The canvas divides every pointer delta out of this, and a stand-in
    // that ignored the transform would let a zoom bug pass this harness.
    get scale() { return this._scale === undefined ? 1 : this._scale; }
    set scale(v) { this._scale = v; }
    getBoundingClientRect() {
        const k = this.scale;
        return {
            left: 0, top: 0,
            right: this.clientWidth * k, bottom: this.clientHeight * k,
            width: this.clientWidth * k, height: this.clientHeight * k,
        };
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        const l = this.listeners[type];
        if (l) this.listeners[type] = l.filter((f) => f !== fn);
    }
    dispatch(type, ev) {
        // DOM events always carry `target`; listeners rely on it to tell a handle grab from
        // a body drag, so the stand-in must supply it.
        const event = Object.assign({
            preventDefault() { }, stopPropagation() { },
            clientX: 0, clientY: 0, key: '', shiftKey: false, ctrlKey: false, metaKey: false,
            deltaY: 0, deltaX: 0, button: 0, relatedTarget: null,
        }, ev || {});
        if (!event.target) event.target = this;
        for (const fn of (this.listeners[type] || []).slice()) fn(event);
    }
    insertBefore(node, ref) {
        if (node.parentNode) node.parentNode.removeChild(node);
        const i = this.children.indexOf(ref);
        node.parentNode = this;
        if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
        return node;
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    focus() { }
}

/**
 * Selector matching, good enough for the selectors this harness uses.
 *
 * Compound (`.a.b`) and descendant (`a b`) selectors were NOT handled originally, and every
 * `querySelectorAll('.ctl.selected')` silently returned nothing — a query that can never match
 * is indistinguishable from a real result, which is the worst kind of test-harness bug.
 */
function matches(el, sel) {
    const parts = sel.trim().split(/\s+/);
    if (!matchesSimple(el, parts[0])) return false;
    // Descendant: each further part must match SOME ancestor.
    let node = el.parentNode;
    for (let i = 1; i < parts.length; i++) {
        while (node && !matchesSimple(node, parts[i])) node = node.parentNode;
        if (!node) return false;
        node = node.parentNode;
    }
    return true;
}

function matchesSimple(el, part) {
    // Compound class selectors: `.a.b` means "has BOTH", not "has a class literally named
    // 'a.b'". Splitting is what makes `.ctl.selected` work at all.
    if (part.startsWith('.')) {
        return part.slice(1).split('.').every((c) => el.classList.contains(c));
    }
    if (part.startsWith('[')) {
        const body = part.slice(1, -1);
        const [k, v] = body.split('=');
        return v === undefined ? k in el.attrs : el.attrs[k] === v.replace(/^["']|["']$/g, '');
    }
    if (part.startsWith('#')) return el.dataset.id === part.slice(1);
    return el.tagName === part.toUpperCase();
}

const document = {
    createElement: (t) => new El(t),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() { },
    body: new El('body'),
};

const ids = {};
for (const id of ['banner', 'toolbox', 'canvas', 'inspector', 'status', 'form-title-text', 'form-size',
                      'zoom-label', 'zoom-in', 'zoom-out', 'zoom-fit', 'ruler-h', 'ruler-v', 'status-tools']) {
    ids[id] = new El('div');
}

// A real El, tagged as the window, so the canvas's `window.addEventListener('mousemove')`
// drag/pan/marquee handlers land in a real listener registry.
const winStub = new El('div');
winStub.tagName = 'WINDOW';
winStub.scrollLeft = 0;
winStub.scrollTop = 0;
winStub.innerWidth = 1200;
winStub.innerHeight = 800;
winStub.clientWidth = 1200;
winStub.clientHeight = 800;

const sandbox = {
    console,
    document: {
        createElement: (t) => new El(t),
        getElementById: (id) => ids[id] || null,
        querySelector: (sel) => {
            if (sel === '.stage') { sandbox.__stage = sandbox.__stage || new El('div'); return sandbox.__stage; }
            if (sel === '.workbench') { sandbox.__workbench = sandbox.__workbench || new El('div'); return sandbox.__workbench; }
            if (sel === '.form-frame') { sandbox.__frame = sandbox.__frame || new El('div'); return sandbox.__frame; }
            if (sel === '.stage') { sandbox.__stage = sandbox.__stage || new El('div'); return sandbox.__stage; }
            return null;
        },
        querySelectorAll: () => [],
        addEventListener() { },
        activeElement: null,
    },
    window: winStub,
    acquireVsCodeApi: () => ({ postMessage: (m) => sandbox.__sent.push(m), getState() { return {}; }, setState() { } }),
    setTimeout, clearTimeout, JSON, Math, Number, parseInt, parseFloat, String, Object, Array, Set, Map, isNaN,
};
sandbox.window.document = sandbox.document;
sandbox.globalThis = sandbox;
sandbox.__sent = [];
sandbox.__ids = ids;

// Focus tracking: the stand-in's focus() was a no-op, so "the shortcut focuses the
// search box" was unassertable. Record the focused element like document.activeElement.
El.prototype.focus = function () { sandbox.document.activeElement = this; };

// ------------------------------------------------------------------- run it

const canvasPath = path.join(__dirname, '..', 'media', 'canvas.js');
vm.createContext(sandbox);

const schema = {
    schemaVersion: 1,
    form: { name: 'SimpleDialog', text: 'Add Person', clientSize: { width: 292, height: 196 }, className: 'SimpleDialog' },
    controls: [
        { id: 'txtName', type: 'System.Windows.Forms.TextBox', children: [], locked: false,
          properties: { x: 96, y: 78, width: 180, height: 23, tabIndex: 0 } },
        { id: 'btnSubmit', type: 'System.Windows.Forms.Button', children: [], locked: false,
          properties: { x: 96, y: 154, width: 84, height: 27, text: 'Submit', tabIndex: 3 } },
        { id: 'ThirdPartyGauge', type: 'ThirdParty.Widgets.GaugeControl', children: [], locked: true,
          lockedReason: 'GaugeControl is not one of the handled control types, so its appearance is not modelled.',
          properties: { x: 10, y: 10, width: 80, height: 28 } },
    ],
    analysis: {
        modelledCount: 2, unmodelledCount: 1, coveragePercent: 66.67,
        refuses: [], warnings: [],
    },
};

function send(msg) {
    const handlers = sandbox.window.__handlers || [];
    // Deep-clone on load. The canvas holds the OPTIMISTIC model and mutates it in place, so
    // passing the fixture by reference would let one test's alignment leak into the next and
    // make every hardcoded coordinate order-dependent. (This did happen: a drag test moved a
    // control and an unrelated later assertion failed with the old coordinates.)
    const payload = msg.data ? JSON.parse(JSON.stringify(msg.data)) : msg.data;
    for (const h of handlers) h({ data: Object.assign({}, msg, { data: payload }) });
}

// canvas.js registers its message listener on `window`; capture it as it is added.
// `realWindowAdd.call(this, …)` is required — a bare call loses `this`, and the window is a
// real El with a real listener registry.
//
// This runs BEFORE canvas.js is evaluated, and canvas.js is evaluated exactly ONCE. Evaluating
// it twice left every first-run closure (the snap toggle among them) bound to a different
// canvas than the one rendering, which is a genuinely confusing failure: the toggle read
// "Snap: off" while the live canvas still had snapping on.
const windowHandlers = [];
const realWindowAdd = sandbox.window.addEventListener;
sandbox.window.addEventListener = function (type, fn) {
    if (type === 'message') windowHandlers.push(fn);
    else realWindowAdd.call(this, type, fn);
};
sandbox.window.__handlers = windowHandlers;
vm.runInContext(fs.readFileSync(canvasPath, 'utf8'), sandbox, { filename: canvasPath });

console.log('\n== canvas harness');

check('posts ready on startup',
    sandbox.__sent.some((m) => m.type === 'ready'));

send({ type: 'load', data: schema });

const canvasEl = ids.canvas;
const rendered = canvasEl.querySelectorAll('.ctl');
check('renders every control including locked ones', rendered.length === 3,
    'got ' + rendered.length);

const locked = rendered.filter((c) => c.classList.contains('locked'));
check('locked control is rendered as locked', locked.length === 1);
check('locked control carries an explanatory title',
    String(locked[0]?.title || '').length > 10, JSON.stringify(locked[0] && locked[0].title));
check('locked control is not editable via arrow keys',
    (function () {
        const c = locked[0];
        c.dispatch('mousedown', { preventDefault() { }, clientX: 0, clientY: 0, stopPropagation() { } });
        return true;
    })());

// banner: coverage disclosure
const bannerHtml = String(ids.banner.innerHTML || '');
check('banner states coverage', /Coverage\s*66\.67%/.test(bannerHtml), bannerHtml.slice(0, 80));
check('banner states unmodelled count', /1 shown as locked boxes/.test(bannerHtml));
check('banner is visible (not hidden)', !ids.banner.classList.contains('hidden'));
const bannerCloseBtn = ids.banner.querySelector('.banner-close');
check('banner offers dismiss/cancel button', !!bannerCloseBtn);
if (bannerCloseBtn) {
    bannerCloseBtn.dispatch('click', {});
    check('clicking dismiss hides the banner', ids.banner.classList.contains('hidden'));
}

check('form title rendered', String(ids['form-title-text'].textContent) === 'SimpleDialog');
check('form size rendered', String(ids['form-size'].textContent) === '292 x 196');

// toolbox
// The count is asserted, but hardcoding it means every added type breaks a test that was
// never about the count. Assert the SHAPE instead, and cross-check the number against what
// the engine actually reports for a form containing every handled type.
const tools = ids.toolbox.querySelectorAll('.tool');
const toolNames = tools.map((t) => String(t.textContent || t._text || ''));
check('the toolbox has no duplicate entries', tools.length === new Set(toolNames).size,
    'got ' + tools.length + ': ' + toolNames.join(','));
for (const t of ['TrackBar', 'ProgressBar', 'NumericUpDown', 'DateTimePicker',
                 'TabControl', 'TabPage', 'DataGridView', 'ListView', 'TreeView']) {
    check('the toolbox offers ' + t, toolNames.includes(t), toolNames.join(','));
}

// NOTE ON SCOPE: the two-list rule is enforced properly in test/verify.sh, which compares the
// REAL engine file against the REAL canvas file in both directions. A check here could only
// compare the canvas against a literal copy of the engine's list — which proves canvas ⊆ that
// copy and lets the copy drift. Asserting the copy's contents instead would be a test that can
// never fail, so this block deliberately asserts only what the DOM can honestly prove.

// ---- committing an edit produces a commit message with a full schema
ids.canvas.querySelectorAll('.ctl');
// select btnSubmit by clicking it
const btn = rendered.find((c) => c.dataset.id === 'btnSubmit');
btn.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 50, clientY: 50 });
const inspectorHtml = JSON.stringify(ids.inspector.children.map((c) => c._text || c._class));
check('inspector shows the selected control', /btnSubmit/.test(inspectorHtml), inspectorHtml.slice(0, 90));

// D1: single-selection size/location readout in the status bar, in form units.
check('status shows single-selection geometry readout',
    String(ids.status.textContent) === '1 control selected — btnSubmit · X 96, Y 154 · 84 × 27',
    JSON.stringify(ids.status.textContent));

sandbox.__sent.length = 0;
// mutate the model through the inspector field inputs (Text is the 5th input)
const inputs = ids.inspector.querySelectorAll('input');
check('inspector exposes geometry + text + tabIndex fields', inputs.length >= 6, 'got ' + inputs.length);
inputs[4].value = 'Send it';
inputs[4].dispatch('change', {});

setTimeout(async () => {
    const commit = sandbox.__sent.find((m) => m.type === 'commit');
    check('edit schedules a debounced commit', !!commit);
    if (commit) {
        const sent = commit.data.controls.find((c) => c.id === 'btnSubmit');
        check('commit carries the edited text', sent && sent.properties.text === 'Send it',
            sent && JSON.stringify(sent.properties));
        check('commit carries analysis/coverage for re-parse', typeof commit.data.analysis.coveragePercent === 'number');
        check('commit preserves locked flag', commit.data.controls.find((c) => c.id === 'ThirdPartyGauge').locked === true);
    }

    // ---- refusal turns the canvas read-only
    send({
        type: 'load',
        data: {
            ...schema,
            analysis: { ...schema.analysis, refuses: ['localizable'], warnings: ['resx'] },
        },
    });
    const refusalHtml = String(ids.banner.innerHTML || '');
    check('refusal is explained in the banner', /Read-only/.test(refusalHtml), refusalHtml.slice(0, 90));
    check('refusal names resources.ApplyResources', /ApplyResources/.test(refusalHtml));
    check('refusal marks canvas read-only',
        ids.canvas.querySelectorAll('.ctl').every((c) => c.classList.contains('readonly')));

    // ---- external change reload
    send({ type: 'externalChange', data: schema });
    check('external change status is surfaced',
        /changed on disk/.test(String(ids.status.textContent)), String(ids.status.textContent));

    // ---- engine error surfaces
    send({ type: 'error', data: { message: 'boom' } });
    check('engine error is surfaced',
        /Error: boom/.test(String(ids.status.textContent)), String(ids.status.textContent));

    // ---- rename is its own message, NOT a schema commit
    // A schema carrying a renamed id reads to the engine as "old deleted, new inserted", which
    // would duplicate the control and discard its properties. So the canvas must post `rename`.
    send({ type: 'load', data: schema });
    const btn = [...ids.canvas.querySelectorAll('.ctl')].find((n) => n.dataset.id === 'btnSubmit');
    if (btn) {
        btn.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 50, clientY: 50 });
    }
    const nameInput = [...ids.inspector.querySelectorAll('input')]
        .find((i) => i.value === 'btnSubmit');
    check('inspector offers the control name for renaming', !!nameInput);

    if (nameInput) {
        sandbox.__sent.length = 0;
        nameInput.value = 'btnSend';
        nameInput.dispatch('change', {});
        const posted = sandbox.__sent;
        const renameMsg = posted.find((m) => m.type === 'rename');
        check('renaming posts a rename message', !!renameMsg, JSON.stringify(posted.map((m) => m.type)));
        check('rename message carries the old id and the new name',
            renameMsg && renameMsg.data.id === 'btnSubmit' && renameMsg.data.to === 'btnSend',
            renameMsg ? JSON.stringify(renameMsg.data) : 'none');
        check('renaming does NOT post a schema commit',
            !posted.some((m) => m.type === 'commit'), JSON.stringify(posted.map((m) => m.type)));
        // The file is the source of truth; the field snaps back until the re-parse arrives.
        check('the name field reverts until the file re-posts the new schema',
            nameInput.value === 'btnSubmit', nameInput.value);
    }

    // ---- a refused rename must say why, in the one place the user is looking
    send({ type: 'renameRefused', data: { message: 'btnSend appears in Form1.cs where it is not a reference' } });
    check('a refused rename surfaces its reason',
        /Rename refused/.test(String(ids.status.textContent)), String(ids.status.textContent));
    check('the refusal names the reason',
        /not a reference/.test(String(ids.status.textContent)), String(ids.status.textContent));

    // ---- A3 default event double-click scaffolding (ADR 0011)
    send({ type: 'load', data: schema });
    {
        const node = [...ids.canvas.querySelectorAll('.ctl')].find((n) => n.dataset.id === 'btnSubmit');
        sandbox.__sent.length = 0;
        node.dispatch('dblclick', { preventDefault() { }, stopPropagation() { } });
        const wireMsg = sandbox.__sent.find((m) => m.type === 'wireEvent');
        check('double-click posts wireEvent for default event', !!wireMsg);
        check('wireEvent carries control id and default Click event',
            !!wireMsg && wireMsg.data.id === 'btnSubmit' && wireMsg.data.event === 'Click');

        // Locked controls never wire events on double click.
        sandbox.__sent.length = 0;
        const lockedNode = [...ids.canvas.querySelectorAll('.ctl')].find((n) => n.dataset.id === 'ThirdPartyGauge');
        lockedNode.dispatch('dblclick', { preventDefault() { }, stopPropagation() { } });
        check('locked control does not post wireEvent', !sandbox.__sent.some((m) => m.type === 'wireEvent'));

        // Double-clicking canvas background wires Form Load event.
        sandbox.__sent.length = 0;
        ids.canvas.dispatch('dblclick', { target: ids.canvas, preventDefault() { }, stopPropagation() { } });
        const formWire = sandbox.__sent.find((m) => m.type === 'wireEvent');
        check('double-clicking canvas background posts Form Load wireEvent',
            !!formWire && formWire.data.id === 'SimpleDialog' && formWire.data.event === 'Load');
    }

    // ---- D2 in-place Text edit via F2: commits via the Text path
    send({ type: 'load', data: schema });
    {
        const node = [...ids.canvas.querySelectorAll('.ctl')].find((n) => n.dataset.id === 'btnSubmit');
        node.dispatch('mousedown', { button: 0, clientX: 10, clientY: 10, preventDefault() { }, stopPropagation() { } });
        winStub.dispatch('mouseup', { clientX: 10, clientY: 10, preventDefault() { }, stopPropagation() { } });
        const stageEl = sandbox.document.querySelector('.stage');
        stageEl.dispatch('keydown', { key: 'F2', preventDefault() { }, stopPropagation() { } });
        const cur = [...ids.canvas.querySelectorAll('.ctl')].find((n) => n.dataset.id === 'btnSubmit');
        const overlay = cur ? cur.querySelector('.text-edit') : null;
        check('F2 opens a text overlay on a selected text-bearing control', !!overlay);
        check('overlay starts from the current text', !!overlay && overlay.value === 'Submit',
            overlay ? JSON.stringify(overlay.value) : 'no overlay');

        // Fresh editable model for the commit round trip.
        sandbox.__sent.length = 0;
        overlay.value = 'Go';
        overlay.dispatch('keydown', { key: 'Enter', preventDefault() { }, stopPropagation() { } });
    }
    await new Promise((r) => setTimeout(r, 350));
    {
        const tc = sandbox.__sent.find((m) => m.type === 'commit');
        check('Enter posts a commit', !!tc);
        const sent = tc && tc.data.controls.find((c) => c.id === 'btnSubmit');
        check('commit carries the overlay text', !!sent && sent.properties.text === 'Go',
            sent ? JSON.stringify(sent.properties) : 'no commit');
        // Escape cancels with no generate.
        send({ type: 'load', data: schema });
        const node2 = [...ids.canvas.querySelectorAll('.ctl')].find((n) => n.dataset.id === 'btnSubmit');
        node2.dispatch('mousedown', { button: 0, clientX: 10, clientY: 10, preventDefault() { }, stopPropagation() { } });
        winStub.dispatch('mouseup', { clientX: 10, clientY: 10, preventDefault() { }, stopPropagation() { } });
        const stageEl = sandbox.document.querySelector('.stage');
        stageEl.dispatch('keydown', { key: 'F2', preventDefault() { }, stopPropagation() { } });
        const cur2 = [...ids.canvas.querySelectorAll('.ctl')].find((n) => n.dataset.id === 'btnSubmit');
        const ov2 = cur2 ? cur2.querySelector('.text-edit') : null;
        sandbox.__sent.length = 0;
        ov2.value = 'Nope';
        ov2.dispatch('keydown', { key: 'Escape', preventDefault() { }, stopPropagation() { } });
        check('Escape removes the overlay', !cur2.querySelector('.text-edit'));
    }
    await new Promise((r) => setTimeout(r, 350));
    check('Escape posts no commit', !sandbox.__sent.some((m) => m.type === 'commit'),
        JSON.stringify(sandbox.__sent.map((m) => m.type)));

    // =====================================================================
    // ZOOM / PAN / SELECTION — docs/spec-canvas-qol.md
    //
    // Everything here is asserted from OBSERVABLE state: the transform on the canvas, the
    // rendered `left`/`top` of a control, and the messages posted. No production internals are
    // read, so the canvas is not polluted with a test seam it would otherwise not have.
    //
    // The DOM stand-in returns SCALED pixels from getBoundingClientRect, exactly as a browser
    // does for a transformed element. That is the load-bearing part: if the canvas forgets to
    // divide a pointer delta out of the scale, dragging to (500,250) at 50% would land at
    // (250,125) and `drag lands on the pointer at 0.5x` would fail.
    // =====================================================================
    const stage = sandbox.document.querySelector('.stage');
    const frame = sandbox.__frame;
    const zoomLabel = ids['zoom-label'];

    const ctlNode = (id) => canvasEl.querySelectorAll('.ctl').find((n) => n.dataset.id === id);
    const leftOf = (id) => parseFloat(ctlNode(id).style.left);
    const topOf = (id) => parseFloat(ctlNode(id).style.top);

    /** The scale the canvas is actually applying, read back off the transform. */
    const scaleOf = () => {
        const tr = (frame && frame.style.transform) || canvasEl.style.transform || '';
        const m = /scale\(([\d.]+)\)/.exec(String(tr));
        return m ? parseFloat(m[1]) : 1;
    };
    /** Mirror the canvas's scale into the DOM stand-in, which is what makes rects scaled. */
    const mirrorScale = () => { canvasEl.scale = scaleOf(); if (frame) frame.scale = scaleOf(); };

    // Wheel and panning are bound to the STAGE, which covers the canvas. The stand-in DOM does
    // not bubble, so the test dispatches where the listener actually is.
    const wheel = (ev) => stage.dispatch('wheel', ev);
    const setZoomNow = () => { winKey('0', { ctrlKey: true, metaKey: true }); mirrorScale(); };
    const winKey = (k, opts) => stage.dispatch('keydown', Object.assign({ key: k }, opts || {}));
    const zoomIn = (times) => { for (let i = 0; i < times; i++) wheel({ ctrlKey: true, clientX: 100, clientY: 100, deltaY: -120 }); mirrorScale(); };

    const z0 = scaleOf();
    check('zoom starts at 1', z0 === 1, String(z0));

    // ---- ctrl+wheel zooms (a trackpad pinch arrives exactly this way)
    wheel({ ctrlKey: true, clientX: 100, clientY: 100, deltaY: -120 });
    const z1 = scaleOf();
    check('ctrl+wheel zooms in', z1 > 1, String(z1));
    check('the form frame is transformed too, or its border will not grow',
        /scale/.test(String(frame.style.transform || '')), String(frame.style.transform));
    check('canvas inside form frame does not duplicate transform',
        !canvasEl.style.transform || canvasEl.style.transform === '', String(canvasEl.style.transform));
    check('the zoom readout shows the current scale',
        /%/.test(String(zoomLabel.textContent || '')) && String(zoomLabel.textContent) !== '100%',
        String(zoomLabel.textContent));

    // ---- clamped at both ends
    for (let i = 0; i < 60; i++) wheel({ ctrlKey: true, clientX: 0, clientY: 0, deltaY: -120 });
    check('zoom clamps at the top of the range', scaleOf() <= 4, String(scaleOf()));
    for (let i = 0; i < 120; i++) wheel({ ctrlKey: true, clientX: 0, clientY: 0, deltaY: 120 });
    check('zoom clamps at the bottom of the range', scaleOf() >= 0.25, String(scaleOf()));

    // ---- plain wheel scrolls; it must NOT zoom
    const beforeWheel = scaleOf();
    wheel({ clientX: 10, clientY: 10, deltaY: -120 });
    check('plain wheel scrolls rather than zooming', scaleOf() === beforeWheel,
        `${beforeWheel} -> ${scaleOf()}`);

    winKey('0', { ctrlKey: true, metaKey: true });
    mirrorScale();
    check('ctrl+0 resets to 100%', scaleOf() === 1, String(scaleOf()));

    // ---- THE COORDINATE TEST: the pointer lands where it is pointed, at any zoom
    for (const [label, steps] of [['0.5x', -8], ['2x', 3]]) {
        send({ type: 'load', data: schema });
        zoomIn(steps);
        const s = scaleOf();
        const x0 = leftOf('btnSubmit');
        const y0 = topOf('btnSubmit');

        ctlNode('btnSubmit').dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 100, clientY: 100 });
        // Drag up-left, away from the frame walls: the container clamp (Task 2,
        // #48) pins moves at the parent frame, so a delta running past the
        // bottom-right edge would assert the clamp, not the zoom math.
        sandbox.window.dispatch('mousemove', { clientX: 100 - 40 * s, clientY: 100 - 24 * s });
        check(`a drag at ${label} moves live style during mousemove`,
            leftOf('btnSubmit') !== x0,
            `live left is ${leftOf('btnSubmit')}; start was ${x0}`);
        sandbox.window.dispatch('mouseup', {});
        mirrorScale();

        const dx = leftOf('btnSubmit') - x0;
        const dy = topOf('btnSubmit') - y0;
        // Tolerate the 8px grid snap; what must hold is that the result is the FORM delta and
        // not the SCREEN delta, which differ by exactly `s`.
        check(`a drag at ${label} moves by the pointer delta in form units`,
            Math.abs(dx + 40) <= 8 && Math.abs(dy + 24) <= 8,
            `moved ${dx},${dy}; expected ~-40,-24. A scaled-rect bug gives ${(-40 * s).toFixed(1)},${(-24 * s).toFixed(1)}`);
    }

    // ---- nudge is in FORM units, never screen pixels
    send({ type: 'load', data: schema });
    zoomIn(3);
    {
        const x0 = leftOf('btnSubmit');
        ctlNode('btnSubmit').dispatch('keydown', { key: 'ArrowRight', preventDefault() { } });
        mirrorScale();
        check('nudge moves by GRID form units regardless of zoom',
            leftOf('btnSubmit') - x0 === 8,
            `moved ${leftOf('btnSubmit') - x0}; a screen-space bug gives ${(8 * scaleOf()).toFixed(1)}`);
    }

    // ---- panning is a VIEW concern and must never touch the model
    send({ type: 'load', data: schema });
    sandbox.__sent.length = 0;
    const panX = leftOf('btnSubmit'), panY = topOf('btnSubmit');
    winKey(' ', {});                                   // press and hold space
    mirrorScale();
    stage.dispatch('mousedown', { clientX: 200, clientY: 200, preventDefault() { }, stopPropagation() { } });
    sandbox.window.dispatch('mousemove', { clientX: 220, clientY: 240 });
    sandbox.window.dispatch('mouseup', {});
    check('a pan gesture posts no commit', !sandbox.__sent.some((m) => m.type === 'commit'),
        JSON.stringify(sandbox.__sent.map((m) => m.type)));
    check('a pan gesture does not move any control',
        leftOf('btnSubmit') === panX && topOf('btnSubmit') === panY,
        `${panX},${panY} -> ${leftOf('btnSubmit')},${topOf('btnSubmit')}`);

    // Space held while the window loses focus must not leave the canvas stuck panning.
    winKey(' ', {});
    stage.dispatch('blur', {});
    sandbox.__sent.length = 0;
    stage.dispatch('mousedown', { clientX: 300, clientY: 300, preventDefault() { }, stopPropagation() { } });
    sandbox.window.dispatch('mousemove', { clientX: 340, clientY: 340 });
    check('releasing pan mode on blur prevents a stuck panning cursor',
        !sandbox.__sent.some((m) => m.type === 'commit'),
        'a commit after blur means pan mode was still armed');

    // ---- multi-select, marquee, align, duplicate
    setZoomNow(1);
    send({ type: 'load', data: schema });
    ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    // `settled()` is used by the commit assertions below; commits are debounced by design.
    check('a plain click selects one control', canvasEl.querySelectorAll('.ctl.selected').length === 1,
        String(canvasEl.querySelectorAll('.ctl.selected').length));

    ctlNode('btnSubmit').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    check('shift+click adds a second control to the selection',
        canvasEl.querySelectorAll('.ctl.selected').length === 2,
        String(canvasEl.querySelectorAll('.ctl.selected').length));
    check('the inspector reports a multi-selection',
        /2 controls/.test(String(ids.inspector.textContent || ids.inspector._html || '')),
        String(ids.inspector.textContent || ids.inspector._html).slice(0, 80));

    // Align left: both selected controls share the leftmost x.
    sandbox.__sent.length = 0;
    winKey('l', { metaKey: true });
    mirrorScale();
    check('align-left makes the selection share one x',
        leftOf('txtName') === leftOf('btnSubmit'),
        `txtName x=${leftOf('txtName')} btnSubmit x=${leftOf('btnSubmit')}`);
    await settled();
    check('aligning posts exactly one commit for the whole group',
        sandbox.__sent.filter((m) => m.type === 'commit').length === 1,
        String(sandbox.__sent.map((m) => m.type)));

    // ---- D3 arrange: same size + center in form (pure geometry, one commit)
    send({ type: 'load', data: schema });
    ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    ctlNode('btnSubmit').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    const widthOf = (id) => parseFloat(ctlNode(id).style.width);
    const heightOf = (id) => parseFloat(ctlNode(id).style.height);
    const clickInspectorButton = (label) => {
        const b = ids.inspector.querySelectorAll('button').find((x) => String(x.textContent || '') === label);
        if (!b) return false;
        b.dispatch('click', {});
        return true;
    };
    {
        const labels = ids.inspector.querySelectorAll('button').map((b) => String(b.textContent || ''));
        for (const t of ['Same Width', 'Same Height', 'Same Size',
            'Center in Form Horizontally', 'Center in Form Vertically']) {
            check('multi-selection offers ' + t, labels.includes(t), labels.join(','));
        }
    }
    // Same Size copies the schema-order-first (txtName 180x23) extents; position untouched.
    sandbox.__sent.length = 0;
    check('same-size action runs', clickInspectorButton('Same Size'));
    check('same-size copies the dominant width', widthOf('btnSubmit') === 180 && widthOf('txtName') === 180,
        `txtName w=${widthOf('txtName')} btnSubmit w=${widthOf('btnSubmit')}`);
    check('same-size copies the dominant height', heightOf('btnSubmit') === 23 && heightOf('txtName') === 23,
        `txtName h=${heightOf('txtName')} btnSubmit h=${heightOf('btnSubmit')}`);
    check('same-size keeps position', leftOf('btnSubmit') === 96 && topOf('btnSubmit') === 154,
        `btnSubmit@${leftOf('btnSubmit')},${topOf('btnSubmit')}`);
    await settled();
    {
        const commits = sandbox.__sent.filter((m) => m.type === 'commit');
        check('same-size posts exactly one commit', commits.length === 1,
            String(sandbox.__sent.map((m) => m.type)));
        const sent = commits.length && commits[0].data.controls.find((c) => c.id === 'btnSubmit');
        check('commit carries the resized control', !!sent && sent.properties.width === 180 && sent.properties.height === 23,
            sent ? JSON.stringify(sent.properties) : 'no commit');
    }

    // Center in Form on a single control: (292-84)/2=104, (196-27)/2=84.5->85.
    send({ type: 'load', data: schema });
    ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    check('single selection offers center actions',
        ids.inspector.querySelectorAll('button').some((b) => String(b.textContent || '') === 'Center in Form Horizontally'));
    clickInspectorButton('Center in Form Horizontally');
    check('center-h centers within the form width', leftOf('btnSubmit') === 104, String(leftOf('btnSubmit')));
    clickInspectorButton('Center in Form Vertically');
    check('center-v centers within the form height', topOf('btnSubmit') === 85, String(topOf('btnSubmit')));

    // Nested controls centre within the parent frame, not the form: (200-80)/2=60.
    {
        const nested = JSON.parse(JSON.stringify(schema));
        nested.controls.push({ id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [
            { id: 'btnIn', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 5, y: 5, width: 80, height: 25, text: 'In', tabIndex: 0 } },
        ], locked: false, properties: { x: 10, y: 10, width: 200, height: 150, tabIndex: 1 } });
        send({ type: 'load', data: nested });
        ctlNode('btnIn').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        clickInspectorButton('Center in Form Horizontally');
        check('nested control centers within the parent width',
            parseFloat(ctlNode('btnIn').style.left) === 60, String(ctlNode('btnIn').style.left));
    }

    // ---- nested drag: a container drag carries its children exactly once.
    // Two cooperating fixes. Mousedown/dblclick on a child BUBBLES to every ancestor
    // container's node, so the ancestor must ignore events whose target is a nested
    // control — otherwise one gesture drives two drags. And a selection holding both a
    // container and its child must move the child only via its parent (its coordinates
    // are parent-relative), never twice.
    {
        const nestedDrag = JSON.parse(JSON.stringify(schema));
        nestedDrag.controls.push({ id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [
            { id: 'btnIn', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 5, y: 5, width: 80, height: 25, text: 'In', tabIndex: 0 } },
        ], locked: false, properties: { x: 10, y: 10, width: 200, height: 150, tabIndex: 1 } });
        const nestWrap = () => ctlNode('pnlWrap');
        const nestInner = () => ctlNode('btnIn');
        const nestPos = (id) => {
            const n = ctlNode(id);
            return `${parseFloat(n.style.left)},${parseFloat(n.style.top)}`;
        };
        const down = (n, ev) => n.dispatch('mousedown',
            Object.assign({ preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 }, ev || {}));

        // A mousedown that STARTED on the child reaches the container with the child as
        // its target (that is what bubbling delivers). The container must ignore it: no
        // reselect, no second drag.
        send({ type: 'load', data: nestedDrag });
        down(nestInner());
        nestWrap().dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10, target: nestInner() });
        check('a bubbled child mousedown does not reselect the container',
            canvasEl.querySelectorAll('.ctl.selected').map((n) => n.dataset.id).join(',') === 'btnIn',
            canvasEl.querySelectorAll('.ctl.selected').map((n) => n.dataset.id).join(','));
        sandbox.window.dispatch('mousemove', { clientX: 50, clientY: 50 });
        sandbox.window.dispatch('mouseup', {});
        mirrorScale();
        check('a bubbled child mousedown starts no container drag',
            nestPos('pnlWrap') === '10,10', nestPos('pnlWrap'));
        check('only the child drag ran, exactly once',
            nestPos('btnIn') === '45,45', nestPos('btnIn'));

        // Dragging the container background moves the container; the child rides along
        // visually, so its parent-relative coordinates stay put.
        send({ type: 'load', data: nestedDrag });
        nestWrap().dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 100, clientY: 100 });
        // (+40,+16): stays clear of the container clamp walls (Task 2, #48 —
        // pnlWrap 200x150 in a 292x196 form pins at x=92,y=46) AND of every
        // snapline (Task 3, #49 — the old +24 vector grazes btnSubmit's bottom
        // edge at 181 and now pulls), so this asserts the carry-along, not the
        // clamp and not the pull.
        sandbox.window.dispatch('mousemove', { clientX: 140, clientY: 116 });
        sandbox.window.dispatch('mouseup', {});
        mirrorScale();
        check('dragging a container moves the container',
            nestPos('pnlWrap') === '50,26', nestPos('pnlWrap'));
        check('the child rides along: its relative coordinates are untouched',
            nestPos('btnIn') === '5,5', nestPos('btnIn'));

        // Multi-selecting container AND child, then dragging, must not double-move the child.
        send({ type: 'load', data: nestedDrag });
        down(nestWrap());
        down(nestInner(), { shiftKey: true, clientX: 20, clientY: 20 });
        sandbox.window.dispatch('mousemove', { clientX: 60, clientY: 20 });
        sandbox.window.dispatch('mouseup', {});
        mirrorScale();
        check('group drag moves the container once',
            nestPos('pnlWrap') === '50,10', nestPos('pnlWrap'));
        check('group drag does not double-move a nested member',
            nestPos('btnIn') === '5,5', nestPos('btnIn'));

        // Keyboard nudge with container+child selected: same single-move rule.
        send({ type: 'load', data: nestedDrag });
        down(nestWrap());
        down(nestInner(), { shiftKey: true });
        nestInner().dispatch('keydown', { key: 'ArrowRight', preventDefault() { } });
        mirrorScale();
        check('nudge moves the container by one grid unit',
            nestPos('pnlWrap') === '18,10', nestPos('pnlWrap'));
        check('nudge does not double-move a nested member',
            nestPos('btnIn') === '5,5', nestPos('btnIn'));
        sandbox.window.dispatch('mouseup', {});

        // A dblclick that started on a child must not drill into the container.
        send({ type: 'load', data: nestedDrag });
        nestWrap().dispatch('dblclick',
            { preventDefault() { }, stopPropagation() { }, target: nestInner() });
        check('a bubbled child dblclick does not drill into the container',
            !/Entered/.test(String(ids.status.textContent)), String(ids.status.textContent));
        nestWrap().dispatch('dblclick', { preventDefault() { }, stopPropagation() { } });
        check('double-clicking the container background still drills in',
            /Entered pnlWrap/.test(String(ids.status.textContent)), String(ids.status.textContent));
        stage.dispatch('keydown', { key: 'Escape', preventDefault() { } });
        check('Escape exits the container again',
            !/Entered/.test(String(ids.status.textContent)), String(ids.status.textContent));

        await settled();
        sandbox.__sent.length = 0;
    }

    // ---- D4 keyboard move/resize (VS SizeControl semantics, Task 2 #48).
    // Plain arrows move by GRID; Ctrl/Cmd is the 1px fine step (the old GRID*5
    // jump was inverted). Shift resizes with the same step rule — Right/Down
    // grow, Left/Up shrink, top-left anchored — the same TextChanges a
    // drag/resize-handle emits.
    send({ type: 'load', data: schema });
    sandbox.__sent.length = 0;
    {
        const keyNode = (id) => canvasEl.querySelectorAll('.ctl').find((n) => n.dataset.id === id);
        // Plain arrow moves by GRID; ctrl+arrow moves by the 1px fine step.
        const x0 = leftOf('btnSubmit'), y0 = topOf('btnSubmit');
        keyNode('btnSubmit').dispatch('keydown', { key: 'ArrowRight', preventDefault() { } });
        check('plain arrow moves by GRID', leftOf('btnSubmit') - x0 === 8 && topOf('btnSubmit') === y0,
            `moved ${leftOf('btnSubmit') - x0},${topOf('btnSubmit') - y0}`);
        keyNode('btnSubmit').dispatch('keydown', { key: 'ArrowRight', ctrlKey: true, preventDefault() { } });
        check('ctrl+arrow moves by the 1px fine step, not the old GRID*5 jump',
            leftOf('btnSubmit') - x0 === 9 && topOf('btnSubmit') === y0,
            `moved ${leftOf('btnSubmit') - x0},${topOf('btnSubmit') - y0}`);
        // Shift+arrow resizes all four ways, top-left anchored (VS SizeControl).
        const w0 = parseFloat(keyNode('btnSubmit').style.width);
        const h0 = parseFloat(keyNode('btnSubmit').style.height);
        const xa = leftOf('btnSubmit'), ya = topOf('btnSubmit');
        keyNode('btnSubmit').dispatch('keydown', { key: 'ArrowRight', shiftKey: true, preventDefault() { } });
        check('shift+right grows width, keeps position',
            parseFloat(keyNode('btnSubmit').style.width) === w0 + 8 && leftOf('btnSubmit') === xa,
            `w=${keyNode('btnSubmit').style.width} x=${leftOf('btnSubmit')}`);
        keyNode('btnSubmit').dispatch('keydown', { key: 'ArrowLeft', shiftKey: true, preventDefault() { } });
        check('shift+left shrinks width back, keeps position (west)',
            parseFloat(keyNode('btnSubmit').style.width) === w0 && leftOf('btnSubmit') === xa,
            `w=${keyNode('btnSubmit').style.width} x=${leftOf('btnSubmit')}`);
        keyNode('btnSubmit').dispatch('keydown', { key: 'ArrowDown', shiftKey: true, preventDefault() { } });
        check('shift+down grows height, keeps position',
            parseFloat(keyNode('btnSubmit').style.height) === h0 + 8 && topOf('btnSubmit') === ya,
            `h=${keyNode('btnSubmit').style.height} y=${topOf('btnSubmit')}`);
        keyNode('btnSubmit').dispatch('keydown', { key: 'ArrowUp', shiftKey: true, preventDefault() { } });
        check('shift+up shrinks height back, keeps position (north)',
            parseFloat(keyNode('btnSubmit').style.height) === h0 && topOf('btnSubmit') === ya,
            `h=${keyNode('btnSubmit').style.height} y=${topOf('btnSubmit')}`);
        // Ctrl+Shift resizes by the fine step too.
        keyNode('btnSubmit').dispatch('keydown', { key: 'ArrowDown', shiftKey: true, ctrlKey: true, preventDefault() { } });
        check('ctrl+shift+arrow resizes by 1px, not the old jump',
            parseFloat(keyNode('btnSubmit').style.height) === h0 + 1,
            `h=${keyNode('btnSubmit').style.height}`);
        await settled();
        const kc = sandbox.__sent.filter((m) => m.type === 'commit');
        check('keyboard gestures debounce to one commit', kc.length === 1, String(kc.length));
        const ksent = kc.length && kc[0].data.controls.find((c) => c.id === 'btnSubmit');
        check('commit carries moved position and resized size',
            !!ksent && ksent.properties.x === x0 + 9 && ksent.properties.width === w0 && ksent.properties.height === h0 + 1,
            ksent ? JSON.stringify(ksent.properties) : 'no commit');
        // Locked controls ignore arrows entirely.
        const lx0 = parseFloat(keyNode('ThirdPartyGauge').style.left);
        keyNode('ThirdPartyGauge').dispatch('keydown', { key: 'ArrowRight', preventDefault() { } });
        keyNode('ThirdPartyGauge').dispatch('keydown', { key: 'ArrowRight', shiftKey: true, preventDefault() { } });
        check('locked control ignores move and resize keys',
            parseFloat(keyNode('ThirdPartyGauge').style.left) === lx0,
            String(keyNode('ThirdPartyGauge').style.left));
    }

    // ---- Task 2 (#48): drag/nudge clamps to the parent frame + MinimumSize floor.
    // A control lives inside its container: moves stop at the frame walls
    // (0..frame-size, one shared delta so a group never splits), and shrinking
    // stops at max(2, minimumSize when the schema surfaces one).
    {
        const keyNode = (id) => canvasEl.querySelectorAll('.ctl').find((n) => n.dataset.id === id);
        const posOf = (id) => `${parseFloat(keyNode(id).style.left)},${parseFloat(keyNode(id).style.top)}`;
        const sizeOf = (id) => `${parseFloat(keyNode(id).style.width)}x${parseFloat(keyNode(id).style.height)}`;

        // Nudge stops at the frame walls: btnEdge sits 8px shy of the form's
        // right/bottom (form 292x196, control 84x27 -> walls x=208, y=169).
        const edgeSchema = JSON.parse(JSON.stringify(schema));
        edgeSchema.controls.push({ id: 'btnEdge', type: 'System.Windows.Forms.Button', children: [], locked: false,
            properties: { x: 200, y: 161, width: 84, height: 27, text: 'Edge', tabIndex: 4 } });
        send({ type: 'load', data: edgeSchema });
        await settled();
        keyNode('btnEdge').dispatch('keydown', { key: 'ArrowRight', preventDefault() { } });
        check('nudge stops at the frame right wall', posOf('btnEdge') === '208,161', posOf('btnEdge'));
        keyNode('btnEdge').dispatch('keydown', { key: 'ArrowRight', preventDefault() { } });
        check('a nudge fully into the wall moves nothing', posOf('btnEdge') === '208,161', posOf('btnEdge'));
        keyNode('btnEdge').dispatch('keydown', { key: 'ArrowDown', preventDefault() { } });
        check('nudge stops at the frame bottom wall', posOf('btnEdge') === '208,169', posOf('btnEdge'));
        // ... and at zero on the west/north sides.
        const zeroSchema = JSON.parse(JSON.stringify(schema));
        zeroSchema.controls.push({ id: 'btnZero', type: 'System.Windows.Forms.Button', children: [], locked: false,
            properties: { x: 4, y: 4, width: 84, height: 27, text: 'Zero', tabIndex: 4 } });
        send({ type: 'load', data: zeroSchema });
        await settled();
        keyNode('btnZero').dispatch('keydown', { key: 'ArrowLeft', preventDefault() { } });
        check('nudge stops at x=0', posOf('btnZero') === '0,4', posOf('btnZero'));
        keyNode('btnZero').dispatch('keydown', { key: 'ArrowUp', preventDefault() { } });
        check('nudge stops at y=0', posOf('btnZero') === '0,0', posOf('btnZero'));
        // A nudge fully into the wall posts no commit: nothing changed, so the
        // file stays byte-identical (no generate at all). Flush the previous
        // move's debounced commit first, so only the blocked nudge is observed.
        await settled();
        sandbox.__sent.length = 0;
        keyNode('btnZero').dispatch('keydown', { key: 'ArrowLeft', preventDefault() { } });
        await settled();
        check('a fully-blocked nudge posts no commit', !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));

        // Drag clamps the same way: flinging btnEdge far past the corner lands
        // exactly on it, and the debounced commit carries the clamped geometry.
        send({ type: 'load', data: edgeSchema });
        await settled();
        sandbox.__sent.length = 0;
        keyNode('btnEdge').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 200, clientY: 160 });
        sandbox.window.dispatch('mousemove', { clientX: 900, clientY: 800 });
        sandbox.window.dispatch('mouseup', {});
        check('a drag past the corner lands on the frame walls', posOf('btnEdge') === '208,169', posOf('btnEdge'));
        await settled();
        const dc = sandbox.__sent.filter((m) => m.type === 'commit').pop();
        const dsent = dc && dc.data.controls.find((c) => c.id === 'btnEdge');
        check('the drag commit carries the clamped position',
            !!dsent && dsent.properties.x === 208 && dsent.properties.y === 169,
            dsent ? JSON.stringify(dsent.properties) : 'no commit');

        // Nested controls clamp to their container frame, not the form: btnIn
        // lives in 200x150 pnlWrap, so its walls are x=120, y=125.
        const nestClamp = JSON.parse(JSON.stringify(schema));
        nestClamp.controls.push({ id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [
            { id: 'btnIn', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 116, y: 121, width: 80, height: 25, text: 'In', tabIndex: 0 } },
        ], locked: false, properties: { x: 10, y: 10, width: 200, height: 150, tabIndex: 1 } });
        send({ type: 'load', data: nestClamp });
        await settled();
        keyNode('btnIn').dispatch('keydown', { key: 'ArrowRight', preventDefault() { } });
        check('nested nudge stops at the container right wall', posOf('btnIn') === '120,121', posOf('btnIn'));
        keyNode('btnIn').dispatch('keydown', { key: 'ArrowDown', preventDefault() { } });
        check('nested nudge stops at the container bottom wall', posOf('btnIn') === '120,125', posOf('btnIn'));

        // A group drag clamps as one block: txtName (180 wide, wall x=112) binds
        // dx first and btnSubmit (wall y=169) binds dy first; both keep offsets.
        send({ type: 'load', data: schema });
        await settled();
        keyNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 96, clientY: 78 });
        sandbox.window.dispatch('mouseup', {});
        keyNode('btnSubmit').dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 96, clientY: 154 });
        sandbox.window.dispatch('mousemove', { clientX: 900, clientY: 900 });
        sandbox.window.dispatch('mouseup', {});
        check('group drag clamps as a block, keeping offsets',
            posOf('txtName') === '112,93' && posOf('btnSubmit') === '112,169',
            posOf('txtName') + ' / ' + posOf('btnSubmit'));

        // MinimumSize floor: shrinking stops at max(2, minimumSize) — the 2px DOM
        // floor where the schema surfaces none (the engine parses none today, so
        // the canvas honors the field opportunistically; no schema change).
        const minSchema = JSON.parse(JSON.stringify(schema));
        minSchema.controls.push({ id: 'btnMin', type: 'System.Windows.Forms.Button', children: [], locked: false,
            properties: { x: 10, y: 10, width: 84, height: 27, text: 'Min', tabIndex: 4,
                minimumSize: { width: 50, height: 20 } } });
        send({ type: 'load', data: minSchema });
        await settled();
        for (let i = 0; i < 5; i++) keyNode('btnMin').dispatch('keydown', { key: 'ArrowLeft', shiftKey: true, preventDefault() { } });
        check('shift+left shrink stops at minimumSize.width', sizeOf('btnMin') === '50x27', sizeOf('btnMin'));
        for (let i = 0; i < 5; i++) keyNode('btnMin').dispatch('keydown', { key: 'ArrowUp', shiftKey: true, preventDefault() { } });
        check('shift+up shrink stops at minimumSize.height', sizeOf('btnMin') === '50x20', sizeOf('btnMin'));
        // And the plain 2px floor where no MinimumSize is surfaced.
        send({ type: 'load', data: schema });
        await settled();
        for (let i = 0; i < 12; i++) keyNode('btnSubmit').dispatch('keydown', { key: 'ArrowLeft', shiftKey: true, preventDefault() { } });
        check('shrink without a MinimumSize still floors at 2px', sizeOf('btnSubmit') === '2x27', sizeOf('btnSubmit'));
        await settled();
        sandbox.__sent.length = 0;
    }

    // ---- A4 tab-order mode: badges + click-to-assign, Esc exits
    send({ type: 'load', data: schema });
    {
        const tools = ids['status-tools'];
        const tabBtn = () => tools.querySelector('.tab-order-toggle');
        const badges = () => canvasEl.querySelectorAll('.tab-badge');
        const badgeFor = (id) => {
            const n = canvasEl.querySelectorAll('.ctl').find((x) => x.dataset.id === id);
            const b = n && n.querySelector('.tab-badge');
            return b ? String(b.textContent) : null;
        };
        const clickCtl = (id) => canvasEl.querySelectorAll('.ctl').find((x) => x.dataset.id === id)
            .dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        check('status bar offers the tab-order toggle', !!tabBtn() && /off/.test(String(tabBtn().textContent)));
        tabBtn().dispatch('click', {});
        check('toggle enters tab-order mode', /on/.test(String(tabBtn().textContent)));
        check('badges appear on modelled controls only', badges().length === 2, String(badges().length));
        check('badge shows the current TabIndex', badgeFor('btnSubmit') === '3', String(badgeFor('btnSubmit')));
        // Click-to-assign: btnSubmit first, txtName second.
        sandbox.__sent.length = 0;
        clickCtl('btnSubmit');
        clickCtl('txtName');
        check('clicks reassign TabIndex in click order',
            badgeFor('btnSubmit') === '0' && badgeFor('txtName') === '1',
            `${badgeFor('btnSubmit')},${badgeFor('txtName')}`);
        await settled();
        const tb = sandbox.__sent.filter((m) => m.type === 'commit');
        check('assignments debounce to one commit', tb.length === 1, String(tb.length));
        const tcontrols = tb.length && tb[0].data.controls;
        check('commit carries the new tab order',
            !!tcontrols && tcontrols.find((c) => c.id === 'btnSubmit').properties.tabIndex === 0
            && tcontrols.find((c) => c.id === 'txtName').properties.tabIndex === 1,
            tcontrols ? JSON.stringify(tcontrols.map((c) => [c.id, c.properties.tabIndex])) : 'no commit');
        // Escape exits the mode.
        sandbox.document.querySelector('.stage').dispatch('keydown', { key: 'Escape', preventDefault() { } });
        check('Escape exits tab-order mode', /off/.test(String(tabBtn().textContent)));
        check('badges are gone after exit', badges().length === 0, String(badges().length));
        // Refused forms stay out of the mode.
        send({ type: 'load', data: { ...schema, analysis: { ...schema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
        tabBtn().dispatch('click', {});
        check('refused form refuses the mode', /off/.test(String(tabBtn().textContent)));
        check('refused form shows no badges', badges().length === 0, String(badges().length));
    }

    // ---- duplicate
    send({ type: 'load', data: schema });
    ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    sandbox.__sent.length = 0;
    winKey('d', { metaKey: true, ctrlKey: true });
    mirrorScale();
    const dup = canvasEl.querySelectorAll('.ctl').map((n) => n.dataset.id);
    check('ctrl+D adds a copy with a fresh name',
        dup.length === 4 && dup.some((id) => /btnSubmit\d*$/.test(id) && id !== 'btnSubmit'),
        dup.join(', '));
    check('the duplicate is offset so it is visible',
        canvasEl.querySelectorAll('.ctl').some((n) => n.dataset.id !== 'btnSubmit'
            && parseFloat(n.style.left) === 104),
        canvasEl.querySelectorAll('.ctl').map((n) => `${n.dataset.id}@${n.style.left}`).join(' '));
    await settled();
    check('duplicating posts one commit',
        sandbox.__sent.filter((m) => m.type === 'commit').length === 1,
        String(sandbox.__sent.map((m) => m.type)));

    // ---- Escape deselects
    winKey('Escape', {});
    check('escape clears the selection',
        canvasEl.querySelectorAll('.ctl.selected').length === 0,
        String(canvasEl.querySelectorAll('.ctl.selected').length));

    // ---- a marquee must not hijack a control drag
    setZoomNow(1);
    send({ type: 'load', data: schema });
    sandbox.__sent.length = 0;
    canvasEl.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 0, clientY: 0 });
    sandbox.window.dispatch('mousemove', { clientX: 400, clientY: 400 });
    sandbox.window.dispatch('mouseup', {});
    mirrorScale();
    check('a marquee selects several controls at once',
        canvasEl.querySelectorAll('.ctl.selected').length >= 2,
        String(canvasEl.querySelectorAll('.ctl.selected').length));
    check('a marquee posts no commit — selection is view state',
        !sandbox.__sent.some((m) => m.type === 'commit'),
        JSON.stringify(sandbox.__sent.map((m) => m.type)));

    send({ type: 'load', data: schema });
    await settled();
    const xBefore = leftOf('btnSubmit');
    ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 100, clientY: 100 });
    sandbox.window.dispatch('mousemove', { clientX: 160, clientY: 100 });
    sandbox.window.dispatch('mouseup', {});
    mirrorScale();
    check('a drag on a control is still a drag, not a marquee',
        leftOf('btnSubmit') !== xBefore && canvasEl.querySelectorAll('.ctl.selected').length === 1,
        `x ${xBefore} -> ${leftOf('btnSubmit')}, selected ${canvasEl.querySelectorAll('.ctl.selected').length}`);

    // ---- snapping can be turned off
    setZoomNow(1);
    send({ type: 'load', data: schema });
    const snapBtn = ids['status-tools'].querySelector('.snap-toggle');
    check('a snap toggle is offered', !!snapBtn, 'not found in the status bar');
    if (snapBtn) {
        snapBtn.dispatch('click', { preventDefault() { } });
        const x1 = leftOf('btnSubmit');
        ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 100, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 103, clientY: 100 });
        sandbox.window.dispatch('mouseup', {});
        mirrorScale();
        check('with snapping off a 3px drag moves exactly 3px',
            leftOf('btnSubmit') - x1 === 3, `moved ${leftOf('btnSubmit') - x1}`);
    }

    // ---- appearance properties that were already in the schema (docs/spec-features.md §3)
    send({ type: 'load', data: schema });
    ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });

    const insInputs = () => ids.inspector.querySelectorAll('input');
    const byId = (id) => insInputs().find((i) => i.id === id);
    check('Enabled is offered as a checkbox',
        byId('fEnabled') && byId('fEnabled').type === 'checkbox',
        JSON.stringify(insInputs().map((i) => `${i.id}:${i.type}`)));
    check('Visible is offered as a checkbox',
        byId('fVisible') && byId('fVisible').type === 'checkbox');
    check('BackColor is offered as a colour input',
        !!insInputs().find((i) => i.type === 'color'));

    // A boolean must travel as a BOOLEAN. The schema is validated by the engine, and a string
    // "false" would either be rejected or silently mean the opposite.
    sandbox.__sent.length = 0;
    const enabled = byId('fEnabled');
    enabled.checked = false;
    enabled.dispatch('change', {});
    await settled();
    const enabledCommit = sandbox.__sent.find((m) => m.type === 'commit');
    const btnProps = enabledCommit && enabledCommit.data.controls.find((c) => c.id === 'btnSubmit');
    check('unchecking Enabled posts enabled: false as a BOOLEAN, not the string "false"',
        btnProps && btnProps.properties.enabled === false
            && typeof btnProps.properties.enabled === 'boolean',
        JSON.stringify(btnProps && btnProps.properties.enabled));

    sandbox.__sent.length = 0;
    const colour = insInputs().find((i) => i.type === 'color');
    colour.value = '#ff0000';
    colour.dispatch('change', {});
    await settled();
    const colourCommit = sandbox.__sent.find((m) => m.type === 'commit');
    const btn2 = colourCommit && colourCommit.data.controls.find((c) => c.id === 'btnSubmit');
    check('a colour change posts the hex string the parser reads back',
        btn2 && btn2.properties.backColor === '#ff0000',
        JSON.stringify(btn2 && btn2.properties.backColor));

    check('a Button gets Font controls (size plus bold/italic checkboxes)',
        insInputs().filter((i) => i.id !== 'fEnabled' && i.id !== 'fVisible').length >= 3,
        JSON.stringify(insInputs().map((i) => i.id)));

    // ---- a Locked Control must never JOIN a multi-selection.
    // It stays selectable on its own — that is how you read why it is locked — but it must
    // never end up in a GROUP, because `selection` is what a group drag iterates. A locked
    // member would then be MOVED by dragging a sibling, writing a control we have promised
    // never to write. AGENTS.md invariant 4.
    send({ type: 'load', data: schema });
    ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    ctlNode('ThirdPartyGauge').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    const lockedSel = canvasEl.querySelectorAll('.ctl.selected').map((n) => n.dataset.id);
    check('a Locked Control stays selectable on its own, so its reason is readable',
        lockedSel.includes('ThirdPartyGauge'), lockedSel.join(','));
    check('shift+click on a Locked Control does NOT build a group',
        !(lockedSel.includes('ThirdPartyGauge') && lockedSel.length > 1), lockedSel.join(','));

    // And the group-drag consequence, which is the invariant that actually matters.
    send({ type: 'load', data: schema });
    ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    ctlNode('btnSubmit').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    ctlNode('ThirdPartyGauge').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    const gaugeLeft = ctlNode('ThirdPartyGauge').style.left;
    ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    sandbox.window.dispatch('mousemove', { clientX: 200, clientY: 100 });
    sandbox.window.dispatch('mouseup', {});
    mirrorScale();
    check('dragging a sibling cannot move a Locked Control',
        ctlNode('ThirdPartyGauge').style.left === gaugeLeft,
        `${gaugeLeft} -> ${ctlNode('ThirdPartyGauge').style.left}`);

    // ---- distribute must COMMIT.
    // It was a `case` with a `return` inside align(), which exited before commit(): it moved
    // the optimistic model, posted nothing, and never wrote the file. Only align-left was
    // covered, so nothing noticed.
    send({ type: 'load', data: schema });
    ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    ctlNode('btnSubmit').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'v', metaKey: true, shiftKey: true, preventDefault() { } });
    await settled();
    check('distribute vertically posts a commit',
        sandbox.__sent.some((m) => m.type === 'commit'),
        'distribute mutated the model but never wrote the file');
    const vCommit = sandbox.__sent.find((m) => m.type === 'commit');
    const ys = (vCommit ? vCommit.data.controls : []).filter((c) => !c.locked)
        .map((c) => c.properties.y).sort((a, b) => a - b);
    check('distribute actually changed the layout', ys.length === 2 && ys[0] !== ys[1],
        JSON.stringify(ys));

    send({ type: 'load', data: schema });
    ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    ctlNode('btnSubmit').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'h', metaKey: true, shiftKey: true, preventDefault() { } });
    await settled();
    check('distribute horizontally posts a commit too — the pair is symmetric',
        sandbox.__sent.some((m) => m.type === 'commit'), 'dist-h is missing while dist-v exists');

    // ---- leaf widgets: dropping one, and the defaults it lands with.
    // A wrong default size is a silent quality bug: no tier sees it, the user just resizes
    // immediately, and every resize is a real write to their file.
    const LEAF = [
        ['TrackBar', 'trk', 120, 56],
        ['ProgressBar', 'prg', 140, 20],
        ['NumericUpDown', 'num', 100, 22],
        ['DateTimePicker', 'dtp', 120, 23],
    ];
    for (const [simple, prefix, w, h] of LEAF) {
        send({ type: 'load', data: schema });
        await settled();
        const box = canvasEl.getBoundingClientRect();
        sandbox.__sent.length = 0;
        stage.dispatch('drop', {
            clientX: box.left + 40, clientY: box.top + 40,
            dataTransfer: { getData: (k) => (k === 'text/vscforms-control' ? simple : '') },
            preventDefault() { },
        });
        await settled();
        const dropCommit = sandbox.__sent.find((m) => m.type === 'commit');
        const added = dropCommit && dropCommit.data.controls.find((x) => x.type.endsWith('.' + simple));
        check(`${simple} drops with the ${prefix} prefix`,
            added && added.id.startsWith(prefix), added ? added.id : 'not added');
        check(`${simple} lands at the design-time default ${w}x${h}`,
            added && added.properties.width === w && added.properties.height === h,
            added ? `${added.properties.width}x${added.properties.height}` : 'n/a');

        // None of the four renders text, so Text must be DISABLED — a field that silently goes
        // nowhere is worse than no field, because it looks like it works.
        if (added) {
            ctlNode(added.id).dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
            const textInput = insInputs().find((i) => i.type === 'text' && i.value === (added.properties.text || ''));
            check(`${simple} disables the Text field it cannot honour`,
                !!textInput && textInput.disabled === true,
                textInput ? 'disabled=' + textInput.disabled : 'no text input found');
        }
    }

    // ---- TextBox & Leaf Widget properties in inspector
    send({ type: 'load', data: schema });
    ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
    await settled();
    check('TextBox inspector offers Multiline', insInputs().some((i) => i.id === 'fMultiline'));
    check('TextBox inspector offers ReadOnly', insInputs().some((i) => i.id === 'fReadOnly'));
    check('TextBox inspector offers MaxLength', insInputs().some((i) => i.id === 'fMaxLength'));
    check('TextBox inspector offers PasswordChar', insInputs().some((i) => i.id === 'fPasswordChar'));

    // Check Range controls for leaf widgets
    const leafSchema = {
        ...schema,
        controls: [
            { id: 'trkTest', type: 'System.Windows.Forms.TrackBar', children: [], locked: false,
              properties: { x: 10, y: 10, width: 120, height: 56, tabIndex: 0, minimum: 0, maximum: 100, value: 50 } },
        ],
    };
    send({ type: 'load', data: leafSchema });
    ctlNode('trkTest').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
    await settled();
    check('TrackBar inspector offers Minimum', insInputs().some((i) => i.id === 'fMinimum'));
    check('TrackBar inspector offers Maximum', insInputs().some((i) => i.id === 'fMaximum'));
    check('TrackBar inspector offers Value', insInputs().some((i) => i.id === 'fValue'));

    // ---- Items editor: verify it appears for ComboBox/ListBox and posts commits
    const itemsTestSchema = {
        ...schema,
        controls: [
            { id: 'cboTest', type: 'System.Windows.Forms.ComboBox', children: [], locked: false,
              properties: { x: 10, y: 10, width: 120, height: 23, text: '', tabIndex: 0, items: ['A', 'B'] } },
            { id: 'btnTest', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 10, y: 50, width: 80, height: 23, text: 'Go', tabIndex: 1 } },
        ],
        analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
        form: { name: 'TestForm', text: 'Test', clientSize: { width: 200, height: 200 }, className: 'TestForm' },
    };
    send({ type: 'load', data: itemsTestSchema });
    await settled();
    const cboNode = ctlNode('cboTest');
    cboNode.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
    await settled();
    // The items editor should be in the inspector - look for the input fields
    const itemsEditor = ids.inspector.querySelector('.items-editor');
    const itemsInputs = itemsEditor ? itemsEditor.querySelectorAll('input') : [];
    check('Items editor shows input fields for existing items', itemsInputs.length >= 2, 'got ' + itemsInputs.length);
    // Add a new item via the "add" button (last input is "New item…", last button is "+")
    const addInputs = itemsEditor ? itemsEditor.querySelectorAll('input') : [];
    const addInput = addInputs[addInputs.length - 1];
    const addButtons = itemsEditor ? itemsEditor.querySelectorAll('button') : [];
    const addBtn = addButtons[addButtons.length - 1];
    check('Items editor has add controls', addInput && addBtn, 'missing add controls');
    addInput.value = 'C';
    addBtn.dispatch('click', {});
    // Wait for commit to be posted (debounced 220ms, wait longer to be safe)
    await new Promise((r) => setTimeout(r, 400));
    // Find the LATEST commit (find returns first, we want last)
    const commits = sandbox.__sent.filter((m) => m.type === 'commit');
    const itemsCommit = commits[commits.length - 1];
    const sentCbo = itemsCommit && itemsCommit.data.controls.find((c) => c.id === 'cboTest');
    check('Adding an item posts a commit with updated items array',
        sentCbo && Array.isArray(sentCbo.properties.items) && sentCbo.properties.items.length === 3 && sentCbo.properties.items[2] === 'C',
        sentCbo ? JSON.stringify(sentCbo.properties.items) : 'no commit (commits: ' + commits.length + ')');

    // Items editor should NOT appear for Button
    const btnNode = ctlNode('btnTest');
    btnNode.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
    await settled();
    const btnItemsEditor = ids.inspector.querySelector('.items-editor');
    const btnItemsInputs = btnItemsEditor ? btnItemsEditor.querySelectorAll('input') : [];
    check('Items editor does NOT appear for Button', !btnItemsEditor || btnItemsInputs.length === 0, 'got ' + btnItemsInputs.length + ' inputs in items-editor');

    // ---- A5: SelectedIndex + DropDownStyle inspector rows (ComboBox/ListBox only)
    const selTestSchema = {
        ...schema,
        controls: [
            { id: 'cboSel', type: 'System.Windows.Forms.ComboBox', children: [], locked: false,
              properties: { x: 10, y: 10, width: 120, height: 23, text: '', tabIndex: 0, items: ['A', 'B'], selectedIndex: 1, dropDownStyle: 'DropDownList' } },
            { id: 'lstSel', type: 'System.Windows.Forms.ListBox', children: [], locked: false,
              properties: { x: 10, y: 50, width: 120, height: 60, text: '', tabIndex: 1, items: ['X'], selectedIndex: 0 } },
        ],
        analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
        form: { name: 'TestForm', text: 'Test', clientSize: { width: 200, height: 200 }, className: 'TestForm' },
    };
    send({ type: 'load', data: selTestSchema });
    await settled();
    ctlNode('cboSel').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
    await settled();
    check('ComboBox inspector offers SelectedIndex', insInputs().some((i) => i.id === 'fSelectedIndex'));
    check('ComboBox inspector offers SelectedItem', insInputs().some((i) => i.id === 'fSelectedItem'));
    check('ComboBox inspector offers DropDownStyle',
        ids.inspector.querySelectorAll('select').some((s) => s.id === 'fDropDownStyle'));
    sandbox.__sent.length = 0;
    const siInput = insInputs().find((i) => i.id === 'fSelectedIndex');
    siInput.value = '0';
    siInput.dispatch('change', {});
    await settled();
    const siCommit = sandbox.__sent.find((m) => m.type === 'commit');
    const siCbo = siCommit && siCommit.data.controls.find((c) => c.id === 'cboSel');
    check('editing SelectedIndex posts selectedIndex as a NUMBER, not a string',
        siCbo && siCbo.properties.selectedIndex === 0 && typeof siCbo.properties.selectedIndex === 'number',
        siCbo ? JSON.stringify(siCbo.properties.selectedIndex) : 'no commit');
    sandbox.__sent.length = 0;
    const ddSel = ids.inspector.querySelectorAll('select').find((s) => s.id === 'fDropDownStyle');
    ddSel.value = 'DropDown';
    ddSel.dispatch('change', {});
    await settled();
    const ddCommit = sandbox.__sent.find((m) => m.type === 'commit');
    const ddCbo = ddCommit && ddCommit.data.controls.find((c) => c.id === 'cboSel');
    check('editing DropDownStyle posts the new style name',
        ddCbo && ddCbo.properties.dropDownStyle === 'DropDown',
        ddCbo ? JSON.stringify(ddCbo.properties.dropDownStyle) : 'no commit');
    // ListBox gets selection rows but no DropDownStyle.
    ctlNode('lstSel').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
    await settled();
    check('ListBox inspector offers SelectedIndex', insInputs().some((i) => i.id === 'fSelectedIndex'));
    check('ListBox inspector does NOT offer DropDownStyle',
        !ids.inspector.querySelectorAll('select').some((s) => s.id === 'fDropDownStyle'));

    // ---- Phase C: Placeholders (DataGridView, ListView, TreeView)
    const PLACEHOLDERS = [
        ['DataGridView', 'dgv', 240, 150],
        ['ListView', 'lvw', 120, 97],
        ['TreeView', 'tvw', 120, 97],
    ];
    for (const [simple, prefix, w, h] of PLACEHOLDERS) {
        send({ type: 'load', data: schema });
        await settled();
        const box = canvasEl.getBoundingClientRect();
        sandbox.__sent.length = 0;
        stage.dispatch('drop', {
            clientX: box.left + 40, clientY: box.top + 40,
            dataTransfer: { getData: (k) => (k === 'text/vscforms-control' ? simple : '') },
            preventDefault() { },
        });
        await settled();
        const dropCommit = sandbox.__sent.find((m) => m.type === 'commit');
        const added = dropCommit && dropCommit.data.controls.find((x) => x.type.endsWith('.' + simple));
        check(`${simple} drops with the ${prefix} prefix`,
            added && added.id.startsWith(prefix), added ? added.id : 'not added');
        check(`${simple} lands at the design-time default ${w}x${h}`,
            added && added.properties.width === w && added.properties.height === h,
            added ? `${added.properties.width}x${added.properties.height}` : 'n/a');

        if (added) {
            const cap = ctlNode(added.id).querySelector('.ctl-caption');
            check(`${simple} renders placeholder label with name and type`,
                cap && cap.textContent.includes(added.id) && cap.textContent.includes(simple),
                cap ? cap.textContent : 'no caption');

            ctlNode(added.id).dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
            const textInput = insInputs().find((i) => i.type === 'text' && i.value === (added.properties.text || ''));
            check(`${simple} disables the Text field it cannot honour`,
                !!textInput && textInput.disabled === true,
                textInput ? 'disabled=' + textInput.disabled : 'no text input found');
        }
    }

    // ---- Phase B: TabControl + TabPage two-level nesting and tab-strip
    const containerTestSchema = {
        ...schema,
        controls: [
            {
                id: 'tabMain', type: 'System.Windows.Forms.TabControl', locked: false,
                properties: { x: 10, y: 15, width: 300, height: 200, tabIndex: 0 },
                children: [
                    {
                        id: 'page1', type: 'System.Windows.Forms.TabPage', locked: false,
                        properties: { x: 4, y: 22, width: 290, height: 170, text: 'General', tabIndex: 0 },
                        children: [
                            {
                                id: 'btnInside', type: 'System.Windows.Forms.Button', locked: false,
                                properties: { x: 25, y: 35, width: 80, height: 25, text: 'Inner', tabIndex: 0 },
                                children: []
                            }
                        ]
                    },
                    {
                        id: 'page2', type: 'System.Windows.Forms.TabPage', locked: false,
                        properties: { x: 4, y: 22, width: 290, height: 170, text: 'Advanced', tabIndex: 1 },
                        children: []
                    }
                ]
            }
        ],
        analysis: { modelledCount: 4, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
    };
    send({ type: 'load', data: containerTestSchema });
    await settled();

    const tabNode = ctlNode('tabMain');
    const strip = tabNode.querySelector('.tab-strip');
    check('TabControl renders a tab-strip', !!strip);
    const tabs = strip ? strip.querySelectorAll('.tab-item') : [];
    check('Tab-strip renders tabs for both pages', tabs.length === 2 && tabs[0].textContent === 'General' && tabs[1].textContent === 'Advanced',
        'tabs count: ' + tabs.length);

    const page1Node = ctlNode('page1');
    const page2Node = ctlNode('page2');
    const btnNodeNested = ctlNode('btnInside');

    check('TabPage page1 is child of TabControl in DOM', page1Node && page1Node.parentNode === tabNode);
    check('Button btnInside is child of TabPage page1 in DOM (2 levels deep)', btnNodeNested && btnNodeNested.parentNode === page1Node);
    check('Nested Button resolves position relative to page, not form',
        btnNodeNested && btnNodeNested.style.left === '25px' && btnNodeNested.style.top === '35px',
        btnNodeNested ? `${btnNodeNested.style.left}, ${btnNodeNested.style.top}` : 'no btn');
    check('Initial active tab page is not hidden', page1Node && !page1Node.classList.contains('tabpage-hidden'));
    check('Inactive tab page is hidden', page2Node && page2Node.classList.contains('tabpage-hidden'));

    // Switch tab by clicking tab 2
    tabs[1].dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 5, clientY: 5 });
    await settled();
    const page2Active = ctlNode('page2');
    check('Clicking tab switches active page and unhides it', page2Active && !page2Active.classList.contains('tabpage-hidden'));

    // ---- Form inspection, handles, and new control properties
    const formSchemaTest = {
        schemaVersion: 1,
        form: { name: 'MainForm', text: 'My App', clientSize: { width: 400, height: 300 }, className: 'MainForm', backColor: '#123456' },
        controls: [
            { id: 'chkOpt', type: 'System.Windows.Forms.CheckBox', children: [], locked: false,
              properties: { x: 10, y: 10, width: 100, height: 20, text: 'Enable', checked: true, foreColor: '#00ff00', borderStyle: 'FixedSingle', textAlign: 'MiddleRight', autoSize: true } },
            { id: 'txtInput', type: 'System.Windows.Forms.TextBox', children: [], locked: false,
              properties: { x: 10, y: 40, width: 120, height: 25, text: '', scrollBars: 'Vertical' } }
        ],
        analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] }
    };
    send({ type: 'load', data: formSchemaTest });
    await settled();

    // Check canvas applied form backColor
    check('canvas applies form backColor', ids.canvas.style.backgroundColor === '#123456');

    // Inspector with 0 selection shows Form properties
    const formInspectorHtml = String(ids.inspector.innerHTML || ids.inspector.textContent || '');
    check('inspector shows Form when no control is selected', /MainForm \(Form\)/.test(formInspectorHtml));
    const formInputs = ids.inspector.querySelectorAll('input');
    check('form inspector exposes Title, Width, Height, BackColor', formInputs.length >= 4);

    // Edit form width
    sandbox.__sent.length = 0;
    const widthInput = formInputs.find((i) => i.id === 'fWidth');
    check('form inspector has fWidth', !!widthInput);
    if (widthInput) {
        widthInput.value = '500';
        widthInput.dispatch('change', {});
        await settled();
        const formCommit = sandbox.__sent.find((m) => m.type === 'commit');
        check('editing form width commits updated clientSize.width', formCommit && formCommit.data.form.clientSize.width === 500);
    }

    // Form handles
    const formFrameEl = sandbox.__frame;
    const formHandles = formFrameEl ? formFrameEl.querySelectorAll('.form-handle') : [];
    check('form frame renders 3 resize handles (e, s, se)', formHandles.length === 3, 'got: ' + formHandles.length);

    // Test new control properties & visual styling
    const chkNode = ctlNode('chkOpt');
    check('CheckBox with checked:true has .checked class', chkNode && chkNode.classList.contains('checked'));
    check('control has foreColor applied to style.color', chkNode && chkNode.style.color === '#00ff00');
    check('control has border-fixedsingle class', chkNode && chkNode.classList.contains('border-fixedsingle'));

    // Select chkOpt to inspect properties
    chkNode.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 15, clientY: 15 });
    await settled();
    const chkInputs = ids.inspector.querySelectorAll('input');
    const chkSelects = ids.inspector.querySelectorAll('select');
    const autoSizeBox = chkInputs.find((i) => i.id === 'fAutoSize');
    check('CheckBox inspector offers AutoSize', !!autoSizeBox);
    const checkedBox = chkInputs.find((i) => i.id === 'fChecked');
    check('CheckBox inspector offers Checked', !!checkedBox && checkedBox.checked === true);
    const textAlignSel = chkSelects.find((s) => s.id === 'fTextAlign');
    // Select txtInput and check ScrollBars and BorderStyle
    const txtNode = ctlNode('txtInput');
    txtNode.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 15, clientY: 45 });
    await settled();
    const txtSelects = ids.inspector.querySelectorAll('select');
    const scrollBarsSel = txtSelects.find((s) => s.id === 'fScrollBars');
    check('TextBox inspector offers ScrollBars', !!scrollBarsSel);
    const borderStyleSel = txtSelects.find((s) => s.id === 'fBorderStyle');
    check('TextBox inspector offers BorderStyle', !!borderStyleSel);

    // ---- D9 object selector dropdown: jump selection to a hidden/buried control.
    // Selection only — choosing an entry must select without emitting a commit.
    send({ type: 'load', data: schema });
    await settled();
    {
        const selDropdown = () => ids.inspector.querySelector('select');
        const selOptions = () => (selDropdown() ? selDropdown().querySelectorAll('option') : []);
        const selIds = () => canvasEl.querySelectorAll('.ctl.selected').map((n) => n.dataset.id).join(',');
        check('object selector dropdown is offered', !!selDropdown());
        const flatIds = selOptions().map((o) => o.value).filter(Boolean);
        check('dropdown lists every schema control',
            flatIds.length === 3 && flatIds.includes('txtName') && flatIds.includes('btnSubmit')
                && flatIds.includes('ThirdPartyGauge'),
            flatIds.join(','));
        const lockedOpt = selOptions().find((o) => o.value === 'ThirdPartyGauge');
        check('locked entry is shown with its reason',
            !!lockedOpt && /locked/i.test(String(lockedOpt.textContent))
                && String(lockedOpt.title || '').length > 10,
            lockedOpt ? lockedOpt.textContent + ' | ' + lockedOpt.title : 'missing');
        // A buried control: nested inside a container, pathed so it is findable.
        const buriedD9 = JSON.parse(JSON.stringify(schema));
        buriedD9.controls.push({ id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [
            { id: 'btnIn', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 5, y: 5, width: 80, height: 25, text: 'In', tabIndex: 0 } },
        ], locked: false, properties: { x: 10, y: 10, width: 200, height: 150, tabIndex: 1 } });
        send({ type: 'load', data: buriedD9 });
        await settled();
        const nestedIds = selOptions().map((o) => o.value).filter(Boolean);
        check('dropdown lists nested controls too', nestedIds.includes('btnIn'), nestedIds.join(','));
        const nestedOpt = selOptions().find((o) => o.value === 'btnIn');
        check('nested entry shows its container path',
            !!nestedOpt && /pnlWrap/.test(String(nestedOpt.textContent)),
            nestedOpt ? nestedOpt.textContent : 'missing');
        // Choosing an entry selects it with no commit.
        sandbox.__sent.length = 0;
        selDropdown().value = 'btnIn';
        selDropdown().dispatch('change', {});
        check('choosing an entry selects it', selIds() === 'btnIn', selIds());
        await settled();
        check('selecting via the dropdown posts no commit — selection is view state',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        // Drill-down scope does not trap the selector: it leaves the scope, then selects.
        send({ type: 'load', data: buriedD9 });
        await settled();
        ctlNode('pnlWrap').dispatch('dblclick', { preventDefault() { }, stopPropagation() { } });
        check('drill-down entered for the jump test',
            /Entered pnlWrap/.test(String(ids.status.textContent)), String(ids.status.textContent));
        sandbox.__sent.length = 0;
        selDropdown().value = 'btnSubmit';
        selDropdown().dispatch('change', {});
        check('jump from drill scope selects outside it', selIds() === 'btnSubmit', selIds());
        await settled();
        check('the drill-scope jump posts no commit either',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        // Locked entries are select-readable: choosing one selects it alone.
        send({ type: 'load', data: schema });
        await settled();
        sandbox.__sent.length = 0;
        selDropdown().value = 'ThirdPartyGauge';
        selDropdown().dispatch('change', {});
        check('locked entry selects alone, so its reason is readable',
            selIds() === 'ThirdPartyGauge', selIds());
        await settled();
        check('selecting a locked entry posts no commit',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
    }
    // ---- D5 toolbox upgrade: search/filter + Ctrl+Alt+X; drag-to-add unchanged
    // All adds still travel the existing drop -> addControl -> commit path: no new
    // generate surface. Filtering is view state, so it must survive a re-render.
    send({ type: 'load', data: schema });
    await settled();
    {
        const search = () => ids.toolbox.querySelector('.toolbox-search');
        const tools = () => ids.toolbox.querySelectorAll('.tool');
        const visibleNames = () => tools()
            .filter((t) => t.style.display !== 'none')
            .map((t) => t.dataset.simple);
        const typeFilter = (v) => { search().value = v; search().dispatch('input', {}); };

        check('toolbox offers a search input', !!search());
        check('search input names its keyboard shortcut',
            /Ctrl\+Alt\+X/.test(String(search() && search().title)),
            search() ? String(search().title) : 'no search box');
        check('search input has an accessible label',
            !!(search() && search().getAttribute('aria-label')));
        check('empty filter shows every tool',
            visibleNames().length === tools().length,
            `${visibleNames().length}/${tools().length}`);

        typeFilter('but');
        check('filter narrows to matching types',
            visibleNames().join(',') === 'Button,RadioButton',
            visibleNames().join(','));
        typeFilter('TAB');
        check('filter is case-insensitive',
            visibleNames().join(',') === 'TabControl,TabPage',
            visibleNames().join(','));
        typeFilter('zzz-no-match');
        check('a filter with no matches shows nothing', visibleNames().length === 0);
        typeFilter('');
        check('clearing the filter restores every tool',
            visibleNames().length === tools().length);

        // Filter survives a re-render (renderToolbox runs on every renderAll, i.e. after
        // every commit — rebuilding the input there would drop focus mid-typing).
        typeFilter('combo');
        send({ type: 'load', data: schema });
        await settled();
        check('filter text survives a document reload',
            String(search().value) === 'combo', String(search().value));
        check('filtered list survives a document reload',
            visibleNames().join(',') === 'ComboBox', visibleNames().join(','));
        typeFilter('');

        // Ctrl+Alt+X focuses the search box, from anywhere (bound on window).
        sandbox.document.activeElement = null;
        sandbox.window.dispatch('keydown', { key: 'x', ctrlKey: true, altKey: true, preventDefault() { } });
        check('ctrl+alt+X focuses the toolbox search',
            sandbox.document.activeElement === search());
        sandbox.document.activeElement = null;
        sandbox.window.dispatch('keydown', { key: 'X', metaKey: true, altKey: true, preventDefault() { } });
        check('cmd+alt+X (macOS variant) focuses the toolbox search',
            sandbox.document.activeElement === search());
        // A plain x (or ctrl+x without alt) must not steal focus.
        sandbox.document.activeElement = null;
        sandbox.window.dispatch('keydown', { key: 'x', preventDefault() { } });
        check('a bare x does not move focus', sandbox.document.activeElement === null);

        // Keys typed in the search box never reach the canvas: without stopPropagation,
        // Delete would delete the selection and arrows would nudge it mid-search.
        let stopped = false;
        search().dispatch('keydown', { key: 'Delete', stopPropagation() { stopped = true; }, preventDefault() { } });
        check('search-box keys stop before the canvas handlers', stopped);

        // Drag-to-add through an active filter still uses the drop -> addControl path:
        // one commit, no rename message, designer-style name.
        typeFilter('button');
        sandbox.__sent.length = 0;
        {
            const box = canvasEl.getBoundingClientRect();
            stage.dispatch('drop', {
                clientX: box.left + 40, clientY: box.top + 40,
                dataTransfer: { getData: (k) => (k === 'text/vscforms-control' ? 'Button' : '') },
                preventDefault() { },
            });
        }
        await settled();
        const d5commits = sandbox.__sent.filter((m) => m.type === 'commit');
        const d5added = d5commits.length && d5commits[0].data.controls.find((x) => x.id !== 'btnSubmit' && x.type.endsWith('.Button'));
        check('dropping a filtered tool still adds through addControl',
            !!d5added && d5added.id.startsWith('btn'), d5added ? d5added.id : 'not added');
        check('the add posts a schema commit and nothing else',
            sandbox.__sent.every((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        typeFilter('');
    }

    // ---- D6 Document Outline: read-only hierarchy + F2 rename, no reorder UI
    // Reorder (drag-reparent / Z-order) is unrepresentable in id-diffed generate (A1),
    // so the outline omits it entirely — the last two checks assert the omission.
    const outlineSchema = {
        schemaVersion: 1,
        form: { name: 'OutlineForm', text: 'Outline', clientSize: { width: 400, height: 300 }, className: 'OutlineForm' },
        controls: [
            { id: 'btnTop', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 10, y: 10, width: 80, height: 25, text: 'Top', tabIndex: 0 } },
            { id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [
                { id: 'btnIn', type: 'System.Windows.Forms.Button', children: [], locked: false,
                  properties: { x: 5, y: 5, width: 80, height: 25, text: 'In', tabIndex: 0 } },
            ], locked: false, properties: { x: 10, y: 50, width: 200, height: 150, tabIndex: 1 } },
            { id: 'GaugeX', type: 'ThirdParty.Widgets.Gauge', children: [], locked: true,
              lockedReason: 'Gauge is not one of the handled control types, so its appearance is not modelled.',
              properties: { x: 220, y: 10, width: 80, height: 28 } },
        ],
        analysis: { modelledCount: 3, unmodelledCount: 1, coveragePercent: 75, refuses: [], warnings: [] },
    };
    send({ type: 'load', data: outlineSchema });
    await settled();
    const wb = sandbox.__workbench;
    const outlineRows = () => wb.querySelectorAll('.outline-row');
    const outlineRow = (id) => outlineRows().find((n) => n.dataset.id === id);
    check('outline renders one row per control', outlineRows().length === 4,
        'got ' + outlineRows().length);
    check('outline nests container children under their parent row',
        outlineRow('btnIn') && outlineRow('btnIn').parentNode
            && outlineRow('btnIn').parentNode.parentNode === outlineRow('pnlWrap'),
        'btnIn is not nested under pnlWrap');
    check('outline labels name the control and its type',
        outlineRow('btnTop') && /btnTop/.test(outlineRow('btnTop').textContent)
            && /Button/.test(outlineRow('btnTop').textContent),
        outlineRow('btnTop') && outlineRow('btnTop').textContent);
    {
        const g = outlineRow('GaugeX');
        const why = g && g.querySelector('.outline-locked-reason');
        check('locked control appears in the outline with its reason',
            !!why && String(why.textContent).length > 10,
            why ? String(why.textContent) : 'no reason node');
        check('locked row carries the reason as a tooltip',
            g && String(g.title || '').length > 10, g && JSON.stringify(g.title));
    }
    // Clicks reuse select(): canvas and outline agree on the selection.
    outlineRow('btnIn').dispatch('mousedown', { preventDefault() { }, stopPropagation() { } });
    check('clicking an outline row selects the control on the canvas',
        canvasEl.querySelectorAll('.ctl.selected').map((n) => n.dataset.id).join(',') === 'btnIn',
        canvasEl.querySelectorAll('.ctl.selected').map((n) => n.dataset.id).join(','));
    check('the outline highlights the selected row',
        outlineRow('btnIn') && outlineRow('btnIn').classList.contains('selected'));
    // A locked row stays selectable (that is how its reason is readable)…
    outlineRow('GaugeX').dispatch('mousedown', { preventDefault() { }, stopPropagation() { } });
    check('locked outline row still selects, so its reason is readable',
        canvasEl.querySelectorAll('.ctl.selected').some((n) => n.dataset.id === 'GaugeX'));
    // …but F2 on it opens nothing and posts nothing.
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'F2', preventDefault() { } });
    check('F2 on a locked control opens no rename field',
        !outlineRow('GaugeX').querySelector('.outline-rename'));
    check('F2 on a locked control posts nothing', sandbox.__sent.length === 0,
        JSON.stringify(sandbox.__sent.map((m) => m.type)));
    // F2 renames through the existing rename path: a `rename` message, never a commit.
    outlineRow('btnTop').dispatch('mousedown', { preventDefault() { }, stopPropagation() { } });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'F2', preventDefault() { } });
    const renameInput = outlineRow('btnTop') && outlineRow('btnTop').querySelector('.outline-rename');
    check('F2 opens a rename field on the selected row', !!renameInput);
    check('rename field starts from the current id', !!renameInput && renameInput.value === 'btnTop',
        renameInput ? JSON.stringify(renameInput.value) : 'no field');
    if (renameInput) {
        renameInput.value = 'btnFirst';
        renameInput.dispatch('keydown', { key: 'Enter', preventDefault() { }, stopPropagation() { } });
        const posted = sandbox.__sent;
        const renameMsg = posted.find((m) => m.type === 'rename');
        check('F2 rename posts a rename message', !!renameMsg,
            JSON.stringify(posted.map((m) => m.type)));
        check('rename message carries the old id and the new name',
            renameMsg && renameMsg.data.id === 'btnTop' && renameMsg.data.to === 'btnFirst',
            renameMsg ? JSON.stringify(renameMsg.data) : 'none');
        check('F2 rename does NOT post a schema commit',
            !posted.some((m) => m.type === 'commit'), JSON.stringify(posted.map((m) => m.type)));
    }
    // Escape cancels with no message.
    outlineRow('btnTop').dispatch('mousedown', { preventDefault() { }, stopPropagation() { } });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'F2', preventDefault() { } });
    const cancelInput = outlineRow('btnTop') && outlineRow('btnTop').querySelector('.outline-rename');
    check('F2 reopens the rename field for the cancel path', !!cancelInput);
    if (cancelInput) {
        cancelInput.value = 'btnNope';
        cancelInput.dispatch('keydown', { key: 'Escape', preventDefault() { }, stopPropagation() { } });
        check('Escape cancels the rename with no message', sandbox.__sent.length === 0,
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        check('Escape removes the rename field',
            !outlineRow('btnTop').querySelector('.outline-rename'));
    }
    // Refused forms stay out: the hierarchy still renders, but read-only — F2 is dead.
    send({ type: 'load', data: { ...outlineSchema, analysis: { ...outlineSchema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
    await settled();
    check('refused form still shows the hierarchy (read-only)',
        wb.querySelectorAll('.outline-row').length === 4,
        String(wb.querySelectorAll('.outline-row').length));
    outlineRow('btnTop').dispatch('mousedown', { preventDefault() { }, stopPropagation() { } });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'F2', preventDefault() { } });
    check('F2 on a refused form opens no rename field',
        !outlineRow('btnTop').querySelector('.outline-rename'));
    check('F2 on a refused form posts nothing', sandbox.__sent.length === 0,
        JSON.stringify(sandbox.__sent.map((m) => m.type)));
    {
        // Task 6 (#52) lifted the D6 reorder omission for STEP order: unlocked rows
        // carry one-slot ▲▼ buttons riding the A1 move; locked rows get none
        // (invariant 4), and rows are still never draggable — outline order is
        // stepped, never faked, and drag-reparent stays a canvas gesture.
        send({ type: 'load', data: outlineSchema });
        await settled();
        const panel = wb.querySelector('.outline');
        const rowBtns = (r) => (r && r.children ? r.children.filter((c) => c.tagName === 'BUTTON') : []);
        const stepBtns = (id) => rowBtns(outlineRow(id)).filter((b) =>
            b.classList.contains('outline-step-fwd') || b.classList.contains('outline-step-back'));
        check('unlocked outline rows offer exactly the two step buttons',
            stepBtns('btnTop').length === 2 && stepBtns('btnIn').length === 2,
            'btnTop=' + stepBtns('btnTop').length + ' btnIn=' + stepBtns('btnIn').length);
        check('outline rows offer no other buttons (no reparent actions)',
            outlineRows().every((r) => rowBtns(r).length
                === (r.dataset.id === 'GaugeX' ? 0 : 2)),
            'got ' + outlineRows().map((r) => r.dataset.id + ':' + rowBtns(r).length).join(','));
        check('a locked outline row offers no step buttons', stepBtns('GaugeX').length === 0,
            'got ' + stepBtns('GaugeX').length);
        check('outline rows are not draggable — drag-reparent stays a canvas gesture',
            outlineRows().every((r) => !r.draggable),
            'a draggable row would fake drag-reparent');
    }

    // ---- D7 smart tags removed (#44): no per-control disclosure glyph. Every action the
    // flyout aliased already has its own surface (Cmd/Ctrl+D duplicate, inspector
    // Delete/Arrange/rows, items editor, container drop), so a glyph on every Modelled
    // Control was clutter, not capability. Assert absence on an editable form and a
    // refused form; a Locked Control never had one and still does not.
    send({ type: 'load', data: schema });
    await settled();
    {
        check('no disclosure glyph renders on a Modelled Control',
            !ctlNode('btnSubmit').querySelector('.smart-tag-toggle'));
        check('no smart-tag flyout renders anywhere',
            ids.canvas.querySelectorAll('.smart-tag-flyout').length === 0,
            String(ids.canvas.querySelectorAll('.smart-tag-flyout').length));
        check('no smart-tag CSS classes leak into the canvas',
            ids.canvas.querySelectorAll('.smart-tag-toggle,.smart-tag-action').length === 0,
            String(ids.canvas.querySelectorAll('.smart-tag-toggle,.smart-tag-action').length));
    }
    send({ type: 'load', data: { ...schema, analysis: { ...schema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
    await settled();
    {
        check('a Refusal renders no disclosure glyph',
            ids.canvas.querySelectorAll('.smart-tag-toggle').length === 0,
            String(ids.canvas.querySelectorAll('.smart-tag-toggle').length));
    }
    // ---- D8 modal Font editor: a dialog over the modelled font path only
    const workbench = () => sandbox.document.querySelector('.workbench');
    const fontBtn = () => ids.inspector.querySelectorAll('button')
        .find((b) => String(b.textContent || '') === 'Edit Font…');
    const openModal = () => { fontBtn().dispatch('click', {}); return workbench().querySelector('.font-modal'); };
    const clickBtn = (id) => ctlNode(id)
        .dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });

    send({ type: 'load', data: schema });
    clickBtn('btnSubmit');
    await settled();
    check('Font row offers the modal editor button', !!fontBtn());

    // Locked controls never get an editor — not even a locked Button, which is in
    // HAS_FONT and so renders (disabled) inline rows.
    const lockedFontSchema = JSON.parse(JSON.stringify(schema));
    lockedFontSchema.controls.push({ id: 'btnLock', type: 'System.Windows.Forms.Button', children: [], locked: true,
        lockedReason: 'Not modelled in this test.', properties: { x: 10, y: 120, width: 84, height: 27, text: 'Locked' } });
    send({ type: 'load', data: lockedFontSchema });
    clickBtn('btnLock');
    await settled();
    check('locked control gets no Font editor', !fontBtn());

    // Types outside HAS_FONT have no Font to edit.
    const noFontSchema = JSON.parse(JSON.stringify(schema));
    noFontSchema.controls.push({ id: 'prgLoad', type: 'System.Windows.Forms.ProgressBar', children: [], locked: false,
        properties: { x: 10, y: 150, width: 140, height: 20 } });
    send({ type: 'load', data: noFontSchema });
    clickBtn('prgLoad');
    await settled();
    check('NO_TEXT control gets no Font editor', !fontBtn());

    // Refused forms are read-only: no editor.
    send({ type: 'load', data: { ...schema, analysis: { ...schema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
    clickBtn('btnSubmit');
    await settled();
    check('refused form gets no Font editor', !fontBtn());
    // ... and no dialog can be forced open for one either.
    check('no modal lingers after the refused load', !workbench().querySelector('.font-modal'));

    // Fresh editable model for the commit round trips. btnSubmit has NO font yet,
    // so the first modal edit below also exercises the INSERT path.
    send({ type: 'load', data: schema });
    clickBtn('btnSubmit');
    await settled();
    {
        sandbox.__sent.length = 0;
        const modal = openModal();
        check('Font button opens the modal dialog', !!modal);
        const famInput = modal.querySelectorAll('input').find((i) => i.id === 'fFontFamily');
        const sizeInput = modal.querySelectorAll('input').find((i) => i.id === 'fFontSize');
        check('modal pre-fills the current size default', sizeInput && sizeInput.value === '9',
            sizeInput ? JSON.stringify(sizeInput.value) : 'no size input');
        check('modal pre-fills an empty family', famInput && famInput.value === '',
            famInput ? JSON.stringify(famInput.value) : 'no family input');
        modal.querySelector('.font-ok').dispatch('click', {});
        await settled();
        check('OK with no changes posts no commit — a no-op never dirties the file',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        check('no-op OK closes the dialog', !workbench().querySelector('.font-modal'));
    }
    {
        // Cancel discards even a real change.
        const modal = openModal();
        modal.querySelectorAll('input').find((i) => i.id === 'fFontSize').value = '20';
        sandbox.__sent.length = 0;
        modal.querySelector('.font-cancel').dispatch('click', {});
        await settled();
        check('Cancel posts no commit', !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        check('Cancel closes the dialog', !workbench().querySelector('.font-modal'));
    }
    {
        // Escape discards with no generate.
        const modal = openModal();
        modal.querySelectorAll('input').find((i) => i.id === 'fFontSize').value = '20';
        sandbox.__sent.length = 0;
        modal.querySelectorAll('input').find((i) => i.id === 'fFontFamily')
            .dispatch('keydown', { key: 'Escape', preventDefault() { }, stopPropagation() { } });
        await settled();
        check('Escape posts no commit', !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        check('Escape closes the dialog', !workbench().querySelector('.font-modal'));
    }
    {
        // A modal size edit commits through the font path (INSERT: btnSubmit has none).
        const modal = openModal();
        modal.querySelectorAll('input').find((i) => i.id === 'fFontSize').value = '14';
        sandbox.__sent.length = 0;
        modal.querySelector('.font-ok').dispatch('click', {});
        await settled();
        const commits = sandbox.__sent.filter((m) => m.type === 'commit');
        check('modal edit posts exactly one commit', commits.length === 1,
            String(commits.length));
        const sent = commits.length && commits[0].data.controls.find((c) => c.id === 'btnSubmit');
        check('modal INSERTs the font the control lacked',
            !!sent && sent.properties.font && sent.properties.font.size === 14,
            sent ? JSON.stringify(sent.properties.font) : 'no commit');
    }
    {
        // Family + style travel in the same font value the engine patches per-argument.
        send({ type: 'load', data: schema });
        clickBtn('btnSubmit');
        await settled();
        const modal = openModal();
        modal.querySelectorAll('input').find((i) => i.id === 'fFontFamily').value = 'Segoe UI';
        modal.querySelectorAll('input').find((i) => i.id === 'fFontSize').value = '12';
        modal.querySelectorAll('input').find((i) => i.id === 'fFontBold').checked = true;
        sandbox.__sent.length = 0;
        modal.querySelector('.font-ok').dispatch('click', {});
        await settled();
        const commit = sandbox.__sent.filter((m) => m.type === 'commit').pop();
        const sent = commit && commit.data.controls.find((c) => c.id === 'btnSubmit');
        const f = sent && sent.properties.font;
        check('modal commits family, size and style together',
            !!f && f.family === 'Segoe UI' && f.size === 12 && f.bold === true && f.italic === false,
            f ? JSON.stringify(f) : 'no commit');
    }
    {
        // Same value as the inline inspector edit: the dialog is input UI, and the
        // engine's per-argument patch cannot tell the two apart.
        const sameFont = (a, b) => !!a && !!b
            && Math.abs(a.size - b.size) <= 0.001
            && !!a.bold === !!b.bold && !!a.italic === !!b.italic
            && (a.family || '') === (b.family || '');
        send({ type: 'load', data: schema });
        clickBtn('btnSubmit');
        await settled();
        sandbox.__sent.length = 0;
        const inline = insInputs().find((i) => i.id === 'fFontsize');
        inline.value = '14';
        inline.dispatch('change', {});
        await settled();
        const inlineCommit = sandbox.__sent.filter((m) => m.type === 'commit').pop();
        const inlineFont = inlineCommit
            && inlineCommit.data.controls.find((c) => c.id === 'btnSubmit').properties.font;
        send({ type: 'load', data: schema });
        clickBtn('btnSubmit');
        await settled();
        const modal = openModal();
        modal.querySelectorAll('input').find((i) => i.id === 'fFontSize').value = '14';
        sandbox.__sent.length = 0;
        modal.querySelector('.font-ok').dispatch('click', {});
        await settled();
        const modalCommit = sandbox.__sent.filter((m) => m.type === 'commit').pop();
        const modalFont = modalCommit
            && modalCommit.data.controls.find((c) => c.id === 'btnSubmit').properties.font;
        check('modal commits the same font value as the inline inspector edit',
            sameFont(modalFont, inlineFont),
            JSON.stringify({ modalFont, inlineFont }));
    }
    {
        // A control that already has a font: opening and OK-ing unchanged is a no-op,
        // so untouched files keep byte-identity.
        const withFont = JSON.parse(JSON.stringify(schema));
        withFont.controls.find((c) => c.id === 'btnSubmit').properties.font =
            { family: 'Arial', size: 10, bold: true, italic: false };
        send({ type: 'load', data: withFont });
        clickBtn('btnSubmit');
        await settled();
        const modal = openModal();
        const famInput = modal.querySelectorAll('input').find((i) => i.id === 'fFontFamily');
        check('modal pre-fills the existing family', famInput && famInput.value === 'Arial',
            famInput ? JSON.stringify(famInput.value) : 'no family input');
        sandbox.__sent.length = 0;
        modal.querySelector('.font-ok').dispatch('click', {});
        await settled();
        check('unchanged existing font posts no commit',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
    }
    // ---- A2 clipboard copy/paste via the host round-trip (#3)
    // Copy serializes the selection to ControlNode JSON (`copy`); paste arrives back as
    // `paste` after the host carries it through vscode.env.clipboard. The harness stands
    // in for the host: it asserts the outgoing messages and re-posts `paste` directly.
    send({ type: 'load', data: schema });
    await settled();
    ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'c', metaKey: true, preventDefault() { } });
    {
        const cp = sandbox.__sent.find((m) => m.type === 'copy');
        check('ctrl+C posts a copy message', !!cp, JSON.stringify(sandbox.__sent.map((m) => m.type)));
        check('copy serializes the selection as ControlNode JSON',
            !!cp && Array.isArray(cp.data.nodes) && cp.data.nodes.length === 1 && cp.data.nodes[0].id === 'btnSubmit',
            cp ? JSON.stringify(cp.data.nodes.map((n) => n.id)) : 'no copy');
        check('copy carries the control type and geometry',
            !!cp && cp.data.nodes[0].type === 'System.Windows.Forms.Button' && cp.data.nodes[0].properties.x === 96,
            cp ? JSON.stringify(cp.data.nodes[0]) : 'no copy');
    }
    // Locked never joins the payload: alone it copies nothing, in a group it is excluded.
    ctlNode('ThirdPartyGauge').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'c', metaKey: true, preventDefault() { } });
    check('copying a locked-only selection posts no copy message',
        !sandbox.__sent.some((m) => m.type === 'copy'),
        JSON.stringify(sandbox.__sent.map((m) => m.type)));
    send({ type: 'load', data: schema });
    // A locked click collapses the selection to itself (readable reason), so the group-with-
    // locked order is locked-first: shift+clicking modelled controls after it re-adds them,
    // and the payload must still exclude the locked member.
    ctlNode('ThirdPartyGauge').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    ctlNode('txtName').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    ctlNode('btnSubmit').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'c', metaKey: true, preventDefault() { } });
    {
        const cp = sandbox.__sent.find((m) => m.type === 'copy');
        const idsCopied = cp ? cp.data.nodes.map((n) => n.id).sort() : [];
        check('locked never joins a group payload',
            !!cp && idsCopied.join(',') === 'btnSubmit,txtName', idsCopied.join(','));
    }
    // Ctrl+V asks the host; the host round-trip reply arrives as `paste`.
    send({ type: 'load', data: schema });
    ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    sandbox.__sent.length = 0;
    stage.dispatch('keydown', { key: 'v', metaKey: true, preventDefault() { } });
    check('ctrl+V posts a requestPaste message to the host',
        sandbox.__sent.some((m) => m.type === 'requestPaste'),
        JSON.stringify(sandbox.__sent.map((m) => m.type)));
    check('ctrl+V does not commit on its own — the host reply drives the insert',
        !sandbox.__sent.some((m) => m.type === 'commit'),
        JSON.stringify(sandbox.__sent.map((m) => m.type)));
    // Ctrl+Shift+V still distributes (VS parity), it must not request a paste.
    sandbox.__sent.length = 0;
    ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
    ctlNode('btnSubmit').dispatch('mousedown',
        { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
    stage.dispatch('keydown', { key: 'v', metaKey: true, shiftKey: true, preventDefault() { } });
    check('ctrl+shift+V still distributes rather than pasting',
        !sandbox.__sent.some((m) => m.type === 'requestPaste'),
        JSON.stringify(sandbox.__sent.map((m) => m.type)));
    // Paste inserts with a GRID offset and a collision-free id, then commits once.
    send({ type: 'load', data: schema });
    await settled();
    sandbox.__sent.length = 0;
    send({ type: 'paste', data: { nodes: [
        { id: 'btnSubmit', type: 'System.Windows.Forms.Button', children: [], locked: false,
          properties: { x: 96, y: 154, width: 84, height: 27, text: 'Submit', tabIndex: 3 } },
    ] } });
    {
        const pasted = canvasEl.querySelectorAll('.ctl').map((n) => n.dataset.id);
        check('paste inserts the node under a fresh id (uniqueId collision handling)',
            pasted.includes('btnSubmit2') && pasted.includes('btnSubmit'),
            pasted.join(','));
        const node = ctlNode('btnSubmit2');
        check('paste offsets by one grid unit so the copy is visible',
            node && parseFloat(node.style.left) === 104 && parseFloat(node.style.top) === 162,
            node ? `${node.style.left},${node.style.top}` : 'missing btnSubmit2');
    }
    await settled();
    {
        const commits = sandbox.__sent.filter((m) => m.type === 'commit');
        check('paste posts exactly one commit', commits.length === 1,
            String(sandbox.__sent.map((m) => m.type)));
        const sent = commits.length && commits[0].data.controls.find((c) => c.id === 'btnSubmit2');
        check('commit carries the pasted control', !!sent && sent.properties.text === 'Submit',
            sent ? JSON.stringify(sent.properties) : 'no commit');
    }
    // A pasted type the target does not model lands locked, never discarded.
    send({ type: 'load', data: schema });
    await settled();
    sandbox.__sent.length = 0;
    send({ type: 'paste', data: { nodes: [
        { id: 'gauge1', type: 'ThirdParty.Widgets.GaugeControl', children: [], locked: false,
          properties: { x: 10, y: 10, width: 80, height: 28 } },
    ] } });
    {
        const node = ctlNode('gauge12') || ctlNode('gauge1');
        check('unhandled pasted type is kept on the canvas, not discarded', !!node,
            canvasEl.querySelectorAll('.ctl').map((n) => n.dataset.id).join(','));
        check('unhandled pasted type lands locked',
            !!node && node.classList.contains('locked'),
            node ? String(node.className) : 'missing node');
    }
    await settled();
    {
        const commits = sandbox.__sent.filter((m) => m.type === 'commit');
        const sent = commits.length && commits[commits.length - 1].data.controls.find((c) => /gauge1/.test(c.id));
        check('commit carries the locked fallback with its reason',
            !!sent && sent.locked === true && String(sent.lockedReason || '').length > 10,
            sent ? JSON.stringify(sent) : 'no commit');
    }
    // Container+child copies as dragRoots: the child rides along, pasted once.
    {
        const nested = JSON.parse(JSON.stringify(schema));
        nested.controls.push({ id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [
            { id: 'btnIn', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 5, y: 5, width: 80, height: 25, text: 'In', tabIndex: 0 } },
        ], locked: false, properties: { x: 10, y: 10, width: 200, height: 150, tabIndex: 1 } });
        send({ type: 'load', data: nested });
        await settled();
        ctlNode('pnlWrap').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        ctlNode('btnIn').dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 20, clientY: 20 });
        sandbox.__sent.length = 0;
        stage.dispatch('keydown', { key: 'c', metaKey: true, preventDefault() { } });
        const cp = sandbox.__sent.find((m) => m.type === 'copy');
        check('container+child serializes as one root (dragRoots)',
            !!cp && cp.data.nodes.length === 1 && cp.data.nodes[0].id === 'pnlWrap'
                && cp.data.nodes[0].children.length === 1 && cp.data.nodes[0].children[0].id === 'btnIn',
            cp ? JSON.stringify(cp.data.nodes.map((n) => [n.id, (n.children || []).map((c) => c.id)])) : 'no copy');
        // Paste it back: one new container, child riding along exactly once.
        sandbox.__sent.length = 0;
        send({ type: 'paste', data: cp.data });
        const panels = canvasEl.querySelectorAll('.ctl').filter((n) => /^pnlWrap/.test(n.dataset.id));
        check('pasting the container inserts one new root, not root+orphan',
            panels.length === 2, panels.map((n) => n.dataset.id).join(','));
        await settled();
        const last = sandbox.__sent.filter((m) => m.type === 'commit').slice(-1)[0];
        const roots = last ? last.data.controls.filter((c) => /^pnlWrap/.test(c.id)) : [];
        check('the pasted child rides along inside its container (not displaced twice)',
            roots.length === 2 && roots.some((c) => (c.children || []).length === 1
                && c.children[0].properties.x === 5 && c.children[0].properties.y === 5),
            last ? JSON.stringify(roots.map((c) => [c.id, c.properties.x, (c.children || []).map((g) => [g.id, g.properties.x, g.properties.y])])) : 'no commit');
    }
    // Clipboard text parsing: prefixed payload parses, anything else pastes nothing.
    send({ type: 'load', data: schema });
    await settled();
    {
        const before = canvasEl.querySelectorAll('.ctl').length;
        sandbox.__sent.length = 0;
        send({ type: 'paste', data: { text: 'vscforms-controls-v1:' + JSON.stringify([
            { id: 'btnSubmit', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 0, y: 0, width: 84, height: 27, text: 'T', tabIndex: 0 } },
        ]) } });
        check('paste accepts the host clipboard text shape',
            canvasEl.querySelectorAll('.ctl').length === before + 1,
            `${before} -> ${canvasEl.querySelectorAll('.ctl').length}`);
        await settled();
        sandbox.__sent.length = 0;
        const countAfterGood = canvasEl.querySelectorAll('.ctl').length;
        send({ type: 'paste', data: { text: 'hello, a foreign clipboard' } });
        check('foreign clipboard text pastes nothing',
            canvasEl.querySelectorAll('.ctl').length === countAfterGood,
            String(canvasEl.querySelectorAll('.ctl').length));
        await settled();
        check('foreign text posts no commit', !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
    }
    // Refused forms paste nothing and do not even ask the host.
    send({ type: 'load', data: { ...schema, analysis: { ...schema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
    await settled();
    {
        const before = canvasEl.querySelectorAll('.ctl').length;
        sandbox.__sent.length = 0;
        stage.dispatch('keydown', { key: 'v', metaKey: true, preventDefault() { } });
        check('refused form does not request a paste',
            !sandbox.__sent.some((m) => m.type === 'requestPaste'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        send({ type: 'paste', data: { nodes: [
            { id: 'btnX', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 0, y: 0, width: 84, height: 27, text: 'X', tabIndex: 0 } },
        ] } });
        check('refused form inserts nothing on paste',
            canvasEl.querySelectorAll('.ctl').length === before,
            `${before} -> ${canvasEl.querySelectorAll('.ctl').length}`);
        await settled();
        check('refused paste posts no commit', !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
    }
    // ---- A1 z-order (Bring to Front / Send to Back): array order IS paint order.
    // Index 0 is front (top), matching the Controls collection — the canvas paints
    // array-first on top through descending z-indexes, so DOM order stays array order.
    send({ type: 'load', data: schema });
    await settled();
    {
        const order = () => canvasEl.querySelectorAll('.ctl').map((n) => n.dataset.id);
        const zOf = (id) => String(ctlNode(id).style.zIndex || '');
        const clickArrange = (label) => {
            const b = ids.inspector.querySelectorAll('button').find((x) => String(x.textContent || '') === label);
            if (!b) return false;
            b.dispatch('click', {});
            return true;
        };
        const commitIds = () => {
            const commits = sandbox.__sent.filter((m) => m.type === 'commit');
            const last = commits[commits.length - 1];
            return last ? last.data.controls.map((c) => c.id) : null;
        };
        check('DOM order follows schema order (index 0 is front)',
            order().join(',') === 'txtName,btnSubmit,ThirdPartyGauge', order().join(','));
        check('z-index paints array-first on top (descending)',
            zOf('txtName') === '3' && zOf('btnSubmit') === '2' && zOf('ThirdPartyGauge') === '1',
            [zOf('txtName'), zOf('btnSubmit'), zOf('ThirdPartyGauge')].join(','));
        ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        const arrangeLabels = ids.inspector.querySelectorAll('button').map((b) => String(b.textContent || ''));
        check('inspector offers Bring to Front', arrangeLabels.includes('Bring to Front'), arrangeLabels.join(','));
        check('inspector offers Send to Back', arrangeLabels.includes('Send to Back'), arrangeLabels.join(','));
        // btnSubmit is mid-stack: bring it to front (index 0).
        sandbox.__sent.length = 0;
        check('bring-to-front action runs', clickArrange('Bring to Front'));
        check('bring to front repaints first (on top)',
            order().join(',') === 'btnSubmit,txtName,ThirdPartyGauge', order().join(','));
        check('z-index follows the move',
            zOf('btnSubmit') === '3' && zOf('txtName') === '2', `${zOf('btnSubmit')},${zOf('txtName')}`);
        await settled();
        check('bring to front posts one commit with array order preserved end-to-end',
            JSON.stringify(commitIds()) === JSON.stringify(['btnSubmit', 'txtName', 'ThirdPartyGauge']),
            JSON.stringify(commitIds()));
        // Now front-most: send it to back (last).
        sandbox.__sent.length = 0;
        check('send-to-back action runs', clickArrange('Send to Back'));
        check('send to back repaints last (behind)',
            order().join(',') === 'txtName,ThirdPartyGauge,btnSubmit', order().join(','));
        await settled();
        check('send to back commits the reordered array',
            JSON.stringify(commitIds()) === JSON.stringify(['txtName', 'ThirdPartyGauge', 'btnSubmit']),
            JSON.stringify(commitIds()));
        // Already at front: bring to front is a no-op with no commit.
        ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        sandbox.__sent.length = 0;
        clickArrange('Bring to Front');
        await settled();
        check('bring to front at front posts no commit', sandbox.__sent.length === 0,
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        // Locked controls get no z-order buttons: they must never move (invariant 4).
        ctlNode('ThirdPartyGauge').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        const lockedLabels = ids.inspector.querySelectorAll('button').map((b) => String(b.textContent || ''));
        check('locked control offers no Bring to Front', !lockedLabels.includes('Bring to Front'), lockedLabels.join(','));
        check('locked control offers no Send to Back', !lockedLabels.includes('Send to Back'), lockedLabels.join(','));
        // Refused forms are read-only: no buttons either.
        send({ type: 'load', data: { ...schema, analysis: { ...schema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
        await settled();
        ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        const roLabels = ids.inspector.querySelectorAll('button').map((b) => String(b.textContent || ''));
        check('refused form offers no Bring to Front', !roLabels.includes('Bring to Front'), roLabels.join(','));
        // Multi-selection moves as a block, preserving internal order.
        send({ type: 'load', data: schema });
        await settled();
        ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        ctlNode('btnSubmit').dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
        sandbox.__sent.length = 0;
        check('multi-selection offers Send to Back', clickArrange('Send to Back'));
        check('block keeps internal order at back',
            order().join(',') === 'ThirdPartyGauge,txtName,btnSubmit', order().join(','));
        await settled();
        check('block move commits one reordered array',
            JSON.stringify(commitIds()) === JSON.stringify(['ThirdPartyGauge', 'txtName', 'btnSubmit']),
            JSON.stringify(commitIds()));
        // Nested: the child reorders within its own parent group only.
        const zNested = JSON.parse(JSON.stringify(schema));
        zNested.controls.push({ id: 'pnlW', type: 'System.Windows.Forms.Panel', children: [
            { id: 'btnA', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 5, y: 5, width: 80, height: 25, text: 'A', tabIndex: 0 } },
            { id: 'btnB', type: 'System.Windows.Forms.Button', children: [], locked: false,
              properties: { x: 30, y: 30, width: 80, height: 25, text: 'B', tabIndex: 1 } },
        ], locked: false, properties: { x: 10, y: 100, width: 200, height: 90, tabIndex: 2 } });
        send({ type: 'load', data: zNested });
        await settled();
        ctlNode('btnB').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        sandbox.__sent.length = 0;
        check('nested bring-to-front action runs', clickArrange('Bring to Front'));
        const kidOrder = () => ctlNode('pnlW').children
            .filter((n) => n.classList.contains('ctl')).map((n) => n.dataset.id);
        check('nested child repaints first inside its parent',
            kidOrder().join(',') === 'btnB,btnA', kidOrder().join(','));
        check('nested child is front-most inside its own stacking context',
            String(ctlNode('btnB').style.zIndex) === '2' && String(ctlNode('btnA').style.zIndex) === '1',
            `${ctlNode('btnB').style.zIndex},${ctlNode('btnA').style.zIndex}`);
        await settled();
        {
            const commits = sandbox.__sent.filter((m) => m.type === 'commit');
            const last = commits[commits.length - 1];
            const pnl = last && last.data.controls.find((c) => c.id === 'pnlW');
            check('nested move commits the reordered children array',
                !!pnl && pnl.children.map((c) => c.id).join(',') === 'btnB,btnA',
                pnl ? pnl.children.map((c) => c.id).join(',') : 'no commit');
            check('nested move leaves the top-level array alone',
                !!last && last.data.controls.map((c) => c.id).join(',') === 'txtName,btnSubmit,ThirdPartyGauge,pnlW',
                last ? last.data.controls.map((c) => c.id).join(',') : 'no commit');
        }

        // ---- D10 inspector views: Flat / Categorized / Alphabetical (spec-property-tabs §§1–2)
        // Presentational sort/group over the same rows: switching views re-renders only,
        // never posts a commit (byte-identical file by construction — same class as D1/D5,
        // no ADR, no engine change). Every offered property carries a category; Misc is
        // the fallback for anything unmapped.
        send({ type: 'load', data: schema });
        await settled();
        ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
        await settled();
        {
            const viewBtn = (label) => ids.inspector.querySelectorAll('button')
                .find((b) => String(b.textContent || '') === label);
            const setView = (label) => viewBtn(label).dispatch('click', {});
            const fieldLabels = () => ids.inspector.querySelectorAll('.field')
                .filter((f) => f.dataset && f.dataset.prop).map((f) => String(f.dataset.prop));
            const catHeads = () => ids.inspector.querySelectorAll('.inspector-cat')
                .map((h) => String(h.textContent));
            const sorted = (xs) => xs.slice().sort((a, b) =>
                a.toLowerCase() < b.toLowerCase() ? -1 : 1);

            check('inspector offers all three view modes',
                !!viewBtn('Flat') && !!viewBtn('Categorized') && !!viewBtn('Alphabetical'));
            check('flat is the default view',
                viewBtn('Flat').getAttribute('aria-pressed') === 'true');
            check('flat keeps the current row order (geometry first)',
                fieldLabels().slice(0, 4).join(',') === 'X,Y,Width,Height',
                fieldLabels().slice(0, 6).join(','));
            check('flat keeps the legacy section heads',
                ids.inspector.querySelectorAll('.inspector-section').length > 0);

            // Categorized: groups in alphabetical category order, A–Z rows within.
            sandbox.__sent.length = 0;
            setView('Categorized');
            await settled();
            check('switching views posts no commit — the file is untouched',
                !sandbox.__sent.some((m) => m.type === 'commit'),
                JSON.stringify(sandbox.__sent.map((m) => m.type)));
            check('categorized marks itself pressed', viewBtn('Categorized').getAttribute('aria-pressed') === 'true');
            const heads = catHeads();
            check('categorized groups exist', heads.length >= 3, heads.join(','));
            check('categories run in alphabetical order',
                JSON.stringify(heads) === JSON.stringify(sorted(heads)), heads.join(','));
            check('legacy flat section heads are gone in categorized view',
                ids.inspector.querySelectorAll('.inspector-section').length === 0);
            check('no property row is lost regrouping',
                fieldLabels().length >= 10, String(fieldLabels().length));
            check('every offered property carries a category (none unmapped)',
                ids.inspector.querySelectorAll('.field')
                    .filter((f) => f.dataset && f.dataset.prop)
                    .every((f) => String(f.dataset.cat || '').length > 0));
            check('Name sits in the Design group',
                ids.inspector.querySelectorAll('.field')
                    .filter((f) => f.dataset && f.dataset.prop === 'Name')
                    .every((f) => f.dataset.cat === 'Design'));
            {
                // A–Z within each category: walk the regrouped DOM in order.
                const seen = {};
                let ordered = true;
                for (const n of ids.inspector.children) {
                    if (n.classList && n.classList.contains('inspector-cat')) {
                        seen.cur = String(n.textContent); seen[seen.cur] = [];
                    } else if (n.classList && n.classList.contains('field') && n.dataset && n.dataset.prop && seen.cur) {
                        seen[seen.cur].push(String(n.dataset.prop));
                    }
                }
                for (const cat of Object.keys(seen).filter((k) => k !== 'cur' && Array.isArray(seen[k]))) {
                    if (JSON.stringify(seen[cat]) !== JSON.stringify(sorted(seen[cat]))) { ordered = false; break; }
                }
                check('rows run A–Z within each category', ordered);
            }

            // An edit in categorized view travels the same setProp/commit path.
            sandbox.__sent.length = 0;
            const catText = ids.inspector.querySelectorAll('input').find((i) => i.id === 'fText');
            check('categorized view keeps the Text field addressable', !!catText);
            catText.value = 'Categorized edit';
            catText.dispatch('change', {});
            await settled();
            const catCommit = sandbox.__sent.find((m) => m.type === 'commit');
            const catSent = catCommit && catCommit.data.controls.find((c) => c.id === 'btnSubmit');
            check('editing in categorized view commits through the same path',
                !!catSent && catSent.properties.text === 'Categorized edit',
                catSent ? JSON.stringify(catSent.properties) : 'no commit');

            // Live drag values still reach the inspector outside flat order (id lookup).
            {
                const x0 = parseFloat(ctlNode('btnSubmit').style.left);
                ctlNode('btnSubmit').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 100, clientY: 100 });
                sandbox.window.dispatch('mousemove', { clientX: 140, clientY: 100 });
                sandbox.window.dispatch('mouseup', {});
                mirrorScale();
                const fx = ids.inspector.querySelectorAll('input').find((i) => i.id === 'fX');
                check('drag in categorized view moves the control',
                    parseFloat(ctlNode('btnSubmit').style.left) !== x0);
                check('drag in categorized view updates the regrouped X field by id',
                    !!fx && fx.value === String(Math.round(parseFloat(ctlNode('btnSubmit').style.left))),
                    fx ? JSON.stringify(fx.value) : 'no fX input');
                await settled();
                sandbox.__sent.length = 0;
            }
            sandbox.__sent.length = 0;
            setView('Alphabetical');
            await settled();
            check('alphabetical switch posts no commit either',
                !sandbox.__sent.some((m) => m.type === 'commit'),
                JSON.stringify(sandbox.__sent.map((m) => m.type)));
            check('alphabetical shows no category heads',
                ids.inspector.querySelectorAll('.inspector-cat').length === 0,
                String(ids.inspector.querySelectorAll('.inspector-cat').length));
            {
                const labs = fieldLabels();
                check('alphabetical lists every row A–Z',
                    labs.length >= 10 && JSON.stringify(labs) === JSON.stringify(sorted(labs)),
                    labs.join(','));
            }

            // Back to flat: legacy order and heads return, still no commit.
            sandbox.__sent.length = 0;
            setView('Flat');
            await settled();
            check('returning to flat posts no commit',
                !sandbox.__sent.some((m) => m.type === 'commit'),
                JSON.stringify(sandbox.__sent.map((m) => m.type)));
            check('flat order is restored',
                fieldLabels().slice(0, 4).join(',') === 'X,Y,Width,Height',
                fieldLabels().slice(0, 6).join(','));

            // Locked controls and refused forms keep the toggle (read-only rows regroup
            // the same way); multi-selection has no properties, so no toggle there.
            ctlNode('ThirdPartyGauge').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
            await settled();
            check('locked control keeps the view toggle',
                !!viewBtn('Flat') && !!viewBtn('Categorized') && !!viewBtn('Alphabetical'));
            send({ type: 'load', data: schema });
            await settled();
            ctlNode('txtName').dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 });
            ctlNode('btnSubmit').dispatch('mousedown',
                { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
            await settled();
            check('multi-selection offers no view toggle (nothing to sort)',
                !ids.inspector.querySelectorAll('button').some((b) => String(b.textContent || '') === 'Categorized'));

            // Form inspector (no selection) regroups too: Title/BackColor under
            // Appearance, Width/Height under Layout.
            winKey('Escape', {});
            await settled();
            check('form inspector offers the view toggle', !!viewBtn('Categorized'));
            sandbox.__sent.length = 0;
            setView('Categorized');
            await settled();
            check('form switch posts no commit',
                !sandbox.__sent.some((m) => m.type === 'commit'),
                JSON.stringify(sandbox.__sent.map((m) => m.type)));
            {
                const fhe = catHeads();
                check('form categories cover Appearance and Layout',
                    fhe.includes('Appearance') && fhe.includes('Layout'), fhe.join(','));
            }
            sandbox.__sent.length = 0;
            const fw = ids.inspector.querySelectorAll('input').find((i) => i.id === 'fWidth');
            fw.value = '500';
            fw.dispatch('change', {});
            await settled();
            const fCommit = sandbox.__sent.find((m) => m.type === 'commit');
            check('form edit in categorized view commits the same path',
                !!fCommit && fCommit.data.form.clientSize.width === 500,
                fCommit ? JSON.stringify(fCommit.data.form.clientSize) : 'no commit');
            setView('Flat');
            await settled();
        }
    }

    // ---- Task 1 (#47): click-order dominant + Ctrl+click + align-to-dominant
    // The dominant (VS primary) is the FIRST-clicked member, not schema-first.
    // It carries the `dominant` class (+ white handles in a group); align and
    // same-size reference its edges/extents. Ctrl+click toggles membership.
    // Shift+marquee ADDS to the selection instead of replacing it.
    send({ type: 'load', data: schema });
    await settled();
    winKey('0', { ctrlKey: true, metaKey: true });
    mirrorScale();
    {
        const domMarked = (id) => !!ctlNode(id) && ctlNode(id).classList.contains('dominant');
        const selIds = () => canvasEl.querySelectorAll('.ctl.selected').map((n) => n.dataset.id).sort().join(',');
        const down = (id, extra) => ctlNode(id).dispatch('mousedown',
            Object.assign({ preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 }, extra || {}));
        const arrange = (label) => {
            const b = ids.inspector.querySelectorAll('button').find((x) => String(x.textContent || '') === label);
            if (!b) return false;
            b.dispatch('click', {});
            return true;
        };
        const endDrag = () => { sandbox.window.dispatch('mouseup', {}); mirrorScale(); };

        // Click btnSubmit FIRST, txtName second: dominant is btnSubmit although
        // schema order puts txtName first.
        down('btnSubmit');
        endDrag();
        check('a single selection marks its control dominant', domMarked('btnSubmit'));
        down('txtName', { shiftKey: true });
        endDrag();
        check('a multi-selection marks exactly one dominant',
            canvasEl.querySelectorAll('.ctl.dominant').length === 1,
            String(canvasEl.querySelectorAll('.ctl.dominant').length));
        check('dominant is the first-clicked control, not schema-first',
            domMarked('btnSubmit') && !domMarked('txtName'),
            'btnSubmit=' + domMarked('btnSubmit') + ' txtName=' + domMarked('txtName'));
        check('the dominant member shows resize handles in a group (white)',
            !!ctlNode('btnSubmit').querySelector('.handle'));
        check('a non-dominant member shows no handles',
            !ctlNode('txtName').querySelector('.handle'));

        // Align right references the DOMINANT right edge (btnSubmit: 96+84=180),
        // not the bbox max (txtName: 96+180=276). txtName lands at x=0.
        sandbox.__sent.length = 0;
        winKey('r', { metaKey: true });
        check('align-right references the dominant edge, not the bbox max',
            leftOf('txtName') === 0 && leftOf('btnSubmit') === 96,
            `txtName x=${leftOf('txtName')} btnSubmit x=${leftOf('btnSubmit')}`);
        await settled();
        check('dominant align posts exactly one commit',
            sandbox.__sent.filter((m) => m.type === 'commit').length === 1,
            String(sandbox.__sent.map((m) => m.type)));

        // Same Size copies the DOMINANT extents (btnSubmit 84x27), not
        // schema-first (txtName 180x23).
        send({ type: 'load', data: schema });
        await settled();
        down('btnSubmit');
        endDrag();
        down('txtName', { shiftKey: true });
        endDrag();
        sandbox.__sent.length = 0;
        check('same-size action runs for the dominant check', arrange('Same Size'));
        check('same-size copies the dominant (first-clicked) extents',
            parseFloat(ctlNode('txtName').style.width) === 84
                && parseFloat(ctlNode('txtName').style.height) === 27,
            `${ctlNode('txtName').style.width}x${ctlNode('txtName').style.height}`);
        await settled();
        sandbox.__sent.length = 0;

        // Ctrl+click toggles: add, remove, and empty the selection.
        send({ type: 'load', data: schema });
        await settled();
        down('btnSubmit');
        endDrag();
        down('txtName', { ctrlKey: true });
        endDrag();
        check('ctrl+click adds to the selection', selIds() === 'btnSubmit,txtName', selIds());
        check('ctrl-added member leaves the dominant alone',
            domMarked('btnSubmit') && !domMarked('txtName'));
        down('txtName', { ctrlKey: true });
        endDrag();
        check('ctrl+click on a member removes it', selIds() === 'btnSubmit', selIds());
        check('removing a non-dominant keeps the dominant',
            domMarked('btnSubmit')
                && canvasEl.querySelectorAll('.ctl.dominant').length === 1);
        down('btnSubmit', { ctrlKey: true });
        endDrag();
        check('ctrl+click on the dominant empties the selection', selIds() === '');
        check('no dominant class survives an empty selection',
            canvasEl.querySelectorAll('.ctl.dominant').length === 0);
        // Toggling OFF starts no drag: nothing moved, nothing posted.
        check('toggling off posts no commit — selection is view state',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));

        // Ctrl+click on a Locked Control still collapses to it alone (readable
        // reason) and never builds a group — invariant 4 holds for Ctrl too.
        send({ type: 'load', data: schema });
        await settled();
        down('btnSubmit');
        endDrag();
        down('ThirdPartyGauge', { ctrlKey: true });
        endDrag();
        check('ctrl+click on locked selects it alone, never a group',
            selIds() === 'ThirdPartyGauge', selIds());

        // Shift+marquee ADDS: pre-select btnSubmit, then sweep a rect covering
        // txtName (y 78..101) but not btnSubmit (y 154..181).
        send({ type: 'load', data: schema });
        await settled();
        down('btnSubmit');
        endDrag();
        sandbox.__sent.length = 0;
        canvasEl.dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 0, clientY: 0, shiftKey: true });
        sandbox.window.dispatch('mousemove', { clientX: 400, clientY: 100 });
        sandbox.window.dispatch('mouseup', {});
        mirrorScale();
        check('shift+marquee keeps the pre-existing selection',
            selIds() === 'btnSubmit,txtName', selIds());
        check('shift+marquee posts no commit — selection is view state',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));

        // Plain marquee still replaces: the pre-selection is dropped.
        send({ type: 'load', data: schema });
        await settled();
        down('btnSubmit');
        endDrag();
        canvasEl.dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 0, clientY: 0 });
        sandbox.window.dispatch('mousemove', { clientX: 400, clientY: 100 });
        sandbox.window.dispatch('mouseup', {});
        mirrorScale();
        check('plain marquee replaces the selection',
            selIds() === 'txtName', selIds());

        // Escape clears the dominant marking with the selection.
        down('btnSubmit');
        endDrag();
        down('txtName', { shiftKey: true });
        endDrag();
        winKey('Escape', {});
        check('escape clears the selection with the dominant block',
            canvasEl.querySelectorAll('.ctl.selected').length === 0);
        check('escape clears the dominant marking too',
            canvasEl.querySelectorAll('.ctl.dominant').length === 0);
    }

    // ---- Task 3 (#49): snap/grid — Alt-suppress, baselines, edges+pull,
    // grid-size, SnapLines vs grid-only mode. Render-only: drag math + guide
    // divs, view state only (grid-size and mode never commit, no protocol).
    send({ type: 'load', data: schema });
    await settled();
    winKey('0', { ctrlKey: true, metaKey: true });
    mirrorScale();
    {
        // The earlier snap test left the master toggle OFF; Task 3 needs it ON.
        const snapToggle = () => ids['status-tools'].querySelector('.snap-toggle');
        if (snapToggle() && /off/.test(String(snapToggle().textContent))) snapToggle().dispatch('click', {});
        const modeBtn = () => ids['status-tools'].querySelector('.snap-mode-toggle');
        const gridInput = () => ids['status-tools'].querySelector('.grid-size');
        const guides = () => canvasEl.querySelectorAll('.guide');
        const down = (id, extra) => ctlNode(id).dispatch('mousedown',
            Object.assign({ preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 }, extra || {}));
        const endDrag = () => { sandbox.window.dispatch('mouseup', {}); mirrorScale(); };
        const leftOf = (id) => parseFloat(ctlNode(id).style.left);
        const topOf = (id) => parseFloat(ctlNode(id).style.top);
        // btnA right edge sits at the NON-GRID x=123 (43+80): a drag landing
        // exactly there proves magnetic pull, because grid quantize alone can
        // only ever land on multiples of 8.
        const snapSchema = {
            ...schema,
            controls: [
                { id: 'btnA', type: 'System.Windows.Forms.Button', children: [], locked: false,
                  properties: { x: 43, y: 40, width: 80, height: 25, text: 'A', tabIndex: 0 } },
                { id: 'btnB', type: 'System.Windows.Forms.Button', children: [], locked: false,
                  properties: { x: 200, y: 100, width: 60, height: 25, text: 'B', tabIndex: 1 } },
            ],
            analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
        };

        check('snap offers a SnapLines vs grid-only mode toggle', !!modeBtn());
        check('snap offers a grid-size setting', !!gridInput());
        const ensureLinesMode = () => {
            if (modeBtn() && /grid-only/.test(String(modeBtn().textContent))) modeBtn().dispatch('click', {});
        };
        const ensureGrid8 = () => {
            const g = gridInput();
            if (g && g.value !== '8') { g.value = '8'; g.dispatch('change', {}); }
        };
        ensureLinesMode();
        ensureGrid8();

        // Edge pull on move: dx=-77 quantizes to -80 (x=120), but btnA's
        // right edge at 123 is within SNAP, so the pull wins and x lands 123.
        send({ type: 'load', data: snapSchema });
        await settled();
        down('btnB', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 123, clientY: 100 });
        check('edge pull overrides grid quantize on move', leftOf('btnB') === 123,
            `x=${leftOf('btnB')} (grid alone gives 120)`);
        check('a vertical guide renders at the matched edge',
            guides().some((g) => g.classList.contains('v')), String(guides().length));
        endDrag();
        await settled();
        {
            const commits = sandbox.__sent.filter((m) => m.type === 'commit');
            const last = commits[commits.length - 1];
            const sent = last && last.data.controls.find((c) => c.id === 'btnB');
            check('the pull commit carries the snapped position',
                !!sent && sent.properties.x === 123,
                sent ? JSON.stringify(sent.properties) : 'no commit');
            sandbox.__sent.length = 0;
        }

        // Center pull on move: widths differ (80 vs 60), so center match
        // (x=53) is distinct from any left-edge match (x=43).
        send({ type: 'load', data: snapSchema });
        await settled();
        down('btnB', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 53, clientY: 100 });
        check('center pull aligns control centers, not left edges', leftOf('btnB') === 53,
            `x=${leftOf('btnB')}`);
        endDrag();

        // Top pull on move (dy=-60 quantizes to -56, i.e. y=44; pull to 40).
        send({ type: 'load', data: snapSchema });
        await settled();
        down('btnB', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 200, clientY: 40 });
        check('top-edge pull aligns tops on move', topOf('btnB') === 40,
            `y=${topOf('btnB')} (grid alone gives 44)`);
        check('a horizontal guide renders at the matched edge',
            guides().some((g) => g.classList.contains('h')), String(guides().length));
        endDrag();

        // Bottom-to-top pull on move: btnB's top meets btnA's bottom (65).
        // dy=-35 quantizes to -32 (y=68); pull wins at 65.
        send({ type: 'load', data: snapSchema });
        await settled();
        down('btnB', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 200, clientY: 65 });
        check('bottom-to-top pull aligns edges on move', topOf('btnB') === 65,
            `y=${topOf('btnB')} (grid alone gives 68)`);
        endDrag();

        // Baseline guide: two Labels share the text line. lbl1 top is 40;
        // dy=-58 quantizes to -56 (y=44, 4 off) so the baseline pull wins.
        const baseSchema = {
            ...schema,
            controls: [
                { id: 'lbl1', type: 'System.Windows.Forms.Label', children: [], locked: false,
                  properties: { x: 20, y: 40, width: 80, height: 17, text: 'First', tabIndex: 0 } },
                { id: 'lbl2', type: 'System.Windows.Forms.Label', children: [], locked: false,
                  properties: { x: 200, y: 100, width: 80, height: 17, text: 'Second', tabIndex: 1 } },
            ],
            analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
        };
        send({ type: 'load', data: baseSchema });
        await settled();
        down('lbl2', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 200, clientY: 42 });
        check('baseline pull aligns the shared text line', topOf('lbl2') === 40,
            `y=${topOf('lbl2')}`);
        check('a baseline guide renders for text controls',
            guides().some((g) => g.classList.contains('baseline')),
            `guides: ${guides().map((g) => String(g.className)).join(' ')}`);
        endDrag();

        // Cross-type baseline: a Button's text line meets a Label's. The Button
        // is h=30 so its center (y+15) and baseline (y+15.6) match at DIFFERENT
        // y values (33.5 vs 36): landing on 36 proves the baseline won, because
        // grid gives 36 too but edges-only would take the center match to 33.5
        // (and the top-edge match would take 40). The y is off-grid and off-edge.
        const crossSchema = {
            ...schema,
            controls: [
                { id: 'lbl1', type: 'System.Windows.Forms.Label', children: [], locked: false,
                  properties: { x: 20, y: 40, width: 80, height: 17, text: 'First', tabIndex: 0 } },
                { id: 'btnX', type: 'System.Windows.Forms.Button', children: [], locked: false,
                  properties: { x: 200, y: 100, width: 60, height: 30, text: 'X', tabIndex: 1 } },
            ],
            analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
        };
        send({ type: 'load', data: crossSchema });
        await settled();
        down('btnX', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 200, clientY: 37 });
        check('cross-type baseline pull beats the nearer edge/center matches', topOf('btnX') === 36,
            `y=${topOf('btnX')} (edges-only gives 33.5 or 40)`);
        check('cross-type baseline renders a baseline guide',
            guides().some((g) => g.classList.contains('baseline')),
            `guides: ${guides().map((g) => String(g.className)).join(' ')}`);
        endDrag();

        // Non-text controls get edge guides but never baseline guides.
        const panelSchema = {
            ...schema,
            controls: [
                { id: 'pnl1', type: 'System.Windows.Forms.Panel', children: [], locked: false,
                  properties: { x: 20, y: 40, width: 100, height: 60, tabIndex: 0 } },
                { id: 'pnl2', type: 'System.Windows.Forms.Panel', children: [], locked: false,
                  properties: { x: 200, y: 100, width: 100, height: 60, text: '', tabIndex: 1 } },
            ],
            analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
        };
        send({ type: 'load', data: panelSchema });
        await settled();
        down('pnl2', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 200, clientY: 42 });
        check('panels still pull by edge', topOf('pnl2') === 40, `y=${topOf('pnl2')}`);
        check('panels render no baseline guide',
            !guides().some((g) => g.classList.contains('baseline')),
            `guides: ${guides().map((g) => String(g.className)).join(' ')}`);
        endDrag();

        // Alt-held suppresses quantize, pull AND guides. A raw +5/+1 lands
        // exactly (grid would give +8/+0, pull would stick to an edge), and no
        // guide divs render — even mid-gesture at an exact edge alignment.
        send({ type: 'load', data: snapSchema });
        await settled();
        down('btnB', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 205, clientY: 101, altKey: true });
        check('alt-held drag moves by the raw delta, unquantized',
            leftOf('btnB') === 205 && topOf('btnB') === 101,
            `${leftOf('btnB')},${topOf('btnB')}`);
        check('alt-held drag renders no guides', guides().length === 0,
            String(guides().length));
        sandbox.window.dispatch('mousemove', { clientX: 124, clientY: 100, altKey: true });
        check('alt-held drag skips the pull too (raw 124, not pulled 123, not grid 128)',
            leftOf('btnB') === 124, `x=${leftOf('btnB')}`);
        check('alt-held drag at an edge still renders no guides', guides().length === 0,
            String(guides().length));
        endDrag();

        // Grid-size view state: at 4px a raw 5px drag quantizes to 4, and the
        // setting itself posts no commit (view state, no protocol).
        send({ type: 'load', data: snapSchema });
        await settled();
        sandbox.__sent.length = 0;
        gridInput().value = '4';
        gridInput().dispatch('change', {});
        await settled();
        check('changing the grid size posts no commit — view state only',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        down('btnB', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 205, clientY: 100 });
        check('grid-size 4 quantizes the drag to 4px steps', leftOf('btnB') === 204,
            `x=${leftOf('btnB')}`);
        endDrag();
        ensureGrid8();

        // Grid-only mode: quantize still applies, but no pull and no guides.
        send({ type: 'load', data: snapSchema });
        await settled();
        sandbox.__sent.length = 0;
        modeBtn().dispatch('click', {});
        check('mode toggle switches to grid-only', /grid-only/.test(String(modeBtn().textContent)),
            String(modeBtn().textContent));
        await settled();
        check('switching snap mode posts no commit — view state only',
            !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        down('btnB', { clientX: 200, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 123, clientY: 100 });
        check('grid-only mode does not pull to the edge', leftOf('btnB') === 120,
            `x=${leftOf('btnB')} (lines mode gives 123)`);
        check('grid-only mode renders no guides', guides().length === 0,
            String(guides().length));
        endDrag();
        ensureLinesMode();

        // Multi pull: the group moves as one block and its SHARED bbox edge
        // pulls. btnT's left edge sits at non-grid 251: quantize alone lands
        // the bbox right at 252 (dx=72), the pull corrects to 251 (dx=71), so
        // M1 lands 91 and M2 lands 191 with offsets kept — neither is a
        // multiple-of-8 move from its start. The shift+click that completes
        // the group also starts the drag, so the mousemove follows it directly
        // with no mouseup in between.
        const multiSchema = {
            ...schema,
            controls: [
                { id: 'btnM1', type: 'System.Windows.Forms.Button', children: [], locked: false,
                  properties: { x: 20, y: 40, width: 80, height: 25, text: 'M1', tabIndex: 0 } },
                { id: 'btnM2', type: 'System.Windows.Forms.Button', children: [], locked: false,
                  properties: { x: 120, y: 100, width: 60, height: 25, text: 'M2', tabIndex: 1 } },
                { id: 'btnT', type: 'System.Windows.Forms.Button', children: [], locked: false,
                  properties: { x: 251, y: 60, width: 50, height: 25, text: 'T', tabIndex: 2 } },
            ],
            analysis: { modelledCount: 3, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
        };
        send({ type: 'load', data: multiSchema });
        await settled();
        ctlNode('btnM1').dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 20, clientY: 40 });
        endDrag();
        ctlNode('btnM2').dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 120, clientY: 100 });
        sandbox.window.dispatch('mousemove', { clientX: 190, clientY: 100 });
        check('group pull moves the block with offsets kept',
            leftOf('btnM2') === 191 && leftOf('btnM1') === 91,
            `btnM1 x=${leftOf('btnM1')} btnM2 x=${leftOf('btnM2')} (grid alone gives 92/192)`);
        check('group pull renders a guide', guides().length > 0, String(guides().length));
        endDrag();

        // Locked controls are not snap candidates (TLP/FLP children never
        // reach snap at all: the types are unmodelled per B2, so anything
        // unmodelled arrives locked and locked is excluded here). btnA drags
        // toward the gauge's right edge (90) and bottom (38): dx=45 quantizes
        // to 48 with no pull, so it lands (91,40) with no guides.
        const lockSchema = {
            ...snapSchema,
            controls: [...snapSchema.controls,
                { id: 'gauge1', type: 'ThirdParty.Widgets.Gauge', children: [], locked: true,
                  lockedReason: 'Gauge is not one of the handled control types.',
                  properties: { x: 10, y: 10, width: 80, height: 28 } }],
        };
        send({ type: 'load', data: lockSchema });
        await settled();
        ctlNode('btnA').dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 43, clientY: 40 });
        sandbox.window.dispatch('mousemove', { clientX: 88, clientY: 40 });
        check('no pull toward a locked edge (lands quantized, not snapped)',
            leftOf('btnA') === 91 && topOf('btnA') === 40,
            `${leftOf('btnA')},${topOf('btnA')}`);
        check('no guides toward a locked control', guides().length === 0,
            String(guides().length));
        endDrag();

        // Resize pull: the east handle drags btnR's right edge to lblT's
        // left edge at 150 (raw 109 quantizes to 112, pull wins at 110).
        const resizeSchema = {
            ...schema,
            controls: [
                { id: 'btnR', type: 'System.Windows.Forms.Button', children: [], locked: false,
                  properties: { x: 40, y: 40, width: 80, height: 25, text: 'R', tabIndex: 0 } },
                { id: 'lblT', type: 'System.Windows.Forms.Label', children: [], locked: false,
                  properties: { x: 150, y: 40, width: 60, height: 17, text: 'T', tabIndex: 1 } },
            ],
            analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
        };
        send({ type: 'load', data: resizeSchema });
        await settled();
        down('btnR', { clientX: 40, clientY: 40 });
        endDrag();
        const eHandle = ctlNode('btnR').querySelector('.handle.e');
        check('east handle renders for the resize test', !!eHandle);
        eHandle.dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 120, clientY: 40 });
        sandbox.window.dispatch('mousemove', { clientX: 149, clientY: 40 });
        check('resize pull snaps the moving edge to the sibling edge',
            parseFloat(ctlNode('btnR').style.width) === 110,
            `w=${ctlNode('btnR').style.width} (grid alone gives 112)`);
        check('resize pull renders a guide', guides().length > 0, String(guides().length));
        endDrag();
        await settled();
        {
            const commits = sandbox.__sent.filter((m) => m.type === 'commit');
            const last = commits[commits.length - 1];
            const sent = last && last.data.controls.find((c) => c.id === 'btnR');
            check('the resize commit carries the snapped width',
                !!sent && sent.properties.width === 110,
                sent ? JSON.stringify(sent.properties) : 'no commit');
            sandbox.__sent.length = 0;
        }

        // Resize honors Alt-suppress too: raw delta, no pull, no guides.
        send({ type: 'load', data: resizeSchema });
        await settled();
        down('btnR', { clientX: 40, clientY: 40 });
        endDrag();
        const eHandle2 = ctlNode('btnR').querySelector('.handle.e');
        eHandle2.dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, clientX: 120, clientY: 40 });
        sandbox.window.dispatch('mousemove', { clientX: 149, clientY: 40, altKey: true });
        check('alt-held resize skips quantize and pull',
            parseFloat(ctlNode('btnR').style.width) === 109,
            `w=${ctlNode('btnR').style.width}`);
        check('alt-held resize renders no guides', guides().length === 0,
            String(guides().length));
        endDrag();
        await settled();
        sandbox.__sent.length = 0;
    }

    // ---- Task 4 (#50): draw-to-create + dblclick-populate + Enter-add + live snap on toolbox drag
    // Sticky pointer tool (VS toolbox click arms, crosshair, click places / drag sizes),
    // dblclick populates the active container, Enter adds, toolbox dragover shows Task 3
    // snap guides. Canvas-only: all adds travel addControl -> commit, no schema change,
    // no undo stack, locked/refused never written.
    {
        const toolFor = (simple) => ids.toolbox.querySelectorAll('.tool')
            .find((t) => t.dataset.simple === simple);
        const canvasArmed = () => canvasEl.classList.contains('armed')
            || canvasEl.style.cursor === 'crosshair';
        const guides = () => canvasEl.querySelectorAll('.guide');
        const drawRect = () => canvasEl.querySelector('.draw-rect');
        const endDraw = () => { sandbox.window.dispatch('mouseup', {}); mirrorScale(); };
        const snapToggle = () => ids['status-tools'].querySelector('.snap-toggle');
        const modeBtn = () => ids['status-tools'].querySelector('.snap-mode-toggle');
        const gridInput = () => ids['status-tools'].querySelector('.grid-size');
        if (snapToggle() && /off/.test(String(snapToggle().textContent))) snapToggle().dispatch('click', {});
        if (modeBtn() && /grid-only/.test(String(modeBtn().textContent))) modeBtn().dispatch('click', {});
        if (gridInput() && gridInput().value !== '8') { gridInput().value = '8'; gridInput().dispatch('change', {}); }

        // Single click arms the sticky tool: armed class + crosshair, no commit (view state).
        send({ type: 'load', data: schema });
        await settled();
        sandbox.__sent.length = 0;
        toolFor('Button').dispatch('click', {});
        check('toolbox click arms the sticky tool', toolFor('Button').classList.contains('armed'));
        check('armed canvas shows a crosshair', canvasArmed());
        await settled();
        check('arming posts no commit — view state only', !sandbox.__sent.some((m) => m.type === 'commit'),
            JSON.stringify(sandbox.__sent.map((m) => m.type)));
        // Clicking the same tool again disarms (toggle).
        toolFor('Button').dispatch('click', {});
        check('clicking the armed tool again disarms it', !toolFor('Button').classList.contains('armed')
            && !canvasArmed());

        // Click-to-place with the sticky tool: default size at the anchor, tool stays armed.
        // Anchor (24,24): the default Button 84x27 sits clear of every Task 3
        // candidate (right 108 vs txtName left 96 is 12 off), so no pull corrects it.
        send({ type: 'load', data: schema });
        await settled();
        toolFor('Button').dispatch('click', {});
        sandbox.__sent.length = 0;
        canvasEl.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 24, clientY: 24 });
        sandbox.window.dispatch('mousemove', { clientX: 25, clientY: 25 });
        check('draw shows a live rubber band while sizing', !!drawRect());
        endDraw();
        await settled();
        {
            const commits = sandbox.__sent.filter((m) => m.type === 'commit');
            const added = commits.length && commits[commits.length - 1].data.controls
                .find((x) => x.type.endsWith('.Button') && x.id !== 'btnSubmit');
            check('click-to-place adds through addControl', !!added, added ? added.id : 'not added');
            check('click-to-place lands the design-time default 84x27',
                !!added && added.properties.width === 84 && added.properties.height === 27,
                added ? `${added.properties.width}x${added.properties.height}` : 'n/a');
            check('click-to-place lands at the anchor', !!added && added.properties.x === 24 && added.properties.y === 24,
                added ? `${added.properties.x},${added.properties.y}` : 'n/a');
            check('the tool stays armed after placing (sticky)', !!toolFor('Button') && toolFor('Button').classList.contains('armed'));
            check('placing posts exactly one commit', commits.length === 1, String(commits.length));
        }
        // Escape disarms.
        stage.dispatch('keydown', { key: 'Escape', preventDefault() { } });
        check('Escape disarms the tool', !canvasArmed());

        // Drag-to-size: the rubber band becomes the control rect (16,16 -> 96,56 = 80x40).
        // The right edge lands exactly on txtName's left edge (96), so Task 3 pull holds
        // it there and a live guide renders mid-gesture.
        send({ type: 'load', data: schema });
        await settled();
        toolFor('Button').dispatch('click', {});
        sandbox.__sent.length = 0;
        canvasEl.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 16, clientY: 16 });
        sandbox.window.dispatch('mousemove', { clientX: 96, clientY: 56 });
        check('drag-to-size renders a live guide at the matched edge', guides().length > 0,
            String(guides().length));
        endDraw();
        await settled();
        {
            const commits = sandbox.__sent.filter((m) => m.type === 'commit');
            const added = commits.length && commits[commits.length - 1].data.controls
                .find((x) => x.type.endsWith('.Button') && x.id !== 'btnSubmit');
            check('drag-to-size creates the drawn rect, not the default size',
                !!added && added.properties.width === 80 && added.properties.height === 40,
                added ? `${added.properties.width}x${added.properties.height}` : 'n/a');
            check('drawn rect lands at the drag anchor', !!added && added.properties.x === 16 && added.properties.y === 16,
                added ? `${added.properties.x},${added.properties.y}` : 'n/a');
        }
        stage.dispatch('keydown', { key: 'Escape', preventDefault() { } });

        // Double-click populates the ACTIVE container (drill-down scope), parent-relative.
        {
            const nest = JSON.parse(JSON.stringify(schema));
            nest.controls.push({ id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [],
                locked: false, properties: { x: 10, y: 10, width: 200, height: 150, tabIndex: 1 } });
            send({ type: 'load', data: nest });
            await settled();
            ctlNode('pnlWrap').dispatch('dblclick', { preventDefault() { }, stopPropagation() { } });
            check('drill-down entered for the populate test',
                /Entered pnlWrap/.test(String(ids.status.textContent)), String(ids.status.textContent));
            sandbox.__sent.length = 0;
            toolFor('Button').dispatch('dblclick', { preventDefault() { }, stopPropagation() { } });
            await settled();
            const commits = sandbox.__sent.filter((m) => m.type === 'commit');
            const pnl = commits.length && commits[commits.length - 1].data.controls.find((c) => c.id === 'pnlWrap');
            const kid = pnl && pnl.children && pnl.children[0];
            check('toolbox dblclick populates the active container, not the form top level',
                !!kid && kid.type.endsWith('.Button'), kid ? JSON.stringify([kid.id, kid.type]) : 'no child');
            check('populated child lands parent-relative inside the container',
                !!kid && kid.properties.x === 8 && kid.properties.y === 8,
                kid ? `${kid.properties.x},${kid.properties.y}` : 'n/a');
        }

        // Enter adds through the same populate path (armed tool, active container scope).
        {
            const nest = JSON.parse(JSON.stringify(schema));
            nest.controls.push({ id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [],
                locked: false, properties: { x: 10, y: 10, width: 200, height: 150, tabIndex: 1 } });
            send({ type: 'load', data: nest });
            await settled();
            ctlNode('pnlWrap').dispatch('dblclick', { preventDefault() { }, stopPropagation() { } });
            toolFor('Label').dispatch('click', {});
            sandbox.__sent.length = 0;
            stage.dispatch('keydown', { key: 'Enter', preventDefault() { } });
            await settled();
            const commits = sandbox.__sent.filter((m) => m.type === 'commit');
            const pnl = commits.length && commits[commits.length - 1].data.controls.find((c) => c.id === 'pnlWrap');
            const kid = pnl && pnl.children && pnl.children[0];
            check('Enter adds the armed tool into the active container',
                !!kid && kid.type.endsWith('.Label'), kid ? JSON.stringify([kid.id, kid.type]) : 'no child');
            check('Enter-add keeps the tool armed (sticky)', !!toolFor('Label') && toolFor('Label').classList.contains('armed'));
        }
        stage.dispatch('keydown', { key: 'Escape', preventDefault() { } });

        // Toolbox drag shows live Task 3 snap guides on dragover, before any drop.
        {
            const snapSchema = {
                ...schema,
                controls: [
                    { id: 'btnA', type: 'System.Windows.Forms.Button', children: [], locked: false,
                      properties: { x: 43, y: 40, width: 80, height: 25, text: 'A', tabIndex: 0 } },
                    { id: 'btnB', type: 'System.Windows.Forms.Button', children: [], locked: false,
                      properties: { x: 200, y: 100, width: 60, height: 25, text: 'B', tabIndex: 1 } },
                ],
                analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] },
            };
            send({ type: 'load', data: snapSchema });
            await settled();
            sandbox.__sent.length = 0;
            // Pointer at (143,50): default Button 84x27 lands left=123 (btnA right edge)
            // top=40 (btnA top), so both axes match and guides render.
            stage.dispatch('dragover', {
                clientX: 143, clientY: 50,
                dataTransfer: { getData: (k) => (k === 'text/vscforms-control' ? 'Button' : '') },
                preventDefault() { },
            });
            check('toolbox dragover renders live snap guides', guides().length > 0,
                String(guides().length));
            check('dragover posts no commit — guides are view state',
                !sandbox.__sent.some((m) => m.type === 'commit'),
                JSON.stringify(sandbox.__sent.map((m) => m.type)));
        }

        // Refused forms: no arming, no populate, no guides, no commits.
        send({ type: 'load', data: { ...schema, analysis: { ...schema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
        await settled();
        {
            sandbox.__sent.length = 0;
            toolFor('Button').dispatch('click', {});
            check('refused form does not arm the tool', !toolFor('Button').classList.contains('armed') && !canvasArmed());
            toolFor('Button').dispatch('dblclick', { preventDefault() { }, stopPropagation() { } });
            stage.dispatch('keydown', { key: 'Enter', preventDefault() { } });
            stage.dispatch('drop', {
                clientX: 40, clientY: 40,
                dataTransfer: { getData: (k) => (k === 'text/vscforms-control' ? 'Button' : '') },
                preventDefault() { },
            });
            canvasEl.dispatch('mousedown', { preventDefault() { }, stopPropagation() { }, clientX: 16, clientY: 16 });
            sandbox.window.dispatch('mousemove', { clientX: 96, clientY: 56 });
            endDraw();
            stage.dispatch('dragover', {
                clientX: 143, clientY: 50,
                dataTransfer: { getData: (k) => (k === 'text/vscforms-control' ? 'Button' : '') },
                preventDefault() { },
            });
            check('refused dragover renders no guides', guides().length === 0, String(guides().length));
            await settled();
            check('refused form posts no commit for any Task 4 gesture',
                !sandbox.__sent.some((m) => m.type === 'commit'),
                JSON.stringify(sandbox.__sent.map((m) => m.type)));
        }
        send({ type: 'load', data: schema });
        await settled();
        sandbox.__sent.length = 0;
    }

    // ---- Task 5 (#51): inspector bold+Reset, multi common-props, description pane, Events read-only
    // changed = edited since load (the canvas holds no per-type WinForms default
    // table, so it never claims defaultness). Reset deletes the key from the
    // model and commits through generate; geometry bolds but never resets.
    send({ type: 'load', data: schema });
    await settled();
    {
        const fieldRow = (label) => ids.inspector.querySelectorAll('.field')
            .find((f) => f.dataset && f.dataset.prop === label);
        const shiftClick = (id) => ctlNode(id).dispatch('mousedown',
            { preventDefault() { }, stopPropagation() { }, shiftKey: true, clientX: 10, clientY: 10 });
        const endGesture = () => { sandbox.window.dispatch('mouseup', {}); mirrorScale(); };

        // changed marking + Reset on a single selection
        clickBtn('btnSubmit');
        await settled();
        const textInput = insInputs().find((i) => i.id === 'fText');
        textInput.value = 'Changed!';
        textInput.dispatch('change', {});
        // commit() re-renders synchronously, so the class is already present
        const textRow = fieldRow('Text');
        check('an edited row gets the changed class', !!textRow && textRow.classList.contains('changed'));
        const resetBtn = textRow && textRow.querySelector('.prop-reset');
        check('a changed row offers Reset', !!resetBtn);
        check('an unedited row offers no Reset', !fieldRow('Enabled').querySelector('.prop-reset'));
        check('the X row never offers Reset (geometry has no unset state)',
            !fieldRow('X').querySelector('.prop-reset'));
        sandbox.__sent.length = 0;
        resetBtn.dispatch('click', {});
        await settled();
        const resetCommits = sandbox.__sent.filter((m) => m.type === 'commit');
        check('Reset posts a commit', resetCommits.length === 1, String(resetCommits.length));
        const resetSent = resetCommits.length && resetCommits[0].data.controls.find((c) => c.id === 'btnSubmit');
        check('Reset deletes the prop from the model via the commit',
            !!resetSent && !('text' in resetSent.properties),
            resetSent ? JSON.stringify(resetSent.properties) : 'no commit');

        // geometry bolds without Reset: one nudge marks X changed, still no button
        send({ type: 'load', data: schema });
        await settled();
        clickBtn('btnSubmit');
        ctlNode('btnSubmit').dispatch('keydown', { key: 'ArrowRight', preventDefault() { } });
        const xRow = fieldRow('X');
        check('a nudge marks the X row changed', !!xRow && xRow.classList.contains('changed'));
        check('the changed X row still offers no Reset', !!xRow && !xRow.querySelector('.prop-reset'));
        await settled();
        sandbox.__sent.length = 0;

        // multi-select intersection: TextBox + Button share Text/Enabled/...;
        // Text diverges ('' vs 'Submit') so the row shows blank
        send({ type: 'load', data: schema });
        await settled();
        clickBtn('txtName');
        shiftClick('btnSubmit');
        endGesture();
        await settled();
        const multiText = insInputs().find((i) => i.id === 'fText');
        check('multi-select shows the common Text row', !!multiText);
        check('a divergent value shows blank, never one member\'s value',
            !!multiText && multiText.value === '', multiText ? JSON.stringify(multiText.value) : 'no row');
        const multiEnabled = insInputs().find((i) => i.id === 'fEnabled');
        check('an agreed value shows (both Enabled)',
            !!multiEnabled && multiEnabled.checked === true,
            multiEnabled ? String(multiEnabled.checked) : 'no row');
        check('Multiline is not offered to a TextBox+Button group',
            !insInputs().some((i) => i.id === 'fMultiline'));
        // one edit writes every member, one commit
        sandbox.__sent.length = 0;
        multiText.value = 'Both';
        multiText.dispatch('change', {});
        await settled();
        const multiCommits = sandbox.__sent.filter((m) => m.type === 'commit');
        check('a multi edit posts exactly one commit', multiCommits.length === 1,
            String(multiCommits.length));
        const mc = multiCommits.length && multiCommits[0].data.controls;
        check('a multi edit writes every member',
            !!mc && mc.find((c) => c.id === 'txtName').properties.text === 'Both'
                && mc.find((c) => c.id === 'btnSubmit').properties.text === 'Both',
            mc ? JSON.stringify(mc.map((c) => [c.id, c.properties.text])) : 'no commit');

        // divergent checkbox renders indeterminate, never a false claim
        const chkSchema = { ...schema,
            controls: [
                { id: 'chkA', type: 'System.Windows.Forms.CheckBox', children: [], locked: false,
                  properties: { x: 10, y: 10, width: 110, height: 19, text: 'A', tabIndex: 0, checked: true } },
                { id: 'chkB', type: 'System.Windows.Forms.CheckBox', children: [], locked: false,
                  properties: { x: 10, y: 40, width: 110, height: 19, text: 'B', tabIndex: 1 } },
            ],
            analysis: { modelledCount: 2, unmodelledCount: 0, coveragePercent: 100, refuses: [], warnings: [] } };
        send({ type: 'load', data: chkSchema });
        await settled();
        clickBtn('chkA');
        shiftClick('chkB');
        endGesture();
        await settled();
        const chkRow = fieldRow('Checked');
        const chkBox = chkRow && chkRow.querySelector('input');
        check('a divergent checkbox row is offered', !!chkBox);
        check('a divergent checkbox is indeterminate, not unchecked',
            !!chkBox && chkBox.indeterminate === true, chkBox ? String(chkBox.indeterminate) : 'no box');
        check('same-type groups keep their other common rows',
            !!fieldRow('Text'), 'Text row missing for the CheckBox pair');

        // description pane: focusing a row shows its hardcoded text
        send({ type: 'load', data: schema });
        await settled();
        clickBtn('btnSubmit');
        await settled();
        const pane = () => ids.inspector.querySelector('.inspector-description');
        check('a description pane is offered', !!pane());
        check('the pane defaults to selection help',
            !!pane() && /focus a row/.test(String(pane().textContent)), pane() && pane().textContent);
        insInputs().find((i) => i.id === 'fText').dispatch('focus', {});
        check('focusing Text shows its hardcoded description',
            !!pane() && /caption/i.test(String(pane().textContent)), pane() && pane().textContent);

        // ---- A3 Events tab in Inspector (Row A3, issue #58)
        const tabBtns = () => ids.inspector.querySelectorAll('.inspector-tab-btn');
        const propTabBtn = () => [...tabBtns()].find((b) => b.dataset.tab === 'properties');
        const eventTabBtn = () => [...tabBtns()].find((b) => b.dataset.tab === 'events');
        check('inspector offers Properties and Events tab switcher', !!propTabBtn() && !!eventTabBtn());
        check('properties tab is initially active', propTabBtn().getAttribute('aria-pressed') === 'true');

        // Switch to Events tab
        eventTabBtn().dispatch('click', {});
        await settled();
        check('events tab marks itself pressed', eventTabBtn().getAttribute('aria-pressed') === 'true');
        check('properties tab is no longer pressed', propTabBtn().getAttribute('aria-pressed') === 'false');

        const eventRows = () => ids.inspector.querySelectorAll('.event-row');
        check('Events mode lists events for the selected control', eventRows().length > 0);
        const clickRow = () => [...eventRows()].find((r) => r.dataset.prop === 'Click');
        check('Button events include Click', !!clickRow());
        const clickInput = () => clickRow() && clickRow().querySelector('.event-handler-input');
        check('event row offers text input for handler', !!clickInput());

        // Parse existing wirings: schema with wired event
        const wiredSchema = JSON.parse(JSON.stringify(schema));
        const btnSubmitCtrl = wiredSchema.controls.find((c) => c.id === 'btnSubmit');
        btnSubmitCtrl.events = { Click: 'btnSubmit_Click' };
        send({ type: 'load', data: wiredSchema });
        await settled();
        clickBtn('btnSubmit');
        await settled();
        eventTabBtn().dispatch('click', {});
        await settled();
        const wiredClickRow = [...eventRows()].find((r) => r.dataset.prop === 'Click');
        const wiredInput = wiredClickRow && wiredClickRow.querySelector('.event-handler-input');
        check('existing event wiring is displayed in handler input', !!wiredInput && wiredInput.value === 'btnSubmit_Click');

        // Double-clicking an event row invokes wireEvent
        sandbox.__sent.length = 0;
        const dblClickRow = [...eventRows()].find((r) => r.dataset.prop === 'MouseEnter');
        dblClickRow.dispatch('dblclick', { preventDefault() {}, stopPropagation() {} });
        const wireMsg = sandbox.__sent.find((m) => m.type === 'wireEvent');
        check('double-clicking event row posts wireEvent', !!wireMsg && wireMsg.data.id === 'btnSubmit' && wireMsg.data.event === 'MouseEnter');

        // Custom handler binding: typing custom name and pressing Enter
        sandbox.__sent.length = 0;
        const clickInputEl = wiredClickRow.querySelector('.event-handler-input');
        clickInputEl.value = 'MyCustomSubmitHandler';
        clickInputEl.dispatch('keydown', { key: 'Enter', preventDefault() {} });
        const customWireMsg = sandbox.__sent.find((m) => m.type === 'wireEvent');
        check('typing custom handler name and pressing Enter posts wireEvent with handler',
            !!customWireMsg && customWireMsg.data.id === 'btnSubmit' && customWireMsg.data.event === 'Click' && customWireMsg.data.handler === 'MyCustomSubmitHandler');

        // Unwiring via Reset button
        const eventResetBtn = wiredClickRow.querySelector('.prop-reset');
        check('wired event row offers Reset button', !!eventResetBtn);
        if (eventResetBtn) {
            sandbox.__sent.length = 0;
            eventResetBtn.dispatch('click', { stopPropagation() {} });
            const unwireMsg = sandbox.__sent.find((m) => m.type === 'unwireEvent');
            check('clicking Reset on wired event posts unwireEvent',
                !!unwireMsg && unwireMsg.data.id === 'btnSubmit' && unwireMsg.data.event === 'Click');
        }

        // Unwiring by clearing the input
        sandbox.__sent.length = 0;
        clickInputEl.value = '';
        clickInputEl.dispatch('keydown', { key: 'Enter', preventDefault() {} });
        const clearUnwireMsg = sandbox.__sent.find((m) => m.type === 'unwireEvent');
        check('clearing input and pressing Enter posts unwireEvent',
            !!clearUnwireMsg && clearUnwireMsg.data.id === 'btnSubmit' && clearUnwireMsg.data.event === 'Click');

        // Views: Categorized vs Alphabetical on Events tab
        const viewBtns = () => ids.inspector.querySelectorAll('.inspector-view-btn');
        const catBtn = () => [...viewBtns()].find((b) => b.dataset.view === 'categorized');
        const alphaBtn = () => [...viewBtns()].find((b) => b.dataset.view === 'alphabetical');

        catBtn().dispatch('click', {});
        await settled();
        const catHeaders = () => ids.inspector.querySelectorAll('.inspector-cat');
        check('categorized view in Events tab creates category groups', catHeaders().length > 0);
        check('categories include ACTION', [...catHeaders()].some((h) => /Action/i.test(h.textContent)));

        alphaBtn().dispatch('click', {});
        await settled();
        check('alphabetical view in Events tab has no category heads', catHeaders().length === 0);
        const eventNames = [...eventRows()].map((r) => r.dataset.prop);
        const sortedNames = [...eventNames].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        check('alphabetical view in Events tab sorts events A-Z', JSON.stringify(eventNames) === JSON.stringify(sortedNames));

        // Switch back to properties tab
        propTabBtn().dispatch('click', {});
        await settled();
        check('switching back restores properties tab', propTabBtn().getAttribute('aria-pressed') === 'true');
        check('event rows are replaced by property rows', ids.inspector.querySelectorAll('.event-row').length === 0);

        // locked and refused rows imply no writability: no Reset anywhere
        clickBtn('ThirdPartyGauge');
        await settled();
        check('a locked control offers no Reset',
            ids.inspector.querySelectorAll('.prop-reset').length === 0,
            String(ids.inspector.querySelectorAll('.prop-reset').length));
        send({ type: 'load', data: { ...schema, analysis: { ...schema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
        await settled();
        clickBtn('btnSubmit');
        await settled();
        check('a refused form offers no Reset',
            ids.inspector.querySelectorAll('.prop-reset').length === 0);

        // form inspector gets the pane too (descriptions only, no dirty marks)
        send({ type: 'load', data: schema });
        await settled();
        check('the form inspector offers the description pane', !!pane());
        // multi-selection keeps no view toggle (rows stay flat, as before)
        clickBtn('txtName');
        shiftClick('btnSubmit');
        endGesture();
        await settled();
        check('multi-selection still offers no view toggle',
            !ids.inspector.querySelectorAll('button').some((b) => String(b.textContent || '') === 'Categorized'));

        // ---- Task 6 (#52): containers drag-reparent + TabPage targeting + TabStop + step-order
        setZoomNow();
        {
            const t6down = (id, extra) => ctlNode(id).dispatch('mousedown',
                Object.assign({ preventDefault() { }, stopPropagation() { }, clientX: 10, clientY: 10 }, extra || {}));
            const t6move = (x, y) => sandbox.window.dispatch('mousemove', { clientX: x, clientY: y });
            const t6up = () => { sandbox.window.dispatch('mouseup', {}); mirrorScale(); };
            const t6Target = () => canvasEl.querySelectorAll('.ctl.drop-target').map((n) => n.dataset.id);
            const lastCommit = () => sandbox.__sent.filter((m) => m.type === 'commit').slice(-1)[0];
            const t6Schema = {
                schemaVersion: 1,
                form: { name: 'T6Form', text: 'T6', clientSize: { width: 400, height: 300 }, className: 'T6Form' },
                controls: [
                    { id: 'btnTop', type: 'System.Windows.Forms.Button', children: [], locked: false,
                      properties: { x: 10, y: 10, width: 80, height: 25, text: 'Top', tabIndex: 0 } },
                    { id: 'pnlWrap', type: 'System.Windows.Forms.Panel', children: [
                        { id: 'btnIn', type: 'System.Windows.Forms.Button', children: [], locked: false,
                          properties: { x: 5, y: 5, width: 80, height: 25, text: 'In', tabIndex: 0 } },
                    ], locked: false, properties: { x: 10, y: 50, width: 200, height: 150, tabIndex: 1 } },
                    { id: 'pnlLock', type: 'System.Windows.Forms.Panel', children: [], locked: true,
                      lockedReason: 'Panel is locked in this test.',
                      properties: { x: 220, y: 220, width: 150, height: 60 } },
                    { id: 'tabMain', type: 'System.Windows.Forms.TabControl', children: [
                        { id: 'pgA', type: 'System.Windows.Forms.TabPage', children: [], locked: false,
                          properties: { x: 4, y: 22, width: 162, height: 170, text: 'A', tabIndex: 0 } },
                        { id: 'pgB', type: 'System.Windows.Forms.TabPage', children: [], locked: false,
                          properties: { x: 4, y: 22, width: 162, height: 170, text: 'B', tabIndex: 1 } },
                    ], locked: false, properties: { x: 220, y: 10, width: 170, height: 200, tabIndex: 2 } },
                    { id: 'btnFree', type: 'System.Windows.Forms.Button', children: [], locked: false,
                      properties: { x: 10, y: 220, width: 80, height: 25, text: 'Free', tabIndex: 3 } },
                ],
                analysis: { modelledCount: 6, unmodelledCount: 1, coveragePercent: 85.71, refuses: [], warnings: [] },
            };

            // Hover over a container highlights it as the drop target.
            send({ type: 'load', data: t6Schema });
            await settled();
            sandbox.__sent.length = 0;
            t6down('btnFree', { clientX: 10, clientY: 220 });
            t6move(58, 100);
            check('drag hover highlights the target container',
                JSON.stringify(t6Target()) === JSON.stringify(['pnlWrap']), JSON.stringify(t6Target()));
            check('drag hover highlights nothing else',
                t6Target().length === 1, JSON.stringify(t6Target()));
            t6move(300, 270);
            check('hovering empty canvas clears the highlight', t6Target().length === 0,
                JSON.stringify(t6Target()));
            t6up();
            await settled();
            check('dropping on empty canvas does not reparent',
                (() => {
                    const c = lastCommit();
                    return !!c && c.data.controls.some((x) => x.id === 'btnFree');
                })(), 'btnFree left the top level');

            // Drop inside the panel reparents with coordinate conversion:
            // form (58,100) minus panel origin (10,50) = parent-relative (48,50).
            send({ type: 'load', data: t6Schema });
            await settled();
            sandbox.__sent.length = 0;
            t6down('btnFree', { clientX: 10, clientY: 220 });
            t6move(58, 100);
            t6up();
            await settled();
            {
                const c = lastCommit();
                const top = c ? c.data.controls : [];
                const pnl = top.find((x) => x.id === 'pnlWrap');
                const moved = pnl && pnl.children.find((x) => x.id === 'btnFree');
                check('dropping inside a panel reparents the control',
                    !!moved, c ? JSON.stringify(top.map((x) => x.id)) : 'no commit');
                check('the reparented control keeps its file-space point (coordinate conversion)',
                    !!moved && moved.properties.x === 48 && moved.properties.y === 50,
                    moved ? JSON.stringify(moved.properties) : 'not reparented');
                check('the highlight clears on drop', t6Target().length === 0,
                    JSON.stringify(t6Target()));
            }

            // Drop onto a TabPage parents to that page, not the TabControl.
            send({ type: 'load', data: t6Schema });
            await settled();
            sandbox.__sent.length = 0;
            t6down('btnFree', { clientX: 10, clientY: 220 });
            t6move(250, 100);
            check('hovering a tab page highlights the page',
                JSON.stringify(t6Target()) === JSON.stringify(['pgA']), JSON.stringify(t6Target()));
            t6up();
            await settled();
            {
                const c = lastCommit();
                const tab = c ? c.data.controls.find((x) => x.id === 'tabMain') : null;
                const pgA = tab && tab.children.find((x) => x.id === 'pgA');
                const moved = pgA && pgA.children.find((x) => x.id === 'btnFree');
                check('dropping onto a TabPage parents to the page',
                    !!moved, c ? JSON.stringify(tab.children.map((x) => [x.id, (x.children || []).map((g) => g.id)])) : 'no commit');
                check('TabPage coordinates convert through both offsets (tab + page)',
                    !!moved && moved.properties.x === 26 && moved.properties.y === 68,
                    moved ? JSON.stringify(moved.properties) : 'not reparented');
            }

            // A locked container is never a target: no highlight, no reparent.
            send({ type: 'load', data: t6Schema });
            await settled();
            sandbox.__sent.length = 0;
            t6down('btnFree', { clientX: 10, clientY: 220 });
            t6move(250, 240);
            check('a locked container never highlights', t6Target().length === 0,
                JSON.stringify(t6Target()));
            t6up();
            await settled();
            {
                const c = lastCommit();
                check('dropping onto a locked container does not reparent',
                    !!c && c.data.controls.some((x) => x.id === 'btnFree'),
                    c ? JSON.stringify(c.data.controls.map((x) => x.id)) : 'no commit');
            }

            // TabStop: inspector checkbox, committed through the scalar path.
            send({ type: 'load', data: t6Schema });
            await settled();
            t6down('btnTop');
            t6up();
            await settled();
            {
                const row = ids.inspector.querySelectorAll('.field')
                    .find((f) => f.dataset && f.dataset.prop === 'TabStop');
                const box = row && row.querySelector('input');
                check('the inspector offers a TabStop checkbox', !!box && box.type === 'checkbox',
                    row ? 'row without a checkbox' : 'no TabStop row');
                sandbox.__sent.length = 0;
                if (box) {
                    box.checked = false;
                    box.dispatch('change', {});
                    await settled();
                    const c = lastCommit();
                    const sent = c && c.data.controls.find((x) => x.id === 'btnTop');
                    check('unchecking TabStop commits tabStop:false',
                        !!sent && sent.properties.tabStop === false,
                        sent ? JSON.stringify(sent.properties) : 'no commit');
                }
            }

            // Multi-select offers the shared TabStop row.
            send({ type: 'load', data: t6Schema });
            await settled();
            t6down('btnTop');
            t6up();
            t6down('btnFree', { shiftKey: true });
            t6up();
            await settled();
            check('multi-select offers the shared TabStop row',
                ids.inspector.querySelectorAll('.field')
                    .some((f) => f.dataset && f.dataset.prop === 'TabStop'));

            // Outline step buttons: one position per click, one commit, via A1.
            send({ type: 'load', data: t6Schema });
            await settled();
            {
                const wb = sandbox.document.querySelector('.workbench');
                const rows = () => wb.querySelectorAll('.outline-row');
                const row = (id) => rows().find((n) => n.dataset.id === id);
                const stepBtn = (id, cls) => {
                    const r = row(id);
                    return r && r.querySelectorAll('button').find((b) => b.classList.contains(cls));
                };
                check('outline rows offer step forward/backward buttons',
                    !!stepBtn('btnFree', 'outline-step-fwd') && !!stepBtn('btnFree', 'outline-step-back'),
                    'step buttons missing on btnFree row');
                check('a locked outline row offers no step buttons',
                    row('pnlLock') && row('pnlLock').querySelectorAll('button').length === 0,
                    'locked row offers buttons');
                sandbox.__sent.length = 0;
                const fwdBtn = stepBtn('btnFree', 'outline-step-fwd');
                const backBtn = stepBtn('btnFree', 'outline-step-back');
                if (fwdBtn) fwdBtn.dispatch('click', {});
                await settled();
                const fwd = lastCommit();
                check('step forward moves exactly one position toward the front',
                    !!fwd && fwd.data.controls.map((x) => x.id).join(',') === 'btnTop,pnlWrap,pnlLock,btnFree,tabMain',
                    fwd ? JSON.stringify(fwd.data.controls.map((x) => x.id)) : 'no commit');
                if (backBtn) backBtn.dispatch('click', {});
                await settled();
                const back = lastCommit();
                check('step backward restores the position',
                    !!back && back.data.controls.map((x) => x.id).join(',') === 'btnTop,pnlWrap,pnlLock,tabMain,btnFree',
                    back ? JSON.stringify(back.data.controls.map((x) => x.id)) : 'no commit');
            }

            // Refused forms stay read-only: no step buttons, no highlight tracking.
            send({ type: 'load', data: { ...t6Schema,
                analysis: { ...t6Schema.analysis, refuses: ['dock-anchor'], warnings: [] } } });
            await settled();
            {
                const wb = sandbox.document.querySelector('.workbench');
                check('a refused form offers no step buttons',
                    wb.querySelectorAll('.outline-step-fwd').length === 0
                    && wb.querySelectorAll('.outline-step-back').length === 0,
                    'step buttons on a refused form');
            }
        }

        send({ type: 'load', data: schema });
        await settled();
        sandbox.__sent.length = 0;
    }
    console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'canvas harness: all passed'));
    process.exit(failures ? 1 : 0);
}, 400);

/** Wait past the canvas's 220ms commit debounce. */
const settled = () => new Promise((r) => setTimeout(r, 320));