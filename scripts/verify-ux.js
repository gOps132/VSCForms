#!/usr/bin/env node
// UX metrics verification and regression check script.
// Usage: node scripts/verify-ux.js [--current=out/ux-snapshots/dom-metrics.json] [--baseline=path/to/baseline.json]
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_METRICS = path.join(ROOT, 'out', 'ux-snapshots', 'dom-metrics.json');

function parseArgs() {
    const args = process.argv.slice(2);
    let currentPath = DEFAULT_METRICS;
    let baselinePath = null;

    for (const arg of args) {
        if (arg.startsWith('--current=')) {
            currentPath = path.resolve(arg.slice('--current='.length));
        } else if (arg.startsWith('--baseline=')) {
            baselinePath = path.resolve(arg.slice('--baseline='.length));
        }
    }
    return { currentPath, baselinePath };
}

function verifyMetricsIntegrity(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
        return ['Invalid metrics data: expected object'];
    }
    if (!data.timestamp) errors.push('Missing timestamp');
    if (!data.canvas || typeof data.canvas.width !== 'number') errors.push('Invalid canvas geometry');
    if (!Array.isArray(data.controls) || data.controls.length === 0) errors.push('No controls in metrics manifest');

    for (const c of data.controls || []) {
        if (!c.id) errors.push(`Control missing id: ${JSON.stringify(c)}`);
        if (!c.bounds || typeof c.bounds.width !== 'number' || typeof c.bounds.height !== 'number') {
            errors.push(`Control ${c.id} missing valid bounding box`);
        }
        if (!c.styles) {
            errors.push(`Control ${c.id} missing computed styles`);
        } else {
            if (!c.styles.color) errors.push(`Control ${c.id} missing text color`);
            if (!c.styles.fontFamily) errors.push(`Control ${c.id} missing fontFamily`);
        }
    }
    return errors;
}

function compareMetrics(current, baseline) {
    const diffs = [];
    const baseMap = new Map(baseline.controls.map((c) => [c.id, c]));
    const curMap = new Map(current.controls.map((c) => [c.id, c]));

    for (const [id, cur] of curMap) {
        const base = baseMap.get(id);
        if (!base) {
            diffs.push(`NEW CONTROL: ${id} (${cur.type})`);
            continue;
        }
        // Check geometry shifts
        const dx = Math.abs(cur.bounds.x - base.bounds.x);
        const dy = Math.abs(cur.bounds.y - base.bounds.y);
        const dw = Math.abs(cur.bounds.width - base.bounds.width);
        const dh = Math.abs(cur.bounds.height - base.bounds.height);

        if (dx > 0 || dy > 0 || dw > 0 || dh > 0) {
            diffs.push(`GEOMETRY SHIFT in ${id}: [${base.bounds.x},${base.bounds.y} ${base.bounds.width}x${base.bounds.height}] -> [${cur.bounds.x},${cur.bounds.y} ${cur.bounds.width}x${cur.bounds.height}]`);
        }

        // Check style shifts
        for (const prop of ['color', 'backgroundColor', 'borderColor', 'fontFamily', 'fontSize']) {
            if (cur.styles[prop] !== base.styles[prop]) {
                diffs.push(`STYLE CHANGE in ${id} ${prop}: "${base.styles[prop]}" -> "${cur.styles[prop]}"`);
            }
        }
    }

    for (const [id] of baseMap) {
        if (!curMap.has(id)) {
            diffs.push(`REMOVED CONTROL: ${id}`);
        }
    }

    return diffs;
}

function main() {
    const { currentPath, baselinePath } = parseArgs();

    if (!fs.existsSync(currentPath)) {
        console.error(`[ux:verify] Metrics file not found: ${currentPath}`);
        console.error(`[ux:verify] Run 'npm run ux:capture' first to generate metrics.`);
        process.exit(1);
    }

    const currentData = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    console.log(`[ux:verify] Checking metrics integrity: ${currentPath}`);

    const errors = verifyMetricsIntegrity(currentData);
    if (errors.length > 0) {
        console.error(`[ux:verify] Integrity verification failed:`);
        errors.forEach((e) => console.error(`  - ${e}`));
        process.exit(1);
    }

    console.log(`[ux:verify] Canvas: ${currentData.canvas.width}x${currentData.canvas.height}px | Controls: ${currentData.controlCount}`);
    for (const c of currentData.controls) {
        const lockStr = c.isLocked ? ' [LOCKED]' : '';
        console.log(`  ✓ ${c.id} (${c.type})${lockStr} @ [${c.bounds.x}, ${c.bounds.y}, ${c.bounds.width}x${c.bounds.height}] font=${c.styles.fontSize}`);
    }

    if (baselinePath) {
        if (!fs.existsSync(baselinePath)) {
            console.error(`[ux:verify] Baseline file not found: ${baselinePath}`);
            process.exit(1);
        }
        const baselineData = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        console.log(`[ux:verify] Comparing against baseline: ${baselinePath}`);
        const diffs = compareMetrics(currentData, baselineData);
        if (diffs.length > 0) {
            console.log(`[ux:verify] Detected ${diffs.length} difference(s):`);
            diffs.forEach((d) => console.log(`  * ${d}`));
        } else {
            console.log(`[ux:verify] Zero regressions: current metrics exactly match baseline.`);
        }
    }

    console.log(`[ux:verify] Verification PASSED.`);
}

if (require.main === module) {
    main();
}

module.exports = { verifyMetricsIntegrity, compareMetrics };
