#!/usr/bin/env node
/*
 * Publish the engine as a self-contained single-file binary for the CURRENT platform only,
 * into extension/bin/<vscode-triple>/.
 *
 * Platform targeting is the extension's whole distribution strategy (docs/adr/0002): vsce
 * package --target produces one .vsix per platform, so each user downloads ~34 MB rather
 * than the ~176 MB a universal bundle costs.
 *
 * IMPORTANT: `--ignore-other-target-folders` is documented by vsce but has NO IMPLEMENTATION
 * in vsce 4.x, so it silently ships every other platform's binary too. We therefore never
 * leave more than one target directory populated — this script clears bin/ first.
 */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine');
const BIN = path.join(ROOT, 'extension', 'bin');

/** VS Code platform triples, which differ from .NET RIDs. */
function vscodeTriple(platform, arch) {
    const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
    const a = arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : 'x64';
    return `${os}-${a}`;
}

/** .NET RID for a VS Code triple. */
function toRid(triple) {
    const [os, arch] = triple.split('-');
    const ridOs = os === 'win32' ? 'win' : os === 'darwin' ? 'osx' : 'linux';
    return `${ridOs}-${arch}`;
}

const triple = vscodeTriple(process.platform, process.arch);
const rid = toRid(triple);
const out = path.join(BIN, triple);

console.log(`platform triple : ${triple}`);
console.log(`.NET RID        : ${rid}`);

// Prune other targets: a stale binary in bin/ would be bundled into this platform's vsix
// because vsce's --ignore-other-target-folders does nothing.
if (fs.existsSync(BIN)) {
    for (const d of fs.readdirSync(BIN)) {
        if (d === triple) continue;
        console.log(`pruning stale target: bin/${d}`);
        fs.rmSync(path.join(BIN, d), { recursive: true, force: true });
    }
}
fs.mkdirSync(out, { recursive: true });

const args = [
    'publish', ENGINE,
    '-c', 'Release',
    '-r', rid,
    '--self-contained', 'true',
    '-p:PublishSingleFile=true',
    '-p:DebugType=none',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-o', out,
];

console.log(`dotnet ${args.join(' ')}\n`);
const res = cp.spawnSync('dotnet', args, { stdio: 'inherit', cwd: ROOT });
if (res.status !== 0) {
    console.error('\nengine publish FAILED');
    process.exit(res.status || 1);
}

const exe = path.join(out, process.platform === 'win32' ? 'vscforms-engine.exe' : 'vscforms-engine');
if (!fs.existsSync(exe)) {
    console.error(`expected binary missing: ${exe}`);
    process.exit(1);
}
if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);

const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`\nOK: ${path.relative(ROOT, exe)} (${mb} MB)`);
console.log('Next: npm run compile && npx vsce package --target ' + triple);