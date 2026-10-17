# UI/UX Canvas Review Guide & Quality Rubric

This document defines the evaluation rubric and workflow for analyzing the VSCForms designer canvas. It guides agents and human developers when reviewing captures (`out/ux-snapshots/`) and assessing visual fidelity, ergonomics, and theme integration.

---

## 1. Review Rubric & Evaluation Pillars

### Pillar A: WinForms Control Aesthetic Fidelity
The canvas represents a WinForms design surface. While it runs in a modern webview (see [ADR 0006](adr/0006-serializer-not-renderer.md)), the visual representation must match developer expectations from Visual Studio:
- **Button Styling**: Classic 3D/flat bevels depending on `FlatStyle`, legible font metrics, centered labels.
- **Form Surface**: Form header showing form name and dimensions, distinct drag/resize borders, clear contrast between form background and viewport canvas.
- **Input Controls**: TextBox, ComboBox, ListBox should display authentic border styles (`Fixed3D`, `FixedSingle`, `None`), interior padding, and scrollbar affordances.
- **Containers**: GroupBox legend border cut-through, Panel border styles, and TabControl / TabPage tabs.
- **Locked Controls**: Unhandled or third-party controls must render distinctly with a locked pattern/icon, clear type label, and non-destructive styling (preserving existing code).

### Pillar B: Designer Canvas Ergonomics
- **Selection Affordances**:
  - Dominant control selection clearly marked (solid white resize handles).
  - Secondary multi-selected items marked without ambiguous handle overlays.
  - Drag bounding box and rubber-band marquee clearly visible against all form backgrounds.
- **Alignment & Snapping**:
  - SnapLines (purple/blue/red guides) visible at control margins, centers, and text baselines during movement.
  - Coordinate readout in the status bar (X, Y, W × H) reflecting form units.
- **Toolbox & Inspector**:
  - Toolbox items readable with distinct icons, clear search/filter input.
  - Property grid organized (Categorized / Alphabetical / Flat tabs), with changed values in bold and Reset actions accessible.
  - Coverage / Refusal Banner prominent at the top without obstructing the form canvas.

### Pillar C: VS Code Theme Adaptation & Accessibility
- **Theme Variables**: All chrome and canvas borders must use semantic CSS variables (`var(--vscode-*)`) rather than hardcoded palette constants.
- **Contrast Compliance**:
  - Normal text must satisfy WCAG AA minimum contrast ratio (4.5:1) against control backgrounds in both Dark Modern and Light Modern themes.
  - Focus rings (`var(--vscode-focusBorder)`) must be distinct and visible for keyboard navigation.
- **Borders & Separation**: Form canvas boundaries must remain clearly distinguishable from the editor background across themes.

---

## 2. Interactive Loop Workflow

```
[npm run ux:capture]
       │
       ▼
[Inspect Screenshots & Metrics]
  - out/ux-snapshots/canvas-dark.png
  - out/ux-snapshots/canvas-light.png
  - out/ux-snapshots/dom-metrics.json
       │
       ▼
[Identify Defect / Enhancement]
  - e.g. Handle contrast, padding, border alignment, theme variables
       │
       ▼
[Apply Edit to extension/media/]
  - canvas.css or canvas.js
       │
       ▼
[Verify with npm run ux:verify & npm run ux:capture]
  - Compare before/after diffs to confirm visual improvement
```
