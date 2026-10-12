'use strict';
async function run() {
    const vscode = require('vscode');
    const { run } = require('./cdp-probe-suite.js');
    const result = await run(vscode);
    if (result && result.failures > 0) {
        throw new Error(`${result.failures} cdp probe assertion(s) failed`);
    }
}
module.exports = { run };
