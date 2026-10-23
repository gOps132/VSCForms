# Autonomous Parity & UI/UX Feedback Loop

This document specifies the dual-agent architecture that drives continuous Windows Forms feature parity and visual canvas quality in VSCForms.

---

## 1. Architecture: The Closed Feedback Loop

```mermaid
flowchart TD
    subgraph Feature Loop ["WinForms Feature Parity (winforms-feature-engineer)"]
        A[UTM Oracle / WinForms Runtime] -->|Ground Truth Semantics| B[Measure Behavior & Metrics]
        B -->|Divergence Found| C[Emit fixtures/differential/]
        C -->|Surgical Patch| D[Roslyn Engine engine/src/]
        D -->|Verify Invariants| E[./test/verify.sh & Compile Tier]
    end

    subgraph UX Loop ["Extension UI/UX Audit (canvas-ux-auditor)"]
        F[npm run ux:capture] -->|CDP Snapshots & dom-metrics.json| G[Inspect Visual Canvas]
        G -->|Evaluate Rubric| H{Pillars A, B, C Pass?}
        H -- No: Canvas Issue --> I[Patch extension/media/ CSS/JS]
        I --> J[npm run ux:verify]
        J --> F
        H -- No: Schema/Engine Defect --> K[Feed back failing case to Feature Loop]
        K --> C
        H -- Yes: High Fidelity --> L[Approved Milestone]
    end

    E -->|Deploy Feature| F
```

---

## 2. Defined Subagents

### `winforms-feature-engineer`
- **Role**: Discovers, measures, and implements Windows Forms features and control properties.
- **Tools**: QEMU guest agent (`scripts/utm-guest.sh`), project sync (`scripts/utm-vs-open.sh`), matrix runner (`scripts/run-windows-matrix.sh`), C# compiler.
- **Invariants**: Strictly enforces `AGENTS.md` Invariants 1–5 (source of truth is `.Designer.cs`, dialect preservation, BOM/CRLF byte-identity, no locked/refused writes, dual INSERT/REPLACE paths).

### `canvas-ux-auditor`
- **Role**: Drives headless Chrome DevTools Protocol (CDP) inside VS Code to capture high-res Dark and Light theme canvas renders.
- **Tools**: `npm run ux:capture`, `npm run ux:verify`, `node extension/test/hostHarness.js`.
- **Criteria**: Evaluates against `docs/ui-ux-review.md` (Pillar A: WinForms Control Aesthetic Fidelity; Pillar B: Canvas Ergonomics; Pillar C: VS Code Theme & Contrast Compliance).

---

## 3. How to Trigger the Loop

To run an iteration of the feature-to-UX loop:
1. Invoke `winforms-feature-engineer` on a specific feature queue item (e.g. Issue #65 default heights, #15 DateTimePicker formatting).
2. Once the engine passes unit tests, invoke `canvas-ux-auditor` to capture snapshots and verify the new control/property on the canvas.
3. If `canvas-ux-auditor` spots alignment, handle, or style defects, it patches `extension/media/` or feeds discrepancies back to the engine.
