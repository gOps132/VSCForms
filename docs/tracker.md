# Feature & compatibility tracker

**Living document.** This is the single list of what VSCForms can do, what it
lacks, and what it deliberately refuses. The `docs/spec-*.md` files are the
*reasoning*; this file is the *current state*. When they disagree, this file
wins on state and the spec wins on rationale — then file a fix so they agree.

**Rule (also in `AGENTS.md`): every feature change updates this file in the
same change.** A shipped capability with a stale row here is a bug in the
change, not in the docs.

Issue map: [#1](https://github.com/gOps132/VSCForms/issues/1) (children #2–#19
plus D5–D10 (#32–#37) and E1 (#61), one per gap row). Triage per
`docs/agents/triage-labels.md` before claiming.

Last verified: `a93607f` (the differential-oracle wave: E1 shipped, #62 and #63
fixed, `SCHEMA.md`'s `textAlign` shape documented). Re-verify by reading
`engine/src/TypeTable.cs`, `extension/media/canvas.js` (`HANDLED`),
`engine/src/Schema.cs`, `engine/src/Patcher.cs`, and `SCHEMA.md` — not by memory.

## 1. Where we are

- **19 handled types** (`TypeTable.Handled`, mirrored by canvas `HANDLED` —
  both directions enforced by `test/verify.sh`): Button, Label, TextBox,
  CheckBox, RadioButton, ComboBox, ListBox, PictureBox, Panel, GroupBox,
  TrackBar, ProgressBar, NumericUpDown, DateTimePicker, TabControl, TabPage,
  DataGridView, ListView, TreeView. Plus `Form` itself (resolved separately).
- **Containers modelled:** Panel, GroupBox, TabControl, TabPage (two-level:
  `tabControl.Controls.Add(page)`, `page.Controls.Add(...)`).
- **Read-only placeholders:** DataGridView, ListView, TreeView render as
  labelled boxes (name + type, no interior). Display-only by design.
- **Properties wired end-to-end** (parse + patch + inspector, each with an
  INSERT path): geometry, Text, TabIndex, TabStop (additive), Name, Enabled, Visible, BackColor,
  ForeColor, Font (per-argument patch), Items (ComboBox/ListBox via
  `Add`/`AddRange`), TextBox Multiline/ReadOnly/MaxLength/PasswordChar/
  ScrollBars, leaf Minimum/Maximum/Value (TrackBar, ProgressBar,
  NumericUpDown), Checked, TextAlign, BorderStyle, AutoSize, form
  ClientSize/Text/BackColor.
- **Engine commands:** `parse`, `generate`, `ping`, `new` (project
  generation), `rename` (Designer File + code-behind member-access receivers
  only, ADR 0008), `wireEvent`, `unwireEvent` (dual-file surgical patch across
  `Form.Designer.cs` and `Form.cs`, ADR 0011).
- **Canvas toolset:** drag, 8-handle resize, snap (grid-size setting + SnapLines
  edges/centers/baselines with magnetic pull on move/resize/multi + Alt-suppress
  + SnapLines/grid-only mode, all toggleable),
  multi-select + marquee (click-order dominant + Ctrl/Cmd+click toggle +
  Shift+marquee-add, align/distribute-to-dominant),
  toolbox draw-to-create (sticky armed tool + crosshair, click-place/drag-size
  with live snap guides, dblclick/Enter populate, dragover guides),
  containers drag-reparent (hover highlight, drop reparent with coordinate
  conversion, TabPage targeting, locked/refused guards, one commit via ADR 0010),
  Document Outline one-slot step-order buttons (▲▼, riding A1 move),
  `Cmd/Ctrl+D` duplicate, zoom
  (`Cmd/Ctrl`+wheel, `+/-`/`0`, Fit, 0.25–4.0), space/middle-drag pan, rulers,
  zoom bar, Escape deselect, tab-strip activation, drill-down selection for
  nested containers, coverage banner (never hideable), locked boxes with
  reasons, rename field, items list editor, single-selection size/location
  readout (X/Y + W×H in the status bar, form units), dblclick in-place Text edit,
  same-size / center-in-form arrange ops, keyboard jump + resize, tab-order mode,
  Bring to Front / Send to Back (z-order: array order is paint order, index 0 = front),
   inspector bold+Reset (edited-since-load rows bold, Reset deletes the model key),
   multi-select common-props intersection (agreed or blank, geometry stays on group ops),
   hardcoded description pane, inspector Events tab (⚡) with Categorized and Alphabetical views,
   double-click on canvas to scaffold default event (F2 for in-place text edit).
- **Project & run:** `VSCForms: New Project…` (classic `.sln`, BOM/CRLF-safe
  csproj edit), `VSCForms: Run in Wine` + editor play button + `F5`.
- **Refusals (correct behaviour, not gaps):** `ApplyResources` (41.6% of
  corpus), `Dock`/`Anchor` (40.9%). See §3.
- **Layout tier (Windows CI):** `scripts/verify-layout-fixtures.ps1` drives every
  checked-in fixture through the real WinForms runtime (one run per Designer file,
  18 fixtures). Geometry is compared per axis with no tolerance; genuinely
  un-simulatable controls (`MonthCalendar` grid snap, text-driven `AutoSize`, and
  container-owned `TabPage`) are excluded with explicit rationale, while leaf controls
  (`TextBox`, `ComboBox`, `DateTimePicker`, `NumericUpDown`, `TrackBar`) match declared
  design-time sizes to runtime metrics exactly on both axes with zero exclusions (#65).
  Refused forms are presence-only.
  Fixtures must stage their controls into a parent collection — a control that is
  never `Controls.Add`-ed parses as a top-level schema node but is absent from the
  runtime tree, which the tier reports as control-not-found. (#43)
- **UI/UX Canvas Loop (`npm run ux:capture`, `npm run ux:verify`):** Automated VS Code test-electron runner
  with CDP integration (`scripts/capture-designer-ux.js`, `scripts/verify-ux.js`, `test/cdp-driver.js`) capturing
  high-res Dark and Light theme designer canvas snapshots, structured DOM, computed styles,
  and accessibility metrics (`dom-metrics.json`) to `out/ux-snapshots/`, with review guidelines in
  `docs/ui-ux-review.md`. (#53, #54, #55)
- **Agentic workflow (`docs/agents/workflow.md`):** the Wayfinder loop (query map #1 →
  claim the top unblocked leaf → Builder TDD → Auditor multi-tier audit → flip this
  tracker in the same commit → close the ticket), the Builder + Auditor dual-agent seam
  for high-risk `engine/` and cross-file work, and the **Headless Differential Oracle**
  contract (deterministic permutation matrix, Windows runtime oracle, fixture-first
  discrepancy gate). **Contract only — the oracle itself is not built; see §2 E1.**

## 2. Gaps to implement

Status values: `missing` (accepted, unstarted) · `partial` (shipped subset
exists) · `deferred+ADR` (do not start without an ADR amendment).

### A. Structural features

| # | Gap | Status | Cost | Spec | Note |
|---|---|---|---|---|---|
| A1 | Z-order (Bring to Front / Send to Back) | shipped | M + protocol | `spec-features.md` §4, `spec-canvas-qol.md` §4 | Array order is paint order (index 0 = front); `generate` moves `Controls.Add` lines verbatim, never delete+insert. Inspector buttons ride `commit()`; duplicated Add refuses (`ambiguous-order`). ADR 0009. (#2) |
| A2 | Clipboard copy/paste | shipped | S–M | `spec-canvas-qol.md` §8 decision 5 | `copy`/`requestPaste`/`paste` host round-trip via system clipboard (`vscforms-controls-v1:` wire format); Ctrl/Cmd+C/V. Reuses duplicate kernel; locked filtered, refused guarded, unhandled paste lands locked. (#3) |
| A3 | Event scaffolding (`btn_Click` generation) | shipped | M | `spec-features.md` §4, ADR 0011 | Dedicated `wireEvent`/`unwireEvent` stdio commands, dual-file surgical patch across `Form.Designer.cs` and `Form.cs`, dialect matching, method reuse, VS Code cursor jump, Inspector Events tab (⚡) with Categorized/Alphabetical views, double-click canvas default event (Text edit on F2). Covered by `verify-events.sh`. (#4) |
| A4 | Tab-order editing UI | shipped | S | `spec-features.md` §4 | Mode toggle in status bar: badges show TabIndex, mousedown assigns next in click order (existing setProp/INSERT path). Esc exits; refused forms stay out; dblclick suppressed in mode. TabStop not modelled. (#5) |
| A5 | `ComboBox`/`ListBox` follow-ups: `SelectedIndex`/`SelectedItem`, `DropDownStyle`, drag-reorder | shipped (drag-reorder parked) | S–M | `spec-items.md` §0, §7 | `SelectedIndex` (incl. `-1`), `SelectedItem`, `DropDownStyle` end-to-end with INSERT paths + fixtures. Drag-reorder is a separate change, still open. (#6) |
| A6 | Resource/image editing (`PictureBox` images) | missing | L | `spec-features.md` §4 | Needs image serialisation. Out of scope. |
| A7 | `UserControl` composition | missing | L | `spec-features.md` §4 | A nested designer — genuinely a different product. |

### B. Control types (from `spec-example-compatibility.md` B1)

| # | Gap | Status | Cost | Note |
|---|---|---|---|---|
| B1 | `SplitContainer` | shipped (partial) | M | Unblocked by ADR 0003 amendment (`docs/adr/0003-amendment-partial-container.md`). Basic container structure modelled (geometry + `SplitterDistance`); children preserved-but-invisible. Dock/Anchor refusal unchanged. Fixture: fixtures/differential/B1-ADR-requirement.md. |
| B2 | `TableLayoutPanel` / `FlowLayoutPanel` | shipped (partial) | L | Unblocked by ADR 0003 amendment. Basic container structure (`RowCount`/`ColumnCount`) modelled; children preserved-but-invisible with C2 warning. Full simulation deferred. Fixture: fixtures/differential/B2-ADR-requirement.md. |
| B3 | `MenuStrip` / `ToolStrip` / `StatusStrip` / `ContextMenuStrip` / `BindingNavigator` | missing | M | Items are not `Control`s (no `Location`/`Size`) — unmodellable without a new schema shape. Cosmetic; host forms usually refuse anyway. |
| B4 | `DataGridView` columns (6 types), `ListView`/`TreeView` nodes+items, `PropertyGrid`, `WebBrowser`, `BindingSource` | partial | M | Placeholders shipped (§1). Interior contents preserved-but-invisible; full editing requires new collection schema shape. Expanded placeholder: fixtures/differential/B4-placeholder.md. |
| B5 | T1 leaf inputs: `LinkLabel`, `RichTextBox`, `MaskedTextBox`, `CheckedListBox`, `MonthCalendar`, `H/VScrollBar`, `DomainUpDown` | shipped | S each | Template-only per type: TypeTable + HANDLED + renderer + fixture. `CheckedListBox`/`DomainUpDown` collections deferred. Committed `fa78a64`. |
| B6 | `ToolStripContainer`/`ToolStripPanel`, `Splitter` | missing | M | Same layout-simulation caveat as B2 at lower frequency; deferred pending ADR 0003 amendment (same as B1/B2). Placeholder note added in fixtures/differential/B6-placeholder.md. |
| B7 | `DateTimePicker` value/format (`Value`, `Format`, `CustomFormat`, `MinDate`, `MaxDate`) | shipped | S–M | Shipped leaf set now models DateTimePicker formatting and value/limits: `Format` (Long/Short/Time/Custom), `CustomFormat`, `Value`, `MinDate`, `MaxDate` with surgical argument-level replacement and ISO 8601 schema representation. |

### C. Silent-divergence risks (zero handling today)

| # | Gap | Spec | Note |
|---|---|---|---|
| C1 | `RightToLeft` mirroring | `spec-example-compatibility.md` B2 | Warns via `analysis.warnings` (banner); form stays editable, shown LTR. No mirroring simulation. (#16) |
| C2 | `TableLayoutPanel` children with default `Dock`/`Anchor` shown flat | `spec-example-compatibility.md` B2 | Flat rendering contradicts layout semantics. Feeds the B2 refusal decision. |
| C3 | Preserved-but-invisible form props: `AutoScaleMode/Dimensions`, `AutoSize`, `Margin/Padding`, `ClientSize` vs `Size` | `spec-example-compatibility.md` B2 | Warns on surprises only (explicit Margin/Padding, AutoSize where unmodelled, non-Font AutoScaleMode, Size-without-ClientSize); standard files stay quiet. Default design-time Form bounds fallback (300x300 or child bounds + margin) when ClientSize omitted, with dual insert/replace patch path (#75). Read-only disclosure, no editing. (#18) |

### D. Canvas QoL (from `spec-vs-parity.md` — PROPOSED reasoning, this file is state)

| # | Gap | Status | Cost | Spec | Note |
|---|---|---|---|---|---|
| D1 | Size/location readout (single-selection X/Y + W×H in status bar, form units) | shipped | S | `spec-vs-parity.md` §1–2 | Read-only status text; zero patcher surface, no ADR. Live on drag/resize/nudge. Multi-select keeps count. (#20) |
| D2 | In-place Text edit (dblclick overlay committing via Text path) | shipped | S | `spec-vs-parity.md` §1–2 | Same setProp/INSERT path as inspector; no ADR. Never for locked/refused, containers (drill-down), or NO_TEXT. Escape cancels with no generate. (#21) |
| D3 | Make Same Size / Center in Form (pure-geometry arrange ops) | shipped | S | `spec-vs-parity.md` §1–2 | Same-size copies schema-order-first extents, position kept; center is per-control within immediate parent frame. One commit per op; no ADR. Equal Spacing already covered by Distribute (raw gaps). (#22) |
| D4 | Keyboard move/resize + container clamp (plain arrows move, Ctrl fine step, Shift resize) | shipped | S | `spec-vs-parity.md` §1–2 | Plain arrows move by GRID; Ctrl/Cmd is the 1px fine step (the old GRID*5 jump was inverted); Shift resizes all four ways — Right/Down grow, Left/Up shrink, top-left anchored — Ctrl+Shift resizes by 1px. Same TextChanges as drag/resize-handle; no ADR. Drag/nudge clamp to the parent frame (one shared delta, group moves as a block; a fully-blocked nudge posts no commit so untouched files stay byte-identical). Resize floors at max(2, MinimumSize when surfaced — opportunistic, no schema change). (#23, #48) |
| D5 | Toolbox upgrade (search, Choose Items, custom controls, Ctrl+Alt+X) | shipped (Choose Items parked) | M | `spec-vs-parity.md` §1 | Search/filter + Ctrl/Cmd+Alt+X focus through existing addControl; drag-to-add unchanged. Choose Items / custom controls need engine type discovery (ADR-sized). (#33) |
| D6 | Document Outline (hierarchy + F2 rename) + workbench min-width protection | shipped | M | `spec-vs-parity.md` §1 | Read-only hierarchy (locked annotated, refused read-only) + F2 through rename path. Clean theme variable styling, no hardcoded colors, structured right sidebar, and `.stage-wrap` min-width (320px) protection (#34, #74). |
| D7 | Smart tags / action lists | removed (#44, was #35) | — | `spec-vs-parity.md` §1 | Per-control ▾ dropdowns removed as redundant: every action already lives on its own surface (Ctrl+D, inspector Delete/Arrange/rows, items editor, container drop). No engine/schema change. |
| D8 | Modal type editors (Font dialog etc.) | shipped | M | `spec-vs-parity.md` §1 | Font modal through existing setProp/INSERT path (no-op emits nothing, `Regular` kept). Colors already have native pickers; Margin/Padding stays out (C3). (#36) |
| D9 | Object selector dropdown (jump to hidden/buried control) | shipped | S | `spec-property-tabs.md` §7 | Pathed flat list over all controls; change → select() only, no commit; locked select-readable alone. (#37) |
| D10 | Inspector Categorized + Alphabetical views | shipped | S | `spec-property-tabs.md` §§1–2 | Presentational sort/group toggle over flat rows (Flat/Categorized/Alphabetical buttons in the inspector; view state only, switching never commits so the file is byte-identical). Hardcoded per-property category table in canvas (`PROP_CATEGORIES`, VS `[Category]` values; unmapped → Misc); no engine table — categories never cross the protocol, same class as D1/D5. Live drag values look up inputs by id (index lookup breaks outside flat order). (#32) |
| D11 | Click-order dominant selection + Ctrl+click + align-to-dominant | shipped | S | `spec-vs-parity.md` §1 | First-clicked member is the primary (`dominant` class + white handles in a group); align/same-size reference its edges/extents, not the group bbox; Ctrl/Cmd+click toggles membership (toggling off starts no drag); Shift+marquee adds, plain marquee replaces; locked never joins a group. View state only, no protocol change, no ADR. (#47) |
| D12 | Draw-to-create + dblclick-populate + Enter-add + live snap on toolbox drag | shipped | S | `spec-vs-parity.md` §1 | Sticky armed tool (toolbox click toggles, `armed` class + crosshair, Esc disarms, arming posts nothing); click places the default size, drag sizes the rect (live rubber band + Task 3 resize pull on the moving edges, container clamp); dblclick/Enter populate the cascade slot in the drill scope else the selected container else the form (TabControl resolves to its active page); dragover renders live guides and drop lands snapped scale-correct. All adds share the one createControl commit path (designer names, coverage); locked/refused never written. View state + existing path, no schema change, no ADR. (#50) |
| D13 | Inspector bold+Reset, multi common-props, description pane, Events read-only | shipped | S | `spec-property-tabs.md` §§3–4 | Edited-since-load rows bold (`changed` class; recency, not defaultness — no per-type WinForms default table exists canvas-side); Reset deletes the model key and commits (geometry never resets, locked/refused never). Multi-select shows intersection rows only, each under existing single-select gating so every row keeps its INSERT path (agreed value or blank/indeterminate; geometry stays on the group ops; one edit writes all members, one commit). Hardcoded description pane (focus-driven, survives re-render). Events is a read-only note naming the A3 gap — wiring display needs the engine parse step (`spec-property-tabs.md` §4), full scaffolding the #28 ADR. Known engine limit: `generate` deletes scalar statements for no prop but Items, so resetting an already-stated colour/Font is answered "No changes to write". (#51) |
| D14 | Containers: drag-reparent + TabPage targeting + TabStop + outline step-order | shipped | S–M | `spec-vs-parity.md` §1, `spec-features.md` §4 | Hover highlight, drop reparent with parent-relative coord conversion, TabPage active-page resolution, TabStop inspector checkbox (additive schema field, default true), outline step ▲▼ buttons via A1 Controls.Add move. Locked controls/containers never written; ambiguous-reparent refused. ADR 0010. (#52) |
| D15 | WinForms visual fidelity & skeuomorphic styling | shipped | S | `docs/ui-ux-review.md` | Authentic WinForms button bevels, subtle gradients, vertical centering/padding, FlatStyle variants; authentic window title bar chrome (28px, VS Code titlebar theme colors, min/max/close window control box affordances); and design-time hatched/diagonal stripe background with crisp border and lock badge/watermark for locked controls. (#76) |

P0 after #29 is fully shipped: clipboard (A2 #3), grid-size setting, snapline
baselines + Alt-suppress, full edge/center pull on move/resize/multi, and the
SnapLines/grid-only mode (`spec-vs-parity.md` §3, #49) — everything else
formerly listed there shipped (D1–D4, A4, C1/C3) or moved to D5–D10 above.

### E. Verification & oracle tooling

| # | Gap | Status | Cost | Spec | Note |
|---|---|---|---|---|---|
| E1 | Headless Differential Oracle — deterministic matrix + fixture-first gate | shipped (Windows runtime half in CI) | L | `docs/agents/workflow.md` §3 | **The contract is now implemented.** `scripts/gen-differential-matrix.py` synthesises a deterministic permutation matrix — 19 handled types × the 4 dialects × 4 container hierarchies × the bare/full property variants, plus the 4 encoding variants (LF/CRLF × BOM/no-BOM) — reproducible byte-for-byte, and **not committed**: only a divergence is. `test/verify-differential-matrix.sh` drives the engine over it on every platform (4,015 assertions, seconds): structure (parses, refuses nothing, 100% modelled, nests correctly, round-trips byte-identically), properties (**every** property the canvas offers, in BOTH directions — INSERT *and* REPLACE — in the file's own dialect, touching nothing else), form-level properties in all four dialects, and a compile phase that builds the patched output as a real WinForms project. `scripts/run-windows-matrix.sh` is the runtime half: 438 forms and 876 controls in ONE assembly, checked against the real WinForms runtime (`verify/windows-layout/Program.cs --matrix`), on `windows-latest`, and it **renders** each form (`out/matrix-renders/`) — the VS WinForms designer hosts real controls and asks WinForms to paint them, so the designer's pixels ARE the runtime's pixels, which makes a runtime render the reference image for a visual-parity check with no Visual Studio and no GUI automation. The **fixture-first gate** collapses divergences by root cause, writes one reproduction per cause into `fixtures/differential/` with a manifest, prints the `gh issue create` command (it does not commit and does not file: CI has no push authority), and replays every committed fixture as a regression. Black-box only: the Visual Studio designer binaries are never decompiled, and runtime semantics come from the MIT-licensed `dotnet/winforms`. It found two shipped bugs on its first run — `Text` had no INSERT path (#62) and a TextBox's `TextAlign` was written as `ContentAlignment`, which does not compile (#63) — and it also exposed a parse-time performance defect in the declared-style discovery. Control default bounds and heights align with runtime metrics across all leaf controls (TextBox, ComboBox, DateTimePicker, NumericUpDown, TrackBar) with zero exclusions (#65). |
| E2 | UTM Windows sandbox — visual parity vs the Visual Studio WinForms designer | shipped (oracle verified; VS designer workflow unblocked) | L | `docs/agents/workflow.md` §3, `docs/ui-ux-review.md`, `docs/agents/utm-windows.md` | **The oracle half is done and the VS designer workflow is operational.** The Windows 11 ARM64 guest in UTM runs the whole matrix — 438 forms, 876 controls — and its renders are **byte-identical** to `windows-latest`'s, so `docs/agents/workflow.md` §3's portability clause is VERIFIED. Visual Studio Community 2026 is operational in UTM with the full `Microsoft.VisualStudio.Workload.ManagedDesktop` WinForms designer stack (`DesignToolsServer`). `scripts/utm-vs-open.sh` bridges host projects from `~/dev/shared/windows11/` (`Z:\`) to native NTFS (`C:\Users\Public\`, bypassing the WebDAV `MSB3552` recursive globbing trap), verifies `dotnet build`, and launches Visual Studio. The README's "runs natively on macOS, Linux and Windows" is verified (win32-x64 engine parses fixtures in VS Code on Windows). (#64) |

## 3. Deliberately not planned (do not re-propose without an ADR)

- **`Dock`/`Anchor` support** — ADR 0003. Stacking/resize algorithm; simulation refused.
- **`.resx` reading** — ADR 0003. Half-reading is worse than refusing; all-or-nothing.
- **Pixel parity** — ADR 0006. Canvas is a *layout* view; `OnPaint` needs a real Windows HWND.
- **Tray / non-visual types** (`Timer`, `NotifyIcon`, `ImageList`, `ToolTip`,
  `ErrorProvider`, `OpenFileDialog`, `components`) — belong in
  `NonVisualFields`, never the handled table. Not controls, must not render
  as boxes.

## 4. Doc drift (known-stale, fix the doc not the code)

No known drift — swept at `1198005` (#31 closed):
all three formerly untracked specs committed (#30) and corrected to HEAD
(`spec-vs-parity.md` shipped reality + HEAD citations, deferred events;
`spec-example-compatibility.md` 19 types + 100% example coverage + fixed
`verify.sh` citation; `spec-property-tabs.md` citations verified, D10 numbered);
`SCHEMA.md` v1 type table + `README.md` row read 19, `CONTEXT.md`/`AGENTS.md`/`CHANGELOG`
flag the 47.9% ceiling as measured-at-10-types stale, and `spec-features.md` §8b is marked
historical (tracker is the todo list). `git status` carries no `??` entries.

Re-swept at `a93607f` (the differential-oracle wave): the one drift this wave found was
the oracle contract itself — `docs/agents/workflow.md` §3 described a system that did not
exist, which is why §3 now names the implementation and §2 E1 tracks it. `SCHEMA.md` is
unchanged by this wave: the schema's shape did not move, only the patcher's coverage of
it (`Text` gained an INSERT path; `TextAlign` is now type-aware). `AGENTS.md` gained the
matrix tier in "Verifying" and in the "which tier proves what" list.

## 5. How to use this file

1. Starting work? Find or add the row first.
2. Shipping? Flip the row to §1-style "shipped" wording (or delete it into §1)
   **in the same commit** — reviewer should be able to check the row diff
   against the code diff.
3. Discovering a new gap (new corpus form, new divergence)? Add a row with
   status + cheapest spec pointer, even if the fix is out of scope. An
   unfiled gap is how silent discards ship.

## Verification tier reference (from review Agent 2)
- `compile`: builds patched file as real WinForms (`net10.0-windows`) — proves C# syntax valid
- `roslyn`: surgical patch accuracy (exact changed lines, untouched structures survive)
- `matrix` (headless): property coverage over all permutations (4,135 assertions, all platforms)
- `layout` (Windows CI): runtime geometry comparison against real VS WinForms designer pixels
