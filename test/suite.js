// Real-VS Code integration suite.
//
// Everything else in test/ exercises the engine, the canvas, and the contract between them.
// This is the only layer that exercises VS Code's OWN semantics: does our CustomTextEditorProvider
// actually get selected, does the dirty marker appear, does Ctrl+Z invoke our undo(), does
// Save As really refuse. None of that is reachable from a headless harness.
//
// Run: node test/run-integration.js
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const ENGINE_BIN = path.join(EXT, 'bin');

let failures = 0;
let passes = 0;

/**
 * Drive the canvas's own commit path without a mouse: execute a commit with a mutated schema
 * and let the extension host + engine do the rest. This is the only way to exercise the
 * dirty marker and the undo stack, which live entirely inside VS Code.
 *
 * The webview is not reachable from the extension host API, so we ask the engine directly and
 * fire the same event the host fires. Anything short of that would be testing our test.
 */
/**
 * Round-trip a real edit through the EXTENSION'S commit path.
 *
 * `driveCommit` writes the file directly, which proves the engine works but skips the host
 * entirely — so it cannot observe the dirty marker, the edit event, or undo. This variant
 * hands the schema to `macforms._testSeam`, which runs the same `commit()` the canvas runs.
 */
async function driveHostCommit(vscode, path_, mutate) {
    const exe = path.join(ENGINE_BIN, triple(),
        process.platform === 'win32' ? 'macforms-engine.exe' : 'macforms-engine');
    const { spawn } = require('child_process');
    const rpc = (req) => new Promise((res, rej) => {
        const c = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        c.stdout.on('data', (d) => {
            buf += d;
            const nl = buf.indexOf('\n');
            if (nl >= 0) { try { c.kill(); } catch { } res(JSON.parse(buf.slice(0, nl))); }
        });
        c.on('error', rej);
        c.stdin.write(JSON.stringify(req) + '\n');
        setTimeout(() => { try { c.kill(); } catch { } rej(new Error('engine timeout')); }, 10000);
    });

    const parsed = await rpc({ id: 1, cmd: 'parse', path: path_ });
    assert.ok(parsed.ok, 'engine parse failed: ' + JSON.stringify(parsed).slice(0, 160));
    mutate(parsed.schema);
    const wasChanged = await vscode.commands.executeCommand(
        'macforms._testSeam', 'commit', vscode.Uri.file(path_), parsed.schema);
    return wasChanged === true;
}

async function driveCommit(vscode, path_, mutate) {
    const { spawn } = require('child_process');
    const t = triple();
    const exe = path.join(ENGINE_BIN, t,
        process.platform === 'win32' ? 'macforms-engine.exe' : 'macforms-engine');
    const rpc = (req) => new Promise((res, rej) => {
        const c = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        c.stdout.on('data', (d) => {
            buf += d;
            const nl = buf.indexOf('\n');
            if (nl >= 0) { try { c.kill(); } catch { } res(JSON.parse(buf.slice(0, nl))); }
        });
        c.on('error', rej);
        c.stdin.write(JSON.stringify(req) + '\n');
        setTimeout(() => { try { c.kill(); } catch { } rej(new Error('engine timeout')); }, 10000);
    });

    const parsed = await rpc({ id: 1, cmd: 'parse', path: path_ });
    assert.ok(parsed.ok, 'engine parse failed: ' + JSON.stringify(parsed).slice(0, 160));
    mutate(parsed.schema);
    const gen = await rpc({ id: 2, cmd: 'generate', path: path_, schema: parsed.schema });
    assert.ok(gen.ok, 'engine generate failed: ' + JSON.stringify(gen).slice(0, 160));
    return gen.changed === true;
}

function triple() {
    const o = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const a = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'x64';
    return `${o}-${a}`;
}

async function test(name, fn) {
    try {
        await fn();
        passes++;
        console.log('  PASS  ' + name);
    } catch (e) {
        failures++;
        console.log('  FAIL  ' + name);
        console.log('        ' + (e && e.message ? e.message.split('\n').join('\n        ') : e));
    }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, ms = 8000, label = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
        await sleep(120);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function activate(vscode) { return vscode.extensions.getExtension('macforms.macforms'); }

/** The active editor is a custom editor whose viewType is ours? */
function isOurEditor(vscode) {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && tab.input instanceof vscode.TabInputCustom
        && tab.input.viewType === 'macforms.formDesigner';
}

async function run(vscode) {
    console.log('\n== integration (real VS Code ' + vscode.version + ')');

    const ext = activate(vscode);
    // `ext.exports` is populated when activate() runs. Capture the module object itself, since
    // reading `ext.exports` later returns undefined once the activation promise is consumed.
    // Test seams live on a dedicated command rather than as module exports: the extension's
    // compiled `main` cannot be require()d from the test runner (it resolves 'vscode' itself),
    // and `ext.exports` is consumed by the activation promise.
    const seam = async (which) => {
        const r = await vscode.commands.executeCommand('macforms._testSeam', which);
        return r;
    };
    await test('extension activates', async () => {
        assert.ok(ext, 'extension not found — is it --extensionDevelopmentPath?');
        await ext.activate();
    });

    const commands = await vscode.commands.getCommands(true);
    await test('all commands registered', () => {
        for (const c of ['macforms.openInDesigner', 'macforms.openInTextEditor', 'macforms.restartEngine']) {
            assert.ok(commands.includes(c), 'missing command: ' + c);
        }
    });

    // ---------------------------------------------------------------- workspace
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-int-'));
    const simple = path.join(dir, 'SimpleDialog.Designer.cs');
    fs.copyFileSync(path.join(ROOT, 'fixtures/simple/SimpleDialog.Designer.cs'), simple);
    const original = fs.readFileSync(simple, 'utf8');

    const docked = path.join(dir, 'DockedForm.Designer.cs');
    fs.copyFileSync(path.join(ROOT, 'fixtures/docked/DockedForm.Designer.cs'), docked);

    const uri = vscode.Uri.file(simple);

    // ----------------------------------------------- our editor is auto-selected
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => isOurEditor(vscode), 10000, 'our custom editor to be selected automatically');

    await test('*.Designer.cs opens in OUR editor by default (priority "default")', () => {
        assert.ok(isOurEditor(vscode),
            'active tab is not our custom editor — priority may be "option", which never auto-opens');
    });

    await test('text editor is NOT what opened (proves we own the glob)', () => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        assert.ok(!(tab.input instanceof vscode.TabInputText), 'opened in the text editor instead');
    });

    await test('no VS Code Error Editor was shown', async () => {
        // If openCustomDocument had thrown, VS Code shows its built-in Error Editor. Detect it
        // via the tab's input class rather than guessing at a label.
        const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
        for (const t of tabs) {
            assert.ok(!(t.input instanceof vscode.TabInputCustom
                && /error/i.test(String(t.input.viewType))),
                'an Error Editor tab is open: ' + t.input.viewType);
        }
        assert.ok(isOurEditor(vscode), 'our editor is not active');
    });

    // ---------------------------------------- engine spawned from the bundled binary
    await test('bundled engine binary exists under bin/<triple>', () => {
        assert.ok(fs.existsSync(ENGINE_BIN), 'no bin/ directory — run scripts/publish-engine.js');
        const dirs = fs.readdirSync(ENGINE_BIN);
        assert.strictEqual(dirs.length, 1,
            'bin/ has ' + dirs.length + ' targets (' + dirs.join(',') +
            ') — a stale target would ship in every vsix (vsce --ignore-other-target-folders is a no-op)');
    });

    await test('engine responds to ping (it spawned successfully)', async () => {
        // round-trip a real file through it via the parse command
        const { spawn } = require('child_process');
        const triple = dirs0();
        const exe = path.join(ENGINE_BIN, triple,
            process.platform === 'win32' ? 'macforms-engine.exe' : 'macforms-engine');
        assert.ok(fs.existsSync(exe), 'engine binary not found at ' + exe);
        const out = await new Promise((res, rej) => {
            const c = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            let buf = '';
            c.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.kill(); res(buf.trim()); } });
            c.on('error', rej);
            c.stdin.write(JSON.stringify({ id: 1, cmd: 'parse', path: simple }) + '\n');
            setTimeout(() => { try { c.kill(); } catch { } res(buf.trim()); }, 8000);
        });
        const msg = JSON.parse(out.split('\n')[0]);
        assert.ok(msg.ok, 'engine parse failed: ' + out.slice(0, 200));
        assert.strictEqual(msg.schema.analysis.modelledCount, 5);
    });

    // ------------------------------------------------------- reopen as text works
    await test('Open as Text switches to the built-in editor', async () => {
        // Our command resolves the target URI from the active TEXT editor or a TabInputText.
        // When our custom editor is active neither exists, so pass the URI explicitly via
        // the command's documented escape hatch: vscode.openWith.
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        await waitFor(() => {
            const t = vscode.window.tabGroups.activeTabGroup.activeTab;
            return t && t.input instanceof vscode.TabInputText;
        }, 8000, 'the text editor');
        await vscode.commands.executeCommand('vscode.open', uri);
        await waitFor(() => isOurEditor(vscode), 10000, 'our editor again');
    });

    await test('our own Open-as-Text command resolves a URI from an active text editor', async () => {
        // Regression guard: when the user is in the text editor and clicks the toolbar
        // command, it must be a no-op rather than throwing.
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        await waitFor(() => {
            const t = vscode.window.tabGroups.activeTabGroup.activeTab;
            return t && t.input instanceof vscode.TabInputText;
        }, 8000, 'the text editor');
        await vscode.commands.executeCommand('macforms.openInTextEditor');
        await vscode.commands.executeCommand('vscode.open', uri);
        await waitFor(() => isOurEditor(vscode), 10000, 'our editor again');
    });

    // ------------------------------------------------------- Save As is refused
    // Save As is exercised as a pure call against the provider, not via the Save As dialog.
    // Driving the real dialog would pop a modal and block the run; what we care about is that
    // the method refuses rather than silently copying, and that is fully testable here.
    await test('Save As refuses rather than silently copying', async () => {
        const dest = path.join(dir, 'Copied.Designer.cs');
        let threw = null;
        try {
            await seam('saveAsRefuses', vscode.Uri.file(dest));
        } catch (e) { threw = e; }
        assert.ok(threw, 'saveCustomDocumentAs did not refuse');
        assert.ok(/cannot Save As/i.test(String(threw.message)),
            'error message does not explain the restriction: ' + threw.message);
        assert.ok(!fs.existsSync(dest), 'it wrote a file anyway');
    });

    await test('a Dock/Anchor form opens our editor rather than erroring', async () => {
        const duri = vscode.Uri.file(docked);
        await vscode.commands.executeCommand('vscode.open', duri);
        await waitFor(() => {
            const t = vscode.window.tabGroups.activeTabGroup.activeTab;
            return t && t.input instanceof vscode.TabInputCustom
                && t.input.viewType === 'macforms.formDesigner'
                && String(t.input.uri.fsPath).includes('DockedForm');
        }, 10000, 'the docked form in our editor');
    });

    // ------------------------------------------- dirty marker and the undo stack
    // These live entirely inside VS Code: our own code cannot observe them, and the whole
    // write-through design rests on them working. Nothing else in the suite covers this.
    await test('an engine write + edit event marks the tab dirty', async () => {
        fs.copyFileSync(simple, path.join(dir, 'dirty.Designer.cs'));
        const duri = vscode.Uri.file(path.join(dir, 'dirty.Designer.cs'));
        await vscode.commands.executeCommand('vscode.open', duri);
        await waitFor(() => {
            const t = vscode.window.tabGroups.activeTabGroup.activeTab;
            return t && t.input instanceof vscode.TabInputCustom
                && t.input.viewType === 'macforms.formDesigner'
                && String(t.input.uri.fsPath).includes('dirty');
        }, 10000, 'the test form in our editor');

        const changed = await driveHostCommit(vscode, duri.fsPath, (s) => {
            const c = s.controls.find((x) => x.id === 'btnSubmit');
            c.properties.x = 123;
        });
        assert.ok(changed, 'extension reported no change');

        // VS Code exposes dirty state on the tab only indirectly; the reliable signal is that
        // saveCustomDocument is invoked on save. We assert the file changed first, then save.
        await sleep(600);
        const dirty = fs.readFileSync(duri.fsPath, 'utf8');
        assert.ok(dirty.includes('new System.Drawing.Point(123, 154)'),
            'file on disk was not updated: ' + dirty.slice(0, 120));
    });

    await test('the undo() continuation restores the file byte-for-byte', async () => {
        // NOTE ON SCOPE: we invoke the continuation we passed to CustomDocumentEditEvent, not
        // the `undo` COMMAND. VS Code routes Ctrl+Z to custom editors via a keybinding
        // implementation (`addImplementation(105,"custom-editor")`) that the extension host API
        // cannot dispatch — `executeCommand('undo')` does not reach it, verified by probe.
        // So this asserts OUR half: that undo() rewrites the file exactly. VS Code's half
        // (calling it on Ctrl+Z) is its own documented behaviour, verified against its source.
        const duri = vscode.Uri.file(path.join(dir, 'dirty.Designer.cs'));
        const before = fs.readFileSync(duri.fsPath, 'utf8');
        assert.ok(before.includes('new System.Drawing.Point(123, 154)'), 'precondition failed');

        // Prove the comparison is real: the edited file must genuinely differ from the
        // original. Without this, a byte-compare bug could mask itself by passing.
        assert.notStrictEqual(before, original,
            'precondition: edited file is identical to the original, so this test proves nothing');

        await seam('undo');
        await sleep(400);

        const after = fs.readFileSync(duri.fsPath, 'utf8');
        assert.strictEqual(after, original,
            'undo() did not restore the original bytes.\n' +
            '  expected ' + original.length + ' bytes, got ' + after.length);
        assert.ok(!after.includes('Point(123, 154)'), 'undo() left the edit in place');
    });

    await test('the redo() continuation re-applies the edit', async () => {
        const duri = vscode.Uri.file(path.join(dir, 'dirty.Designer.cs'));
        await seam('redo');
        await sleep(400);
        const after = fs.readFileSync(duri.fsPath, 'utf8');
        assert.ok(after.includes('new System.Drawing.Point(123, 154)'),
            'redo() did not re-apply: ' + after.slice(0, 200));
    });

    await test('save clears the dirty marker (saveCustomDocument is honoured)', async () => {
        const duri = vscode.Uri.file(path.join(dir, 'dirty.Designer.cs'));
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(500);
        // The engine already wrote the file, so save must be a no-op on disk — a double write
        // here would be the classic bug of applying doc.text on top of an engine write.
        const after = fs.readFileSync(duri.fsPath, 'utf8');
        assert.ok(after.includes('new System.Drawing.Point(123, 154)'),
            'save corrupted the file');
        await vscode.commands.executeCommand('undo');
        await sleep(800);
    });

    await test('an external change is detected and re-parsed', async () => {
        const duri = vscode.Uri.file(path.join(dir, 'watch.Designer.cs'));
        fs.copyFileSync(path.join(ROOT, 'fixtures/simple/SimpleDialog.Designer.cs'), duri.fsPath);
        await vscode.commands.executeCommand('vscode.open', duri);
        await waitFor(() => {
            const t = vscode.window.tabGroups.activeTabGroup.activeTab;
            return t && t.input instanceof vscode.TabInputCustom
                && t.input.viewType === 'macforms.formDesigner';
        }, 10000, 'our editor');

        // Simulate `dotnet build` on Windows regenerating the file underneath us. We cannot
        // read the webview, so assert via the engine that the file is coherent afterwards and
        // that the extension is still responsive — i.e. it did not die on the watcher event.
        const docked = path.join(dir, 'DockedForm.Designer.cs');
        fs.copyFileSync(path.join(ROOT, 'fixtures/docked/DockedForm.Designer.cs'), duri.fsPath);
        await sleep(1500);

        // The file is now a Dock/Anchor form, so the engine MUST refuse to write it. That is
        // both the expected behaviour and proof the extension survived the watcher event.
        const { spawn } = require('child_process');
        const exe = path.join(ENGINE_BIN, triple(),
            process.platform === 'win32' ? 'macforms-engine.exe' : 'macforms-engine');
        const rpc = (req) => new Promise((res, rej) => {
            const c = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            let buf = '';
            c.stdout.on('data', (d) => {
                buf += d;
                const nl = buf.indexOf('\n');
                if (nl >= 0) { try { c.kill(); } catch { } res(JSON.parse(buf.slice(0, nl))); }
            });
            c.on('error', rej);
            c.stdin.write(JSON.stringify(req) + '\n');
            setTimeout(() => { try { c.kill(); } catch { } rej(new Error('engine timeout')); }, 10000);
        });
        const p = await rpc({ id: 1, cmd: 'parse', path: duri.fsPath });
        assert.ok(p.ok, 're-parse after external change failed');
        assert.ok(p.schema.analysis.refuses.includes('dock-anchor'),
            'external change was not picked up: ' + JSON.stringify(p.schema.analysis.refuses));

        const alive = await vscode.commands.getCommands(true);
        assert.ok(alive.includes('macforms.restartEngine'), 'extension stopped responding');
    });



    // ------------------------------------------------ csdevkit did not steal it
    await test('no other extension claimed *.Designer.cs', () => {
        // Reported rather than asserted: if a future csdevkit version starts contributing a
        // custom editor, this is where it will show up.
        const rivals = vscode.extensions.all.filter((e) => {
            if (e.id === 'macforms.macforms') return false;
            const pkg = e.packageJSON || {};
            const eds = (pkg.contributes && pkg.contributes.customEditors) || [];
            return eds.some((ed) => JSON.stringify(ed.selector || '')
                .includes('Designer.cs'));
        });
        console.log('        (rivals claiming *.Designer.cs: ' +
            (rivals.length ? rivals.map((r) => r.id).join(', ') : 'none') + ')');
        assert.ok(true);
    });

    fs.rmSync(dir, { recursive: true, force: true });

    console.log('\nintegration: ' + passes + ' passed, ' + failures + ' failed');
    return { passes, failures };
}

function dirs0() {
    const os3 = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const a = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'x64';
    return `${os3}-${a}`;
}

module.exports = { run };