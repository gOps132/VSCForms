#!/usr/bin/env node
/*
 * Launches a REAL VS Code with the extension loaded and runs test/suite.js inside the
 * extension host. This is the only verification that exercises VS Code's own semantics:
 * editor selection and priority, the dirty marker, undo/redo dispatch, and the refusal paths.
 *
 * A real window is required — @vscode/test-electron needs a display. On a headless machine
 * this exits 0 with a SKIP rather than failing the build.
 *
 * Run: node test/run-integration.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const BIN = path.join(EXT, 'bin');

function triple(platform, arch) {
    const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
    const a = arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : 'x64';
    return `${os}-${a}`;
}

async function main() {
    // Preconditions, checked before launching anything expensive.
    if (!fs.existsSync(path.join(EXT, 'out', 'extension.js'))) {
        console.error('extension not compiled — run: (cd extension && npm run compile)');
        process.exit(1);
    }
    const t = triple(process.platform, process.arch);
    if (!fs.existsSync(BIN) || !fs.readdirSync(BIN).includes(t)) {
        console.error(`bundled engine missing for ${t} — run: node scripts/publish-engine.js`);
        process.exit(1);
    }
    if (!process.env.DISPLAY && process.platform === 'linux') {
        console.log('SKIP  no DISPLAY; VS Code integration tests need a display');
        process.exit(0);
    }

    const { runTests } = require(path.join(EXT, 'node_modules/@vscode/test-electron'));

    console.log(`launching VS Code with extensionDevelopmentPath=${EXT}\n`);
    try {
        const code = await runTests({
            extensionDevelopmentPath: [EXT],
            extensionTestsPath: path.resolve(__dirname, 'index.js'),
            launchArgs: [
                path.join(ROOT, 'fixtures'),
                '--disable-extensions',
                '--disable-gpu',
                '--no-sandbox',
                '--skip-welcome',
                '--skip-release-notes',
                '--disable-workspace-trust',
                // Silence network-dependent services. Without these the run stalls on update
                // alerts / extension recommendations / settings sync, and a modal appears that
                // nothing can dismiss — which is what hung the suite mid-way.
                '--disable-telemetry',
                '--disable-crash-reporter',
                '--disable-updates',
                '--disable-workspace-notification-center',
                '--disable-notifications',
                '--disable-remote-explorer',
                '--disable-sync',
            ],
        });
        console.log('\nVS Code exited with code ' + code);
        process.exit(code);
    } catch (e) {
        // A download failure or a sandbox problem should be loud, not silently green.
        console.error('\nintegration run failed to launch: ' + (e && e.message || e));
        process.exit(1);
    }
}

main();