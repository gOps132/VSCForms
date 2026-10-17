// In-extension-host runner for UX canvas capture.
// Sets up editor with fixture form, coordinates theme switches with launcher via marker files.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const MARKER_DIR = path.join(os.tmpdir(), 'vscforms-ux-capture');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { const v = await fn(); if (v) return v; } catch { }
        await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
}

async function run(vscode) {
    const fixtureRel = process.env.VSCFORMS_UX_FIXTURE || 'fixtures/wired/WiredForm.Designer.cs';
    const fixturePath = path.isAbsolute(fixtureRel) ? fixtureRel : path.join(ROOT, fixtureRel);
    if (!fs.existsSync(fixturePath)) {
        throw new Error(`Fixture file not found: ${fixturePath}`);
    }

    // Work on a temporary copy to protect fixture state
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscforms-ux-work-'));
    const target = path.join(tmpDir, path.basename(fixturePath));
    fs.copyFileSync(fixturePath, target);

    // If there is an adjacent .cs file (e.g. Form1.cs), copy it too so project references resolve
    const codeBehind = fixturePath.replace(/\.Designer\.cs$/i, '.cs');
    if (fs.existsSync(codeBehind)) {
        fs.copyFileSync(codeBehind, path.join(tmpDir, path.basename(codeBehind)));
    }

    const duri = vscode.Uri.file(target);
    console.log(`[ux-suite] Opening fixture in designer: ${target}`);
    await vscode.commands.executeCommand('vscode.open', duri);

    await waitFor(() => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t && t.input instanceof vscode.TabInputCustom
            && t.input.viewType === 'vscforms.formDesigner';
    }, 30000, 'designer tab active');

    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await sleep(500);

    // Dark Theme Phase
    console.log('[ux-suite] Switching to Dark Modern theme...');
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Dark Modern', vscode.ConfigurationTarget.Global);
    await sleep(1200);
    fs.writeFileSync(path.join(MARKER_DIR, 'READY_DARK'), JSON.stringify({ target, fixture: fixtureRel }));

    console.log('[ux-suite] Waiting for launcher to capture dark theme...');
    await waitFor(() => fs.existsSync(path.join(MARKER_DIR, 'CAPTURED_DARK')), 60000, 'CAPTURED_DARK');

    // Light Theme Phase
    console.log('[ux-suite] Switching to Light Modern theme...');
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Light Modern', vscode.ConfigurationTarget.Global);
    await sleep(1500);
    fs.writeFileSync(path.join(MARKER_DIR, 'READY_LIGHT'), '1');

    console.log('[ux-suite] Waiting for launcher to capture light theme...');
    await waitFor(() => fs.existsSync(path.join(MARKER_DIR, 'CAPTURED_LIGHT')), 60000, 'CAPTURED_LIGHT');

    // Reset back to Dark Modern for clean state
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Dark Modern', vscode.ConfigurationTarget.Global);
    await sleep(500);

    console.log('[ux-suite] Capture run completed successfully.');
    fs.writeFileSync(path.join(MARKER_DIR, 'DONE'), '1');
}

module.exports = { run };
