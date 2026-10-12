// CDP key driver: trusted key events + webview DOM access for the undo probe.
// Node 22 globals only (fetch + WebSocket). No extra deps.
'use strict';

async function cdpTargets(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    if (!res.ok) throw new Error(`CDP /json -> HTTP ${res.status}`);
    return res.json();
}

function connect(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.addEventListener('open', () => resolve(ws), { once: true });
        ws.addEventListener('error', (e) => reject(new Error('CDP ws error: ' + (e.message || e.type))), { once: true });
    });
}

function makeClient(ws) {
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
            else resolve(msg.result);
        }
    });
    const send = (method, params, sessionId) => new Promise((resolve, reject) => {
        const myId = ++id;
        pending.set(myId, { resolve, reject });
        const envelope = { id: myId, method, params };
        if (sessionId) envelope.sessionId = sessionId;
        ws.send(JSON.stringify(envelope));
        setTimeout(() => {
            if (pending.has(myId)) { pending.delete(myId); reject(new Error(`CDP timeout: ${method}`)); }
        }, 8000);
    });
    return { send, close: () => ws.close() };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pageClient(port, quiet) {
    const targets = await cdpTargets(port);
    if (!quiet) console.log('CDP all targets: ' + JSON.stringify(targets.map((t) => [t.type, t.title, (t.url || '').slice(0, 100)])));
    const pages = targets.filter((t) => t.type === 'page');
    if (pages.length === 0) throw new Error('no CDP page targets');
    const ws = await connect(pages[0].webSocketDebuggerUrl);
    return makeClient(ws);
}

/** Attach to our designer webview iframe; returns {client, sessionId, close}. */
async function webviewSession(port) {
    const targets = await cdpTargets(port);
    const pages = targets.filter((t) => t.type === 'page');
    if (!pages.length) throw new Error('no page target for attach');
    const iframes = targets.filter((t) => t.type === 'iframe' && (t.url || '').startsWith('vscode-webview://'));
    if (!iframes.length) throw new Error('no webview iframe target');
    const ours = iframes.find((t) => (t.title || '').includes('gOps132.vscforms')) || iframes[0];
    const ws = await connect(pages[0].webSocketDebuggerUrl);
    const c = makeClient(ws);
    const listed = await c.send('Target.getTargets', {});
    const match = (listed.targetInfos || []).find((t) => t.targetId === ours.id)
        || (listed.targetInfos || []).find((t) => t.type === 'iframe' && (t.url || '').startsWith('vscode-webview://'));
    if (!match) { c.close(); throw new Error('webview target not in Target.getTargets'); }
    const { sessionId } = await c.send('Target.attachToTarget', { targetId: match.targetId, flatten: true });
    return { client: c, sessionId, close: () => c.close() };
}

/** Evaluate JS in the webview shell; helper reaches into the inner active-frame. */
async function webviewEval(port, innerJs) {
    const s = await webviewSession(port);
    try {
        const expr = `(() => {
            const f = document.getElementById('active-frame');
            if (!f || !f.contentDocument) return 'NOFRAME:' + !!f;
            const d = f.contentDocument;
            return (function(){ ${innerJs} })();
        })()`;
        const res = await s.client.send('Runtime.evaluate', { expression: expr, returnByValue: true }, s.sessionId);
        if (res.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
        return res.result.value;
    } finally {
        s.close();
    }
}

async function pressKey(port, spec) {
    const c = await pageClient(port, true);
    try {
        // The key must reach a focused window: poll document.hasFocus() and retry
        // bringToFront — OS activation is racy when the test app starts backgrounded.
        // Dispatching into an unfocused window is how a real keypress gets "lost".
        let focused = false;
        for (let i = 0; i < 10 && !focused; i++) {
            await c.send('Page.bringToFront', {});
            await sleep(500);
            const r = await c.send('Runtime.evaluate', { expression: 'document.hasFocus()', returnByValue: true });
            focused = r.result.value === true;
        }
        console.log('page hasFocus before key: ' + focused);
        if (!focused) throw new Error('test window never gained focus; keypress would be lost');
        await c.send('Input.dispatchKeyEvent', { ...spec, type: 'keyDown' });
        await sleep(120);
        await c.send('Input.dispatchKeyEvent', { ...spec, type: 'keyUp' });
        await sleep(400);
    } finally {
        c.close();
    }
}

const META = process.platform === 'darwin' ? 4 : 2;
const SHIFT = 8;

/** Cmd/Ctrl+Z */
async function sendUndo(port) {
    await pressKey(port, { modifiers: META, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
}

/** Cmd+Shift+Z (mac) or Ctrl+Y (win/linux) */
async function sendRedo(port) {
    if (process.platform === 'darwin') {
        await pressKey(port, { modifiers: META | SHIFT, key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
    } else {
        await pressKey(port, { modifiers: 2, key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89 });
    }
}

/** Focus a selector inside the canvas frame; returns activeElement description. */
async function focusCanvas(port, selector) {
    return webviewEval(port, `
        const el = d.querySelector(${JSON.stringify(selector)});
        if (!el) return 'MISSING:${selector}';
        el.focus();
        const a = d.activeElement;
        return 'FOCUSED:' + a.tagName + '.' + a.className + '#' + a.id;
    `);
}

/** One-line canvas summary: control count, id@left,top, status text. */
async function snapshotCanvas(port) {
    return webviewEval(port, `
        const nodes = [...d.querySelectorAll('#canvas .ctl')].map(n => n.dataset.id + '@' + n.style.left + ',' + n.style.top).join(' ');
        const st = d.getElementById('status') ? d.getElementById('status').textContent : 'NOSTATUS';
        return 'COUNT=' + d.querySelectorAll('#canvas .ctl').length + ' NODES[' + nodes + '] STATUS[' + st + ']';
    `);
}

/** Type text into the currently focused element (trusted path). */
async function insertText(port, text) {
    const c = await pageClient(port, true);
    try {
        await c.send('Input.insertText', { text });
        await sleep(300);
    } finally {
        c.close();
    }
}

/** Read .value of an input inside the canvas frame. */
async function readInput(port, selector) {
    return webviewEval(port, `
        const el = d.querySelector(${JSON.stringify(selector)});
        if (!el) return 'MISSING';
        return 'VALUE[' + el.value + ']';
    `);
}

module.exports = { sendUndo, sendRedo, focusCanvas, snapshotCanvas, insertText, readInput };
