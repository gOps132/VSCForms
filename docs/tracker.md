# Feature & compatibility tracker

**Living document.** This is the single list of what VSCForms can do, what it
lacks, and what it deliberately refuses. The `docs/spec-*.md` files are the
*reasoning*; this file is the *current state*. When they disagree, this file
wins on state and the spec wins on rationale — then file a fix so they agree.

**Rule (also in `AGENTS.md`): every feature change updates this file in the
same change.** A shipped capability with a stale row here is a bug in the
change, not in the docs.

Issue map: [#1](https://github.com/gOps132/VSCForms/issues/1) (children #2–#19,
one per gap row). Triage per `docs/agents/triage-labels.md` before claiming.

Last verified: `c47e209` (doc-drift sweep #19: 19 handled types; 47.9% flagged stale;
`spec-features.md` §8b marked historical). Re-verify by reading `engine/src/TypeTable.cs`,
`extension/media/canvas.js` (`HANDLED`), `engine/src/Schema.cs`,
`engine/src/Patcher.cs`, and `SCHEMA.md` — not by memory.

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
  INSERT path): geometry, Text, TabIndex, Name, Enabled, Visible, BackColor,
  ForeColor, Font (per-argument patch), Items (ComboBox/ListBox via
  `Add`/`AddRange`), TextBox Multiline/ReadOnly/MaxLength/PasswordChar/
  ScrollBars, leaf Minimum/Maximum/Value (TrackBar, ProgressBar,
  NumericUpDown), Checked, TextAlign, BorderStyle, AutoSize, form
  ClientSize/Text/BackColor.
- **Engine commands:** `parse`, `generate`, `ping`, `new` (project
  generation), `rename` (Designer File + code-behind member-access receivers
  only, ADR 0008).
- **Canvas toolset:** drag, 8-handle resize, snap (grid + edges, toggleable),
  multi-select + marquee, align/distribute, `Cmd/Ctrl+D` duplicate, zoom
  (`Cmd/Ctrl`+wheel, `+/-`/`0`, Fit, 0.25–4.0), space/middle-drag pan, rulers,
  zoom bar, Escape deselect, tab-strip activation, drill-down selection for
  nested containers, coverage banner (never hideable), locked boxes with
  reasons, rename field, items list editor.
- **Project & run:** `VSCForms: New Project…` (classic `.sln`, BOM/CRLF-safe
  csproj edit), `VSCForms: Run in Wine` + editor play button + `F5`.
- **Refusals (correct behaviour, not gaps):** `ApplyResources` (41.6% of
  corpus), `Dock`/`Anchor` (40.9%). See §3.

## 2. Gaps to implement

Status values: `missing` (accepted, unstarted) · `partial` (shipped subset
exists) · `deferred+ADR` (do not start without an ADR amendment).

### A. Structural features

| # | Gap | Status | Cost | Spec | Note |
|---|---|---|---|---|---|
| A1 | Z-order (Bring to Front / Send to Back) | deferred+ADR | M + protocol | `spec-features.md` §4, `spec-canvas-qol.md` §4 | `generate` diffs by `id`; reorder is unrepresentable. Delete+insert would destroy unmodelled props. Needs patcher move + ADR. |
| A2 | Clipboard copy/paste | missing | S–M | `spec-canvas-qol.md` §8 decision 5 | `Cmd/Ctrl+D` duplicate shipped and is the 80%. Clipboard needs webview permissions + async round-trip. Follow-up only if duplicate proves insufficient. |
| A3 | Event scaffolding (`btn_Click` generation) | missing | M | `spec-features.md` §4 | Deliberately absent v1. Bigger claim on hand-written `Form1.cs` than rename; ADR 0008 is the bounding precedent. |
| A4 | Tab-order editing UI | missing | S | `spec-features.md` §4 | `TabIndex` is in schema + canvas; the *ordering* UI does not exist. |
| A5 | `ComboBox`/`ListBox` follow-ups: `SelectedIndex`/`SelectedItem`, `DropDownStyle`, drag-reorder | missing | S–M | `spec-items.md` §0, §7 | Explicitly out of the `Items` pass. Each is a separate change. |
| A6 | Resource/image editing (`PictureBox` images) | missing | L | `spec-features.md` §4 | Needs image serialisation. Out of scope. |
| A7 | `UserControl` composition | missing | L | `spec-features.md` §4 | A nested designer — genuinely a different product. |

### B. Control types (from `spec-example-compatibility.md` B1)

| # | Gap | Status | Cost | Note |
|---|---|---|---|---|
| B1 | `SplitContainer` | deferred+ADR | M/L | Needs `Panel1/Panel2.Controls.Add` parser mapping + optional `SplitterDistance` schema addition. |
| B2 | `TableLayoutPanel` / `FlowLayoutPanel` | deferred+ADR | L | Rendering children absolutely contradicts ADR 0003. Honest options: new `layout-panel` refusal, or full simulation. Do not start without an ADR amendment. |
| B3 | `MenuStrip` / `ToolStrip` / `StatusStrip` / `ContextMenuStrip` / `BindingNavigator` | missing | M | Items are not `Control`s (no `Location`/`Size`) — unmodellable without a new schema shape. Cosmetic; host forms usually refuse anyway. |
| B4 | `DataGridView` columns (6 types), `ListView`/`TreeView` nodes+items, `PropertyGrid`, `WebBrowser`, `BindingSource` | partial | M | Placeholders shipped (§1). Contents are collections the schema cannot express; interior stays preserved-but-invisible. Document as visibility win, not editing. |
| B5 | T1 leaf inputs: `LinkLabel`, `RichTextBox`, `MaskedTextBox`, `CheckedListBox`, `MonthCalendar`, `H/VScrollBar`, `DomainUpDown` | missing | S each | Template-only per type (TypeTable row + canvas row + renderer + fixture). `CheckedListBox`/`DomainUpDown` need their own collection spec — not covered by `spec-items.md`. Pick by fresh-corpus frequency, not by guess. |
| B6 | `ToolStripContainer`/`ToolStripPanel`, `Splitter` | missing | M | Same layout-simulation caveat as B2 at lower frequency. |
| B7 | `DateTimePicker` value/format (`Value`, `Format`, `CustomFormat`) | missing | S–M | Shipped leaf set is geometry + shared min/max/value where applicable; `DateTimePicker` shows no value by decision (`spec-leaf-widgets.md` §6). Modelling it is a separate change. |

### C. Silent-divergence risks (zero handling today)

| # | Gap | Spec | Note |
|---|---|---|---|
| C1 | `RightToLeft` mirroring | `spec-example-compatibility.md` B2 | Preserved-but-invisible; canvas shows LTR. Needs at minimum a warning. |
| C2 | `TableLayoutPanel` children with default `Dock`/`Anchor` shown flat | `spec-example-compatibility.md` B2 | Flat rendering contradicts layout semantics. Feeds the B2 refusal decision. |
| C3 | Preserved-but-invisible form props: `AutoScaleMode/Dimensions`, `AutoSize`, `Margin/Padding`, `ClientSize` vs `Size` | `spec-example-compatibility.md` B2 | Survive round trips; invisible in canvas. Any surfacing must not imply editing that isn't wired. |

## 3. Deliberately not planned (do not re-propose without an ADR)

- **`Dock`/`Anchor` support** — ADR 0003. Stacking/resize algorithm; simulation refused.
- **`.resx` reading** — ADR 0003. Half-reading is worse than refusing; all-or-nothing.
- **Pixel parity** — ADR 0006. Canvas is a *layout* view; `OnPaint` needs a real Windows HWND.
- **Tray / non-visual types** (`Timer`, `NotifyIcon`, `ImageList`, `ToolTip`,
  `ErrorProvider`, `OpenFileDialog`, `components`) — belong in
  `NonVisualFields`, never the handled table. Not controls, must not render
  as boxes.

## 4. Doc drift (known-stale, fix the doc not the code)

No known drift — swept at `c47e209` (#19 closed):
`SCHEMA.md` v1 type table + `README.md` row read 19, `CONTEXT.md`/`AGENTS.md`/`CHANGELOG`
flag the 47.9% ceiling as measured-at-10-types stale, and `spec-features.md` §8b is marked
historical (tracker is the todo list).

## 5. How to use this file

1. Starting work? Find or add the row first.
2. Shipping? Flip the row to §1-style "shipped" wording (or delete it into §1)
   **in the same commit** — reviewer should be able to check the row diff
   against the code diff.
3. Discovering a new gap (new corpus form, new divergence)? Add a row with
   status + cheapest spec pointer, even if the fix is out of scope. An
   unfiled gap is how silent discards ship.
