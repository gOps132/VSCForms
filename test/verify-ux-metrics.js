// Verification test for UX metrics extraction (Ticket #54)
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const METRICS_FILE = path.join(ROOT, 'out', 'ux-snapshots', 'dom-metrics.json');

function verifyMetrics(metrics) {
    assert.ok(metrics, 'metrics object must be present');
    assert.ok(typeof metrics.timestamp === 'string', 'metrics must have ISO timestamp');
    assert.ok(metrics.canvas && typeof metrics.canvas.width === 'number', 'canvas width must be number');
    assert.ok(metrics.canvas && typeof metrics.canvas.height === 'number', 'canvas height must be number');
    assert.ok(Array.isArray(metrics.controls), 'controls must be an array');
    assert.ok(metrics.controls.length >= 3, `expected at least 3 controls, got ${metrics.controls.length}`);

    const byId = new Map(metrics.controls.map((c) => [c.id, c]));

    // Check btnCalculate
    const btn = byId.get('btnCalculate');
    assert.ok(btn, 'btnCalculate must exist');
    assert.strictEqual(btn.type, 'button');
    assert.strictEqual(btn.isLocked, false);
    assert.strictEqual(typeof btn.bounds.width, 'number');
    assert.strictEqual(typeof btn.bounds.height, 'number');
    assert.ok(btn.styles.fontFamily, 'btnCalculate must have fontFamily');
    assert.ok(btn.styles.fontSize, 'btnCalculate must have fontSize');
    assert.ok(btn.styles.color, 'btnCalculate must have color');
    assert.ok(btn.styles.backgroundColor, 'btnCalculate must have backgroundColor');
    assert.strictEqual(typeof btn.a11y.tabIndex, 'number');

    // Check lblResult
    const lbl = byId.get('lblResult');
    assert.ok(lbl, 'lblResult must exist');
    assert.strictEqual(lbl.type, 'label');
    assert.strictEqual(lbl.isLocked, false);

    // Check calDetails
    const cal = byId.get('calDetails');
    assert.ok(cal, 'calDetails must exist');
    assert.strictEqual(cal.isLocked, true, 'calDetails (MonthCalendar) must be locked');

    console.log('PASS: dom-metrics.json schema and control assertions verified successfully.');
}

if (require.main === module) {
    if (!fs.existsSync(METRICS_FILE)) {
        console.error(`Missing metrics file at ${METRICS_FILE}. Run 'npm run ux:capture' first.`);
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    verifyMetrics(data);
}

module.exports = { verifyMetrics };
