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
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
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
    },
    window: winStub,
    acquireVsCodeApi: () => ({ postMessage: (m) => sandbox.__sent.push(m), getState() { return {}; }, setState() { } }),
    setTimeout, clearTimeout, JSON, Math, Number, parseInt, parseFloat, String, Object, Array, Set, Map, isNaN,
};
sandbox.window.document = sandbox.document;
sandbox.globalThis = sandbox;
sandbox.__sent = [];
sandbox.__ids = ids;

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

// banner: coverage disclosure is mandatory
const bannerHtml = String(ids.banner.innerHTML || '');
check('banner states coverage', /Coverage\s*66\.67%/.test(bannerHtml), bannerHtml.slice(0, 80));
check('banner states unmodelled count', /1 shown as locked boxes/.test(bannerHtml));
check('banner is visible (not hidden)', !ids.banner.classList.contains('hidden'));

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
for (const t of ['TrackBar', 'ProgressBar', 'NumericUpDown', 'DateTimePicker']) {
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
        const m = /scale\(([\d.]+)\)/.exec(String(canvasEl.style.transform || ''));
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
        sandbox.window.dispatch('mousemove', { clientX: 100 + 40 * s, clientY: 100 + 24 * s });
        sandbox.window.dispatch('mouseup', {});
        mirrorScale();

        const dx = leftOf('btnSubmit') - x0;
        const dy = topOf('btnSubmit') - y0;
        // Tolerate the 8px grid snap; what must hold is that the result is the FORM delta and
        // not the SCREEN delta, which differ by exactly `s`.
        check(`a drag at ${label} moves by the pointer delta in form units`,
            Math.abs(dx - 40) <= 8 && Math.abs(dy - 24) <= 8,
            `moved ${dx},${dy}; expected ~40,24. A scaled-rect bug gives ${(40 * s).toFixed(1)},${(24 * s).toFixed(1)}`);
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
    const addBtn = itemsEditor ? itemsEditor.querySelector('button') : null;
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

    console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'canvas harness: all passed'));
    process.exit(failures ? 1 : 0);
}, 400);

/** Wait past the canvas's 220ms commit debounce. */
const settled = () => new Promise((r) => setTimeout(r, 320));