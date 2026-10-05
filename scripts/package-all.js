#!/usr/bin/env node
/*
 * Build the extension .vsix for the CURRENT platform only.
 *
 * Per docs/adr/0002 we publish one platform-targeted .vsix per platform. A CI matrix runs
 * this on each OS and publishes the result, so each user downloads ~34 MB instead of ~176 MB.
 *
 * Two release-blocking details are handled here and are easy to get wrong:
 *   1. bin/ must contain only this platform's binary (vsce's --ignore-other-target-folders
 *      is a documented no-op in 4.x).
 *   2. Packaging from Windows loses the POSIX executable bit, so the win32 CI leg must be
 *      built on a Linux runner — or the engine will extract non-executable and fail to spawn.
 */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');

function vscodeTriple(platform, arch) {
    const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
    const a = arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : 'x64';
    return `${os}-${a}`;
}

const triple = vscodeTriple(process.platform, process.arch);

// 1. fail loudly if another target leaked into bin/
const bin = path.join(EXT, 'bin');
if (fs.existsSync(bin)) {
    const others = fs.readdirSync(bin).filter((d) => d !== triple);
    if (others.length) {
        console.error(`bin/ contains other targets: ${others.join(', ')}`);
        console.error('Run `npm run build:engine` first — it prunes them. Packaging now would');
        console.error('bloat this .vsix with binaries nobody on this platform can run.');
        process.exit(1);
    }
}

// 2. compile TypeScript
console.log('compiling TypeScript…');
const tsc = cp.spawnSync('npx', ['tsc', '-p', './'], { cwd: EXT, stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status || 1);

// 3. package
const outFile = path.join(ROOT, 'dist', `macforms-${triple}.vsix`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });

console.log(`packaging for ${triple}…`);
const pkg = cp.spawnSync(
    'npx',
    ['vsce', 'package', '--target', triple, '--out', outFile],
    { cwd: EXT, stdio: 'inherit' }
);
if (pkg.status !== 0) process.exit(pkg.status || 1);

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`\nOK: ${path.relative(ROOT, outFile)} (${mb} MB) for ${triple}`);