#!/usr/bin/env node
/*
 * End-to-end: the exact message sequence the extension host uses, against the real engine
 * and the real canvas code. This is what proves the three components actually agree.
 *
 * Run: node test/e2e.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine/bin/Debug/net10.0/macforms-engine');
const CANVAS = path.join(ROOT, 'extension/media/canvas.js');

let failures = 0;
const check = (label, cond, detail) => {
    if (cond) console.log('  PASS  ' + label);
    else { console.log('  FAIL  ' + label + (detail ? '  <- ' + detail : '')); failures++; }
};

// ------------------------------------------------------------------ engine

function spawnEngine() {
    const child = cp.spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const waiters = new Map();
    let id = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            const w = waiters.get(msg.id);
            if (w) { waiters.delete(msg.id); w(msg); }
        }
    });
    return {
        send(req) {
            const rid = ++id;
            return new Promise((res) => {
                waiters.set(rid, res);
                child.stdin.write(JSON.stringify({ id: rid, ...req }) + '\n');
            });
        },
        kill() { child.kill(); },
    };
}

// ------------------------------------------------------------------ canvas

function loadCanvas() {
    let tagSeq = 0;
    const makeEl = (tag) => {
        const el = {
            tagName: (tag || 'div').toUpperCase(),
            _uid: ++tagSeq,
            children: [], parentNode: null, dataset: {}, attrs: {},
            style: {}, _class: '', _text: '', _html: '',
            value: '', disabled: false, title: '', tabIndex: 0,
            offsetHeight: 42, offsetWidth: 300, clientWidth: 300, clientHeight: 200,
            listeners: {},
            get className() { return this._class; },
            set className(v) {
                this._class = v;
                const self = this;
                this.classList = {
                    set: new Set(String(v).split(/\s+/).filter(Boolean)),
                    add(...c) { c.forEach((x) => x && this.set.add(x)); },
                    remove(...c) { c.forEach((x) => this.set.delete(x)); },
                    contains(c) { return this.set.has(c); },
                    toggle(c, on) { on ? this.add(c) : this.remove(c); },
                    _self: self,
                };
            },
            get textContent() {
                return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
            },
            set textContent(v) { this._text = String(v); this.children = []; },
            get innerHTML() { return this._html; },
            set innerHTML(v) { this._html = v; this.children = []; },
            appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
            removeChild(c) {
                const i = this.children.indexOf(c);
                if (i >= 0) this.children.splice(i, 1);
                c.parentNode = null; return c;
            },
            insertBefore(node, ref) {
                const i = this.children.indexOf(ref);
                node.parentNode = this;
                if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
                return node;
            },
            remove() { if (this.parentNode) this.parentNode.removeChild(this); },
            querySelectorAll(sel) {
                const out = [];
                const want = sel.trim();
                const hit = (e) => want.startsWith('.') ? e.classList.contains(want.slice(1))
                    : want.startsWith('[') ? want.slice(1, -1).split('=')[0] in e.attrs
                    : e.tagName === want.toUpperCase();
                (function walk(n) {
                    for (const c of n.children) { if (hit(c)) out.push(c); walk(c); }
                })(this);
                return out;
            },
            querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
            getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; },
            addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
            removeEventListener(t, fn) {
                const l = this.listeners[t]; if (l) this.listeners[t] = l.filter((f) => f !== fn);
            },
            dispatch(type, ev) {
                const event = Object.assign({
                    preventDefault() { }, stopPropagation() { },
                    clientX: 0, clientY: 0, key: '', shiftKey: false,
                }, ev || {});
                if (!event.target) event.target = el;
                for (const fn of (this.listeners[type] || []).slice()) fn(event);
            },
            setAttribute(k, v) { this.attrs[k] = v; },
            getAttribute(k) { return this.attrs[k]; },
        };
        el.className = '';
        return el;
    };

    const ids = {};
    for (const id of ['banner', 'toolbox', 'canvas', 'inspector', 'status', 'form-title-text', 'form-size']) {
        ids[id] = makeEl();
    }
    const stage = makeEl();
    const workbench = makeEl();

    const sent = [];
    const handlers = [];
    const sandbox = {
        console, JSON, Math, Number, parseInt, parseFloat, String, Object, Array, Set, Map, isNaN,
        setTimeout, clearTimeout,
        document: {
            createElement: makeEl,
            getElementById: (id) => ids[id] || null,
            querySelector: (s) => (s === '.stage' ? stage : s === '.workbench' ? workbench : null),
            querySelectorAll: () => [],
            addEventListener() { },
        },
        window: {
            addEventListener(t, fn) { if (t === 'message') handlers.push(fn); },
            removeEventListener() { },
            setTimeout, clearTimeout,
        },
        acquireVsCodeApi: () => ({ postMessage: (m) => sent.push(m), getState() { return {}; }, setState() { } }),
    };
    sandbox.window.document = sandbox.document;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(CANVAS, 'utf8'), sandbox, { filename: CANVAS });

    return {
        ids, sent, stage, workbench,
        send: (msg) => handlers.forEach((h) => h({ data: msg })),
        find: (pred) => ids.canvas.querySelectorAll('.ctl').find(pred),
        byId: (cid) => ids.canvas.querySelectorAll('.ctl').find((c) => c.dataset.id === cid),
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------- run

(async () => {
    console.log('\n== e2e: canvas <-> extension contract <-> engine');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-e2e-'));
    const target = path.join(dir, 'SimpleDialog.Designer.cs');
    fs.copyFileSync(path.join(ROOT, 'fixtures/simple/SimpleDialog.Designer.cs'), target);
    const original = fs.readFileSync(target, 'utf8');

    const engine = spawnEngine();
    const canvas = loadCanvas();

    // 1. extension receives `parse`, forwards `load` to the canvas
    const parsed = await engine.send({ cmd: 'parse', path: target });
    check('engine parses the fixture', parsed.ok && parsed.schema, JSON.stringify(parsed).slice(0, 120));
    canvas.send({ type: 'load', data: parsed.schema });

    const rendered = canvas.ids.canvas.querySelectorAll('.ctl');
    check('canvas rendered all 5 controls', rendered.length === 5, 'got ' + rendered.length);
    check('canvas reports 100% coverage',
        /Coverage\s*100%/.test(String(canvas.ids.banner.innerHTML)),
        String(canvas.ids.banner.innerHTML).slice(0, 80));

    // 2. user selects a control and edits its Text via the inspector
    const btn = canvas.byId('btnSubmit');
    check('btnSubmit is on the canvas', !!btn);
    btn.dispatch('mousedown', {});
    const inputs = canvas.ids.inspector.querySelectorAll('input');
    check('inspector rendered fields for the selection', inputs.length >= 6, 'got ' + inputs.length);
    inputs[4].value = 'Send it';
    inputs[4].dispatch('change', {});
    await sleep(320);

    // 3. canvas posts `commit`; the host forwards it to the engine verbatim
    const commitMsg = canvas.sent.find((m) => m.type === 'commit');
    check('canvas posted a commit after the debounce', !!commitMsg);
    const gen = await engine.send({ cmd: 'generate', path: target, schema: commitMsg.data });
    check('engine accepted the canvas schema', gen.ok && gen.changed,
        JSON.stringify(gen).slice(0, 160));

    const afterEdit = fs.readFileSync(target, 'utf8');
    check('file changed on disk', afterEdit !== original);
    check('exactly one line changed',
        afterEdit.split('\n').filter((l, i) => l !== original.split('\n')[i]).length === 1,
        JSON.stringify(afterEdit.split('\n').filter((l, i) => l !== original.split('\n')[i])));
    check('the new Text is in the C#', afterEdit.includes('this.btnSubmit.Text = "Send it";'));
    check('geometry untouched by a text edit', afterEdit.includes('this.btnSubmit.Location = new System.Drawing.Point(96, 154);'));

    // 4. host posts `committed`, canvas reports it
    canvas.send({ type: 'committed', data: { changed: true } });
    check('canvas confirms the write',
        /Written to the Designer file/.test(String(canvas.ids.status.textContent)),
        String(canvas.ids.status.textContent));

    // 5. drag: model update is immediate, commit is debounced
    const txt = canvas.byId('txtName');
    canvas.sent.length = 0;
    txt.dispatch('mousedown', { clientX: 100, clientY: 100 });
    const wm = canvas.stage;
    check('mousedown did not immediately commit',
        !canvas.sent.some((m) => m.type === 'commit'));
    await sleep(320);

    // 6. re-parse reflects the write (the round-trip contract)
    const reparsed = await engine.send({ cmd: 'parse', path: target });
    const again = reparsed.schema.controls.find((c) => c.id === 'btnSubmit');
    check('re-parse returns the edited text', again.properties.text === 'Send it',
        JSON.stringify(again.properties));
    check('re-parse returns original geometry', again.properties.x === 96 && again.properties.y === 154);

    // 7. locked controls survive a commit untouched
    fs.copyFileSync(path.join(ROOT, 'fixtures/localizable/LocalizableForm.Designer.cs'),
        path.join(dir, 'LocalizableForm.Designer.cs'));
    const loc = path.join(dir, 'LocalizableForm.Designer.cs');
    const locBefore = fs.readFileSync(loc, 'utf8');
    const locParsed = await engine.send({ cmd: 'parse', path: loc });
    check('localizable form parses', locParsed.ok);
    check('localizable form refuses', locParsed.schema.analysis.refuses.includes('localizable'));
    const gauge = locParsed.schema.controls.find((c) => c.id === 'ThirdPartyGauge');
    check('third-party control is locked', gauge && gauge.locked === true);
    const locGen = await engine.send({ cmd: 'generate', path: loc, schema: locParsed.schema });
    check('engine refuses to write a refused form', locGen.ok === false, JSON.stringify(locGen));
    check('refused file is byte-identical on disk', fs.readFileSync(loc, 'utf8') === locBefore);

    engine.kill();
    fs.rmSync(dir, { recursive: true, force: true });

    console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'e2e: all passed'));
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });