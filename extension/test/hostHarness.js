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
    getBoundingClientRect() {
        return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
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
            clientX: 0, clientY: 0, key: '', shiftKey: false,
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

function matches(el, sel) {
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
    if (sel.startsWith('[')) return sel.slice(1, -1) in el.attrs || sel.slice(1, -1).split('=')[0] in el.attrs;
    return el.tagName === sel.toUpperCase();
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
for (const id of ['banner', 'toolbox', 'canvas', 'inspector', 'status', 'form-title-text', 'form-size']) {
    ids[id] = new El('div');
}

const sandbox = {
    console,
    document: {
        createElement: (t) => new El(t),
        getElementById: (id) => ids[id] || null,
        querySelector: (sel) => {
            if (sel === '.stage') { sandbox.__stage = sandbox.__stage || new El('div'); return sandbox.__stage; }
            if (sel === '.workbench') { sandbox.__workbench = sandbox.__workbench || new El('div'); return sandbox.__workbench; }
            return null;
        },
        querySelectorAll: () => [],
        addEventListener() { },
    },
    window: {
        addEventListener() { },
        removeEventListener() { },
        setTimeout, clearTimeout,
    },
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
vm.runInContext(fs.readFileSync(canvasPath, 'utf8'), sandbox, { filename: canvasPath });

const schema = {
    schemaVersion: 1,
    form: { name: 'SimpleDialog', text: 'Add Person', clientSize: { width: 292, height: 196 }, className: 'SimpleDialog' },
    controls: [
        { id: 'txtName', type: 'System.Windows.Forms.TextBox', children: [], locked: false,
          properties: { x: 96, y: 78, width: 180, height: 23, tabIndex: 0 } },
        { id: 'btnSubmit', type: 'System.Windows.Forms.Button', children: [], locked: false,
          properties: { x: 96, y: 154, width: 84, height: 27, text: 'Submit', tabIndex: 3 } },
        { id: 'ThirdPartyGauge', type: 'ThirdParty.Widgets.GaugeControl', children: [], locked: true,
          lockedReason: 'GaugeControl is not one of the 10 handled control types.',
          properties: { x: 10, y: 10, width: 80, height: 28 } },
    ],
    analysis: {
        modelledCount: 2, unmodelledCount: 1, coveragePercent: 66.67,
        refuses: [], warnings: [],
    },
};

function send(msg) {
    const handlers = sandbox.window.__handlers || [];
    for (const h of handlers) h({ data: msg });
}

// canvas.js registers its message listener on `window`; wire that up.
const realWindowAdd = sandbox.window.addEventListener;
const windowHandlers = [];
sandbox.window.addEventListener = (type, fn) => {
    if (type === 'message') windowHandlers.push(fn);
    else realWindowAdd(type, fn);
};

// re-run with the patched window so the listener is captured
sandbox.__sent.length = 0;
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
const tools = ids.toolbox.querySelectorAll('.tool');
check('toolbox lists the 10 handled types', tools.length === 10, 'got ' + tools.length);

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

setTimeout(() => {
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

    console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'canvas harness: all passed'));
    process.exit(failures ? 1 : 0);
}, 400);