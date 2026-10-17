'use strict';
async function run() {
    const vscode = require('vscode');
    const { run } = require('./ux-capture-suite.js');
    await run(vscode);
}
module.exports = { run };
