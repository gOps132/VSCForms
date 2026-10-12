#!/usr/bin/env node
// Launcher: 4-round CDP undo/redo probe with live canvas snapshots.
// Run: node test/run-cdp-probe.js   (needs a display; macOS is fine)
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const MARKER_DIR = path.join(os.tmpdir(), 'vscforms-cdp-probe');
const PORT = 9333;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForFile(p, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (fs.existsSync(p)) return true;
        await sleep(250);
    }
    throw new Error(`timed out waiting for ${label} (${p})`);
}
const marker = (n) => path.join(MARKER_DIR, n);

async function main() {
    if (!fs.existsSync(path.join(EXT, 'out', 'extension.js'))) {
        console.error('extension not compiled — run: (cd extension && npm run compile)');
        process.exit(1);
    }
    fs.rmSync(MARKER_DIR, { recursive: true, force: true });
    fs.mkdirSync(MARKER_DIR, { recursive: true });

    const { runTests } = require(path.join(EXT, 'node_modules/@vscode/test-electron'));
    const D = require('./cdp-driver.js');

    console.log('launching VS Code (remote-debugging-port=%d)…', PORT);
    const testPromise = runTests({
        extensionDevelopmentPath: [EXT],
        extensionTestsPath: path.resolve(__dirname, 'cdp-probe-index.js'),
        launchArgs: [
            path.join(ROOT, 'fixtures'),
            '--disable-extensions',
            '--disable-gpu',
            '--no-sandbox',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-workspace-trust',
            '--disable-telemetry',
            '--disable-crash-reporter',
            '--disable-updates',
            '--disable-workspace-notification-center',
            '--disable-notifications',
            '--disable-remote-explorer',
            '--disable-sync',
            `--remote-debugging-port=${PORT}`,
        ],
    });
    testPromise.then(
        (code) => console.log('\nVS Code exited with code ' + code),
        (e) => console.error('\ntest host error: ' + (e && e.message || e)),
    );

    let snapFailures = 0;
    try {
        // ---- R1: body focus + undo
        await waitForFile(marker('READY_1'), 120000, 'READY_1');
        await sleep(800);
        console.log('R1 canvas pre-undo:  ' + await D.snapshotCanvas(PORT));
        await D.sendUndo(PORT);
        fs.writeFileSync(marker('KEYS_SENT_1'), '1');
        await waitForFile(marker('VERIFIED_1'), 120000, 'VERIFIED_1');
        const after1 = await D.snapshotCanvas(PORT);
        console.log('R1 canvas post-undo: ' + after1);
        if (!/btnSubmit@96px/.test(after1)) { snapFailures++; console.log('R1 CANVAS-STALE'); }
        fs.writeFileSync(marker('SNAP_DONE_1'), '1');

        // ---- R2: focus a control node + redo
        await waitForFile(marker('READY_2'), 120000, 'READY_2');
        console.log('R2 focus: ' + await D.focusCanvas(PORT, '#canvas .ctl'));
        console.log('R2 canvas pre-redo:  ' + await D.snapshotCanvas(PORT));
        await D.sendRedo(PORT);
        fs.writeFileSync(marker('KEYS_SENT_2'), '1');
        await waitForFile(marker('VERIFIED_2'), 120000, 'VERIFIED_2');
        const after2 = await D.snapshotCanvas(PORT);
        console.log('R2 canvas post-redo: ' + after2);
        if (!/btnSubmit@123px/.test(after2)) { snapFailures++; console.log('R2 CANVAS-STALE'); }
        fs.writeFileSync(marker('SNAP_DONE_2'), '1');

        // ---- R3: focus a control node + undo
        await waitForFile(marker('READY_3'), 120000, 'READY_3');
        console.log('R3 focus: ' + await D.focusCanvas(PORT, '#canvas .ctl'));
        await D.sendUndo(PORT);
        fs.writeFileSync(marker('KEYS_SENT_3'), '1');
        await waitForFile(marker('VERIFIED_3'), 120000, 'VERIFIED_3');
        const after3 = await D.snapshotCanvas(PORT);
        console.log('R3 canvas post-undo: ' + after3);
        if (!/btnSubmit@96px/.test(after3)) { snapFailures++; console.log('R3 CANVAS-STALE'); }
        fs.writeFileSync(marker('SNAP_DONE_3'), '1');

        // ---- R4: exploratory — inspector filter input focused, typed text, undo
        await waitForFile(marker('READY_4'), 120000, 'READY_4');
        console.log('R4 focus: ' + await D.focusCanvas(PORT, '#inspector-filter'));
        await D.insertText(PORT, 'zzz');
        console.log('R4 input after typing: ' + await D.readInput(PORT, '#inspector-filter'));
        await D.sendUndo(PORT);
        fs.writeFileSync(marker('KEYS_SENT_4'), '1');
        await waitForFile(marker('VERIFIED_4'), 120000, 'VERIFIED_4');
        console.log('R4 input after undo:   ' + await D.readInput(PORT, '#inspector-filter'));
        console.log('R4 canvas post-undo: ' + await D.snapshotCanvas(PORT));
        fs.writeFileSync(marker('SNAP_DONE_4'), '1');

        // ---- R5: rename + REAL keypress must restore both files (#45)
        await waitForFile(marker('READY_5'), 120000, 'READY_5');
        await sleep(800);
        const pre5 = await D.snapshotCanvas(PORT);
        console.log('R5 canvas pre-undo:  ' + pre5);
        if (!/btnRenamed/.test(pre5)) { snapFailures++; console.log('R5 CANVAS-MISSING-RENAMED-ID'); }
        await D.sendUndo(PORT);
        fs.writeFileSync(marker('KEYS_SENT_5'), '1');
        await waitForFile(marker('VERIFIED_5'), 120000, 'VERIFIED_5');
        const post5 = await D.snapshotCanvas(PORT);
        console.log('R5 canvas post-undo: ' + post5);
        if (!/btnCalculate@/.test(post5) || /btnRenamed/.test(post5)) { snapFailures++; console.log('R5 CANVAS-STALE'); }
        fs.writeFileSync(marker('SNAP_DONE_5'), '1');

        const code = await testPromise;
        console.log(snapFailures ? `\nRESULT: ${snapFailures} canvas snapshot mismatch(es)` : '\nRESULT: all canvas snapshots match');
        process.exit(snapFailures ? 1 : code);
    } catch (e) {
        console.error('\ncdp probe driver failed: ' + (e && e.message || e));
        for (const m of ['KEYS_SENT_1', 'KEYS_SENT_2', 'KEYS_SENT_3', 'KEYS_SENT_4', 'KEYS_SENT_5']) {
            try { fs.writeFileSync(marker(m), '1'); } catch { }
        }
        const code = await testPromise.catch(() => 1);
        process.exit(typeof code === 'number' ? code : 1);
    }
}

main();
