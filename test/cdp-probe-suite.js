// Inside-the-extension-host half of the CDP undo probe (multi-round).
//
// Round 1: body focus + Cmd/Ctrl+Z          -> file must revert
// Round 2: .ctl focus + redo key            -> file must re-apply the edit
// Round 3: .ctl focus + Cmd/Ctrl+Z          -> file must revert again
// Round 4: inspector input focused + typed text + Cmd/Ctrl+Z (exploratory: log only)
//
// Marker protocol in os.tmpdir()/vscforms-cdp-probe, per round N:
//   probe writes READY_N (+ target path in READY_1), launcher acts, writes KEYS_SENT_N,
//   probe asserts file state, writes VERIFIED_N, launcher snapshots canvas, writes SNAP_DONE_N.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const ENGINE_BIN = path.join(EXT, 'bin');
const MARKER_DIR = path.join(os.tmpdir(), 'vscforms-cdp-probe');

function triple() {
    const o = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const a = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'x64';
    return `${o}-${a}`;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { const v = await fn(); if (v) return v; } catch { }
        await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
}
const marker = (n) => path.join(MARKER_DIR, n);

async function rpcEngine(req) {
    const { spawn } = require('child_process');
    const exe = path.join(ENGINE_BIN, triple(),
        process.platform === 'win32' ? 'vscforms-engine.exe' : 'vscforms-engine');
    return new Promise((res, rej) => {
        const c = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        c.stdout.on('data', (d) => {
            buf += d.toString();
            const nl = buf.indexOf('\n');
            if (nl >= 0) { try { c.kill(); } catch { } try { res(JSON.parse(buf.slice(0, nl))); } catch (e) { rej(e); } }
        });
        c.on('error', rej);
        c.stdin.write(JSON.stringify(req) + '\n');
        setTimeout(() => { try { c.kill(); } catch { } rej(new Error('engine timeout')); }, 10000);
    });
}

async function round(vscode, target, original, n, expectEdit) {
    fs.writeFileSync(marker(`READY_${n}`), n === 1 ? JSON.stringify({ target }) : String(n));
    await waitFor(() => fs.existsSync(marker(`KEYS_SENT_${n}`)), 90000, `launcher KEYS_SENT_${n}`);
    await sleep(2000);
    return fs.readFileSync(target, 'utf8');
}

async function run(vscode) {
    const log = (s) => console.log(s);
    let failures = 0;
    const check = (name, cond, extra) => {
        if (cond) log(`  PASS  ${name}`);
        else { failures++; log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscforms-cdp-'));
    const simple = path.join(ROOT, 'fixtures/simple/SimpleDialog.Designer.cs');
    const original = fs.readFileSync(simple, 'utf8');
    const target = path.join(dir, 'cdp.Designer.cs');
    fs.copyFileSync(simple, target);
    const duri = vscode.Uri.file(target);

    await vscode.commands.executeCommand('vscode.open', duri);
    await waitFor(() => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t && t.input instanceof vscode.TabInputCustom
            && t.input.viewType === 'vscforms.formDesigner';
    }, 15000, 'designer tab active');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await sleep(500);

    const parsed = await rpcEngine({ id: 1, cmd: 'parse', path: target });
    assert.ok(parsed.ok, 'parse failed');
    parsed.schema.controls.find((x) => x.id === 'btnSubmit').properties.x = 123;
    const changed = await vscode.commands.executeCommand(
        'vscforms._testSeam', 'commit', duri, parsed.schema);
    check('host commit reports changed', changed === true);
    await sleep(600);
    check('file on disk has edit', fs.readFileSync(target, 'utf8').includes('Point(123, 154)'));

    // R1: body focus + undo -> revert
    let disk = await round(vscode, target, original, 1);
    check('R1 body-focus undo reverts file', disk === original,
        `hasEdit=${disk.includes('Point(123, 154)')}`);
    fs.writeFileSync(marker('VERIFIED_1'), '1');
    await waitFor(() => fs.existsSync(marker('SNAP_DONE_1')), 60000, 'SNAP_DONE_1');

    // R2: launcher focuses .ctl + sends redo -> edit must come back
    disk = await round(vscode, target, original, 2);
    check('R2 node-focus redo re-applies edit', disk.includes('Point(123, 154)'));
    fs.writeFileSync(marker('VERIFIED_2'), '1');
    await waitFor(() => fs.existsSync(marker('SNAP_DONE_2')), 60000, 'SNAP_DONE_2');

    // R3: launcher focuses .ctl + sends undo -> revert again
    disk = await round(vscode, target, original, 3);
    check('R3 node-focus undo reverts file', disk === original,
        `hasEdit=${disk.includes('Point(123, 154)')}`);
    fs.writeFileSync(marker('VERIFIED_3'), '1');
    await waitFor(() => fs.existsSync(marker('SNAP_DONE_3')), 60000, 'SNAP_DONE_3');

    // R4: exploratory — input focused, typed text, undo. Log only.
    disk = await round(vscode, target, original, 4);
    log('  INFO  R4 file after input-focus undo: hasEdit=' + disk.includes('Point(123, 154)'));
    fs.writeFileSync(marker('VERIFIED_4'), '1');
    await waitFor(() => fs.existsSync(marker('SNAP_DONE_4')), 60000, 'SNAP_DONE_4');

    // R5: rename via the seam, then a REAL keypress must restore BOTH files (#45).
    // Single webview only: close everything first so the canvas snapshot and the
    // keypress both land on the wired form (a second designer tab would split them).
    const wDesigner = path.join(dir, 'WiredForm.Designer.cs');
    const wBehind = path.join(dir, 'WiredForm.cs');
    fs.copyFileSync(path.join(ROOT, 'fixtures/wired/WiredForm.Designer.cs'), wDesigner);
    fs.copyFileSync(path.join(ROOT, 'fixtures/wired/WiredForm.cs'), wBehind);
    const wBefore = [fs.readFileSync(wDesigner, 'utf8'), fs.readFileSync(wBehind, 'utf8')];
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(400);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(wDesigner));
    await waitFor(() => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t && t.input instanceof vscode.TabInputCustom
            && String(t.input.uri.fsPath).endsWith('WiredForm.Designer.cs');
    }, 15000, 'wired form in designer');
    const rr = await vscode.commands.executeCommand('vscforms._testSeam', 'rename',
        { designer: wDesigner, from: 'btnCalculate', to: 'btnRenamed' });
    check('R5 seam rename accepted', rr && rr.ok === true, JSON.stringify(rr));
    await sleep(600);
    check('R5 rename rewrote designer', fs.readFileSync(wDesigner, 'utf8').includes('btnRenamed'));
    check('R5 rename rewrote code-behind', fs.readFileSync(wBehind, 'utf8').includes('btnRenamed.Enabled'));
    fs.writeFileSync(marker('READY_5'), JSON.stringify({ target: wDesigner }));
    await waitFor(() => fs.existsSync(marker('KEYS_SENT_5')), 90000, 'launcher KEYS_SENT_5');
    await sleep(2000);
    const d5 = fs.readFileSync(wDesigner, 'utf8');
    const c5 = fs.readFileSync(wBehind, 'utf8');
    check('R5 REAL keypress undo restores designer', d5 === wBefore[0]);
    check('R5 REAL keypress undo restores code-behind', c5 === wBefore[1],
        'hasNewName=' + c5.includes('btnRenamed'));
    fs.writeFileSync(marker('VERIFIED_5'), '1');
    await waitFor(() => fs.existsSync(marker('SNAP_DONE_5')), 60000, 'SNAP_DONE_5');

    log(`cdp probe done: ${failures} failure(s)`);
    return { failures };
}

module.exports = { run };
