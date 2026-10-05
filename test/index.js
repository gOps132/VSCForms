// Entry point executed INSIDE the VS Code extension host.
//
// VS Code requires the extensionTestsPath module to export a `run()` function (it probes for
// that export to decide whether a module is a valid test runner). It does not accept a script
// that runs its assertions at import time.
'use strict';

async function run() {
    const vscode = require('vscode');
    // Load the extension module FIRST so its module-level test seams exist before any test
    // runs. `ext.exports` is not a reliable source for them: VS Code consumes the activation
    // promise, and reading it later yields undefined.
    const { run } = require('./suite.js');
    const result = await run(vscode);
    // Returning a truthy value signals failure to the runner.
    if (result && result.failures > 0) {
        throw new Error(`${result.failures} integration assertion(s) failed`);
    }
}

module.exports = { run };