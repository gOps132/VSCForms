#!/usr/bin/env node
// UX capture harness: launches VS Code, opens form designer, and captures screenshots across themes via CDP.
// Usage: node scripts/capture-designer-ux.js [--fixture=path/to/Form.Designer.cs] [--out=out/ux-snapshots] [--port=9333]
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const MARKER_DIR = path.join(os.tmpdir(), 'vscforms-ux-capture');
const DEFAULT_FIXTURE = 'fixtures/wired/WiredForm.Designer.cs';
const DEFAULT_OUT = path.join(ROOT, 'out', 'ux-snapshots');
const DEFAULT_PORT = 9333;

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

function parseArgs() {
    const args = process.argv.slice(2);
    let fixture = DEFAULT_FIXTURE;
    let outDir = DEFAULT_OUT;
    let port = DEFAULT_PORT;

    for (const arg of args) {
        if (arg.startsWith('--fixture=')) {
            fixture = arg.slice('--fixture='.length);
        } else if (arg.startsWith('--out=')) {
            outDir = path.resolve(arg.slice('--out='.length));
        } else if (arg.startsWith('--port=')) {
            port = parseInt(arg.slice('--port='.length), 10) || DEFAULT_PORT;
        }
    }
    return { fixture, outDir, port };
}

async function main() {
    const { fixture, outDir, port } = parseArgs();

    if (!fs.existsSync(path.join(EXT, 'out', 'extension.js'))) {
        console.error('extension not compiled — run: (cd extension && npm run compile)');
        process.exit(1);
    }

    fs.rmSync(MARKER_DIR, { recursive: true, force: true });
    fs.mkdirSync(MARKER_DIR, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const { runTests } = require(path.join(EXT, 'node_modules/@vscode/test-electron'));
    const D = require('../test/cdp-driver.js');

    console.log(`[ux-capture] Target fixture: ${fixture}`);
    console.log(`[ux-capture] Output directory: ${outDir}`);
    console.log(`[ux-capture] Launching VS Code with remote debugging on port ${port}...`);

    const testPromise = runTests({
        extensionDevelopmentPath: [EXT],
        extensionTestsPath: path.resolve(ROOT, 'test/ux-capture-index.js'),
        extensionTestsEnv: {
            ...process.env,
            VSCFORMS_UX_FIXTURE: fixture,
        },
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
            `--remote-debugging-port=${port}`,
        ],
    });

    testPromise.catch((e) => {
        console.error('[ux-capture] test host error: ' + (e && e.message || e));
    });

    try {
        // 1. Dark Theme Capture
        console.log('[ux-capture] Waiting for designer Dark theme readiness...');
        await waitForFile(marker('READY_DARK'), 120000, 'READY_DARK');

        // Wait for controls to be rendered in canvas
        let canvasSummary = '';
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
            try {
                canvasSummary = await D.snapshotCanvas(port);
                if (canvasSummary && !canvasSummary.includes('COUNT=0') && canvasSummary.includes('COUNT=')) {
                    break;
                }
            } catch { }
            await sleep(500);
        }
        console.log(`[ux-capture] Canvas state (Dark): ${canvasSummary}`);

        await sleep(800);
        const darkBg = await D.webviewEval(port, 'return window.getComputedStyle(d.body).backgroundColor');
        console.log(`[ux-capture] Dark body bg: ${darkBg}`);
        console.log('[ux-capture] Capturing Dark theme screenshot...');
        const darkPng = await D.captureScreenshot(port);
        const darkPath = path.join(outDir, 'canvas-dark.png');
        fs.writeFileSync(darkPath, darkPng);
        console.log(`[ux-capture] Saved Dark screenshot to ${darkPath} (${darkPng.length} bytes)`);

        fs.writeFileSync(marker('CAPTURED_DARK'), '1');

        // 2. Light Theme Capture
        console.log('[ux-capture] Waiting for designer Light theme readiness...');
        await waitForFile(marker('READY_LIGHT'), 120000, 'READY_LIGHT');
        await sleep(1000);

        const lightBg = await D.webviewEval(port, 'return window.getComputedStyle(d.body).backgroundColor');
        console.log(`[ux-capture] Light body bg: ${lightBg}`);
        console.log('[ux-capture] Capturing Light theme screenshot...');
        const lightPng = await D.captureScreenshot(port);
        const lightPath = path.join(outDir, 'canvas-light.png');
        fs.writeFileSync(lightPath, lightPng);
        console.log(`[ux-capture] Saved Light screenshot to ${lightPath} (${lightPng.length} bytes)`);

        fs.writeFileSync(marker('CAPTURED_LIGHT'), '1');

        // 3. Wait for clean exit
        await waitForFile(marker('DONE'), 30000, 'DONE');
        console.log('[ux-capture] All theme captures completed successfully.');
        const exitCode = await testPromise;
        process.exit(exitCode || 0);
    } catch (err) {
        console.error('[ux-capture] Error during capture:', err);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
