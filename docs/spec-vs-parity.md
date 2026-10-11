# VS Designer parity — feature inventory vs VSCForms

**Status:** PROPOSED — for review before any code. Read alongside
[`tracker.md`](tracker.md) (state wins) and [`SCHEMA.md`](../SCHEMA.md) (contract wins).
This file is the *reasoning*; the tracker is the *current state*.

**Sources:** Microsoft Learn designer overview, design-time overview, walkthrough
tutorial, snaplines / TLP / Dock-Anchor / layout / toolbox / properties /
tab-order how-tos, plus `microsoft/winforms-designer-extensibility`.
Full URL list in §5. Repo state verified against `docs/tracker.md`,
`engine/src/TypeTable.cs:13-43`, `extension/media/canvas.js` (`HANDLED:145-171`,
canvas toolset per tracker §1).

## 0. Facts this rests on

- **19 handled types + Form:** Button, Label, TextBox, CheckBox, RadioButton,
  ComboBox, ListBox, PictureBox, Panel, GroupBox, TrackBar, ProgressBar,
  NumericUpDown, DateTimePicker, TabControl, TabPage, DataGridView, ListView,
  TreeView. Containers: Panel, GroupBox, TabControl, TabPage.
  (`TypeTable.cs:13-43`, `canvas.js:145-171`, `SCHEMA.md:253-268`.)
- **Properties wired end-to-end** (parse + patch + inspector, each with INSERT
  path): geometry, Text, TabIndex, Name, Enabled, Visible, BackColor, ForeColor,
  Font (per-argument), Items (`Add`/`AddRange`), TextBox flags, leaf
  Min/Max/Value, Checked, TextAlign, BorderStyle, AutoSize, form
  ClientSize/Text/BackColor. (`tracker.md:31-37`, `SCHEMA.md:89-117`.)
- **Refusals dominate:** `ApplyResources` 41.6%, `Dock`/`Anchor` 40.9% of corpus —
  refused forms are read-only regardless of type coverage. Editable population
  ≈ 17.5% as an upper bound (refusal overlap unknown — a form can carry both).
  (ADR 0003; `tracker.md:49-52`.)
- **Invariants (AGENTS.md, ADRs 0001–0008):** Designer File is source of truth,
  surgical TextChanges only; write back in file's own dialect; byte-identity
  (BOM/CRLF/indent); never write a locked control; refused form → `ok:false`;
  stdout is NDJSON; no canvas undo stack; no `InitializeComponent` regen;
  rename is a separate command, never a schema commit; appearance patched
  per-argument.

## 1. Parity table

`shipped` = in tracker §1 · `partial` = subset shipped · `missing` = accepted gap,
maps to tracker §2 row where shown · `refused-by-ADR` = correct behaviour, not a gap.

### Canvas / surface

| VS feature | VSCForms | Note |
|---|---|---|
| Single select, 8-handle resize, drag move, arrow nudge | shipped | `canvas.js:576-596,656-668,771-776,1002-1046` |
| Multi-select + marquee, dominant control | shipped | schema-order deterministic, `canvas.js:239-240,726-739` |
| Rubber-band selection | shipped | marquee |
| Align (6) + Distribute (2) | shipped | `canvas.js:796-944` |
| Make Same Size / Center in Form / Equal Spacing | shipped | D3 #22 — same-size copies schema-order-first extents (`canvas.js:818-829,930-944`); center per-control within immediate parent frame (`canvas.js:800-814,867-871`); Equal Spacing covered by Distribute (raw gaps) |
| Format → Order (Bring to Front / Send to Back) | deferred+ADR | A1 #2 — `generate` diffs by `id`, reorder unrepresentable |
| Ctrl+arrow snapline jump; Shift+arrow / Ctrl+Shift+arrow resize | shipped | D4 #23 — Ctrl/Cmd jumps GRID*5, Shift resizes east/south edges min 2 (`canvas.js:576-596,771-788`); Shift no longer means 2× nudge |
| Snaplines (edges) + grid | partial | shipped toggleable (`canvas.js:36-61,1683-1687`); no baselines, no Margin/Padding encoding, no Alt-suppress, off-in-TLP |
| Size/location readout | shipped | D1 #20 — read-only single-selection X/Y + W×H in form units, multi keeps count (`canvas.js:741-757`) |
| In-place Text edit | shipped | D2 #21 — dblclick overlay via Text setProp/INSERT path (`canvas.js:553-575,681-710`); never for locked/refused, containers, or NO_TEXT |
| Copy/paste (clipboard) | shipped | A2 #3 — `copy`/`requestPaste`/`paste` host round-trip; `Cmd+D` duplicate remains the in-form kernel |
| Delete | shipped | `canvas.js:586-589,1542` |
| Draw-to-create / drag-from-toolbox w/ live snaplines | partial | Controls toolbox with drag-to-add shipped (`canvas.js:330-353,1484,1715-1730`); draw-to-create and live snaplines still missing |
| Container containment + drill-down | shipped | nested containers, ring highlight (`canvas.js:510,553-575`) |
| Tab Order mode + TabIndex/TabStop | shipped | A4 #5 — mode toggle with badges, click-to-assign via TabIndex INSERT path (`canvas.js:545-547,651-654,1700-1714`); TabStop not modelled |
| Component tray | refused-by-ADR | NonVisualFields, never rendered (`tracker.md:111-114`) |
| UserControl Test Container / composition | missing | A7 #8 — different product |

### Toolbox / outline / properties / actions

| VS feature | VSCForms | Note |
|---|---|---|
| Toolbox (Ctrl+Alt+X, search, Choose Items, custom controls) | partial | canvas Controls toolbox + search/filter + Ctrl/Cmd+Alt+X shipped (D5 #33); Choose Items / custom controls parked (need engine type discovery) |
| Double-click populate containers | missing, no row | dblclick is drill-down / text-edit, not populate |
| Document Outline (Ctrl+Alt+T, F2 rename) | shipped | D6 #34 — read-only hierarchy + F2 rename; drill-down + rename field underneath; drag-reparent gated on A1 |
| Properties inspector (single-select, INSERT paths) | partial | no multi-select common-props, no Margin/Padding/Font expanders |
| Collection editors (… dialogs) | partial | items list editor only (`canvas.js:1210-1256`) |
| Events lightning-bolt + double-click default stub + bulk stubs | missing | A3 #4 — deliberately absent v1 |
| Visual Dock/Anchor editors | refused-by-ADR | ADR 0003 |
| Smart tags / action lists | shipped | D7 #35 — handled-type tags reusing existing paths; TLP columns, SplitContainer orientation, Dock-in-Parent parked behind ADRs |
| Modal type editors | shipped | D8 #36 — Font modal through existing path; colors already have native pickers |
| Data Sources window | missing, no row | .NET Framework-only per docs; out of scope |

### Layout

| VS feature | VSCForms | Note |
|---|---|---|
| TabControl/TabPage | shipped | modelled + tab-strip |
| Panel vs GroupBox | shipped | — |
| SplitContainer (orientation, splitter drag, Panel1/Panel2) | deferred+ADR | B1 #9 |
| TableLayoutPanel / FlowLayoutPanel | deferred+ADR | B2 #10 — absolute rendering contradicts ADR 0003; needs `layout-panel` refusal or full sim |
| ToolStripContainer/Panel, Splitter | missing | B6 #14 — same caveat as B2 |
| Menu/Tool/Status/Context strips, BindingNavigator | missing | B3 #11 — items aren't Controls, new schema shape needed |
| Grid columns, list/tree nodes, PropertyGrid, WebBrowser, BindingSource | partial | B4 #12 — placeholders display-only by design |
| T1 leaf inputs (LinkLabel, RichTextBox, MaskedTextBox, CheckedListBox, MonthCalendar, H/VScrollBar, DomainUpDown) | missing | B5 #13 — template-only each |
| DTP Value/Format/CustomFormat | missing | B7 #15 — no-value by decision (`spec-leaf-widgets.md` §6) |
| ComboBox/ListBox SelectedIndex/SelectedItem, DropDownStyle, drag-reorder | missing | A5 #6 |
| Dock / Anchor | refused-by-ADR | ADR 0003 |
| Margin / Padding (editing) | refused-by-ADR as editing | C3 #18 — preserved-but-invisible; read-only surfacing shipped (`DesignerDocument.cs:357-413`) |
| AutoSize rules, Location/Size/Min-Max, ClientSize-vs-Size, AutoScaleMode/Dimensions | partial | AutoSize prop + geometry shipped; rest read-only disclosure via warnings (C3 #18, `DesignerDocument.cs:357-413`) |
| RightToLeft mirroring | shipped | C1 #16 — warns via banner, form stays editable shown LTR, no mirroring simulation (`DesignerDocument.cs:330-353`, `canvas.js:302-304`) |
| TLP children w/ default Dock/Anchor shown flat | missing | C2 #17 — feeds B2 refusal |

### Code-behind / resx / host / settings

| VS feature | VSCForms | Note |
|---|---|---|
| Double-click default event stub | missing | A3 #4 |
| Form `.resx` designer-owned (ApplyResources 41.6%) | refused-by-ADR | ADR 0003; A6 #7 for images |
| Out-of-process DesignToolsServer | n/a | no designer host; Roslyn parse+patch only |
| Settings: grid size, snap-to-grid, LayoutMode SnapLines vs SnapToGrid | partial | snap toggle only; no grid-size setting, no mode switch |

## 2. Design deltas (invariants-respecting)

- **Make Same Size / Center / Equal Spacing (shipped D3 #22):** pure geometry commits;
  patcher replaces Location/Size arg lists only (`SCHEMA.md:374`). Center is
  per-control within its immediate parent frame — the form's `clientSize` at top
  level, else the parent's modelled width/height (`canvas.js:800-814,867-871`).
  Spacing equalises raw gaps only — must not invent Margin
  gaps. No ADR.
- **Ctrl+arrow jump, Shift+arrow resize (shipped D4 #23):** keyboard gestures emitting
  the same TextChanges as drag/resize. Locked never joins multi-select. No ADR,
  no schema change.
- **Snapline upgrade — baselines, Alt-suppress (new row):** render-only guides.
  Margin/Padding readable but not editable until C3 decides surfacing-vs-editing.
  No ADR; full Margin/Padding *layout* would need one.
- **Size/location readout (shipped D1 #20):** read-only status from schema geometry
  (`SCHEMA.md:90-94`). Zero patcher surface; show form units at any zoom. No ADR.
- **In-place Text edit (shipped D2 #21):** overlay committing to existing
  `setProp(Text)` INSERT path. Locked never gets overlay. Escape cancels with no
  generate (`SCHEMA.md:213`). No ADR.
- **Clipboard (A2 #3):** duplicate is the in-form kernel; clipboard = ControlNode
  JSON via host round-trip (webview permissions + async). Cross-form paste
  re-runs dialect detection (`SCHEMA.md:337-349`); collisions get `uniqueId`.
  No ADR.
- **Tab-order UI (shipped A4 #5):** TabIndex in schema (`SCHEMA.md:98`); UI is a mode
  overlay drawing badges, click-to-assign TabIndex-only TextChanges. Read-only
  when refused. No ADR.
- **Events (A3 #4, deferred per #28):** bigger `Form1.cs` claim than rename;
  ADR 0008 is the bounding precedent, and honest refuse-rather-than-guess would
  refuse so often the shipped value collapses to a refusal path. No narrow ADR
  now; revisit only with concrete demand plus a narrow ADR scoping the insertion
  point and refusal conditions. Designer File never touched for events.
- **SelectedIndex/DropDownStyle (A5 #6):** per-argument patch like Font
  (`SCHEMA.md:224-230`); INSERT path mandatory. No ADR.
- **DTP value (B7 #15):** new optional schema field + per-arg patch; unset ⇒
  omitted, never null (`SCHEMA.md:127-128`). Reverses a documented decision —
  update `spec-leaf-widgets.md` §6 + tracker row in same commit. No ADR.
- **RTL warning (shipped C1 #16):** display-only banner; no mirroring simulation. No ADR.
- **Invisible-props surfacing (shipped C3 #18):** read-only disclosure
  (AutoScaleMode/Dimensions, Margin/Padding, Size-vs-ClientSize). Any field shown
  must state read-only — surfacing without wiring repeats the BackColor/Font
  silent-discard bug. Editing any of them is separate. No ADR for read-only.
- **Z-order (A1 #2):** reorder unrepresentable in id-diffed `generate`
  (`SCHEMA.md:236-247`); delete+insert destroys unmodelled props (ADR 0001).
  **Needs ADR** + patcher move op first.
- **SplitContainer (B1 #9):** parser maps `Panel1/Panel2.Controls.Add` to two
  slots + optional `SplitterDistance`; splitter drag = single-arg patch.
  Orientation flip = move semantics at small scale. **Needs ADR.**
- **TLP/FLP (B2 #10) + B6 + C2:** absolute rendering contradicts layout
  semantics — honest options are a new `layout-panel` refusal or full simulation
  (ADR 0003 chose refusal). **Needs ADR amendment; do not start otherwise.**
- **Strips (B3 #11):** items have no Location/Size — new schema shape
  (collections, not ControlNodes). Likely locked-box or refusal. **Needs ADR**
  (contract file).
- **Grids/lists interiors (B4 #12):** placeholders display-only by design
  (`SCHEMA.md:266-268`); columns/nodes are unmodellable collections. Visibility
  labelling only, never fake editing. Column editing ⇒ **needs ADR.**
- **T1 leaves (B5 #13):** template-only per type (TypeTable + HANDLED + renderer
  + fixture; `verify.sh` enforces both directions). CheckedListBox/DomainUpDown
  need own collection spec (not `spec-items.md`). Pick by fresh-corpus frequency.
  No ADR.
- **Resources/images (A6 #7):** image serialisation + half of ApplyResources forms
  in `.resx` — ADR 0003 all-or-nothing. **Needs ADR; default stays refuse.**
- **UserControl (A7 #8):** nested designer crosses the one-file surgical-patch
  boundary. **Needs ADR** (scope, not mechanics).

## 3. Proposed phasing

- **P0 — small, no ADR:** grid-size setting, snapline
  baselines + Alt-suppress. Shipped and removed from this list:
  clipboard (A2 #3), tab-order UI (#5), in-place text (D2 #21), size/location readout (D1 #20),
  Make Same Size / Center / Equal Spacing (D3 #22), Ctrl+arrow jump +
  Shift+arrow resize (D4 #23), RTL warning (#16, display-only),
  invisible-props read-only surfacing (#18). The remaining unscoped candidates
  are tracker rows D5–D10 with their own issues. Verify first: Align
  6 + Distribute 2 already shipped — do not re-implement.
- **P1 — medium, no ADR (spec updates only):** events deferred (#4),
  SelectedIndex/DropDownStyle/drag-reorder split per item
  (#6), DTP value/format (#15), T1 leaves by corpus frequency (#13), B4 labelling
  (#12, no editing).
- **P2 — large, ADR-required:** Z-order patcher move (#2), SplitContainer (#9),
  TLP/FLP + B6 + C2 (#10/#14/#17, one layout-simulation ADR), strips schema shape
  (#11), resources/.resx (#7), UserControl (#8).

## 4. Non-goals reaffirmed

- `Dock`/`Anchor` simulation, `.resx` reading, pixel parity, tray/non-visual
  rendering, local canvas undo stack, `InitializeComponent` regen, dialect
  normalisation / type-name rewriting. (ADRs 0001, 0003, 0004, 0005, 0006.)

## 5. Sources consulted

1. Designer overview (VS docs) — https://learn.microsoft.com/en-us/visualstudio/designers/windows-forms-designer-overview?view=visualstudio
2. Design-time overview — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-overview
3. Designer tutorial — https://learn.microsoft.com/en-us/visualstudio/designers/walkthrough-windows-forms-designer?view=visualstudio
4. .NET vs Framework designer differences — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-differences-framework
5. Designer actions — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/perform-common-tasks-design-actions
6. Snaplines — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/walkthrough-arranging-controls-on-windows-forms-using-snaplines
7. TableLayoutPanel — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/walkthrough-arranging-controls-on-windows-forms-using-a-tablelayoutpanel
8. Padding/margins/AutoSize — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/windows-forms-controls-padding-autosize
9. Control layout (Dock/Anchor/containers/AutoSize) — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/layout
10. Grid options — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-set-grid-options-for-all-windows-forms
11. Toolbox — https://learn.microsoft.com/en-us/visualstudio/ide/toolbox?view=visualstudio
12. Properties window — https://learn.microsoft.com/en-us/visualstudio/ide/properties-window?view=visualstudio
13. Resize — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-resize-controls-on-windows-forms
14. Dock and anchor — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-dock-and-anchor
15. Align multiple controls — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-align-multiple-controls-on-windows-forms
16. Tab order — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-set-the-tab-order
17. Layer objects (z-order) — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-layer-objects-on-windows-forms
18. UserControl Test Container — https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-test-the-run-time-behavior-of-a-usercontrol
19. Document Outline — https://learn.microsoft.com/en-us/visualstudio/ide/viewing-the-structure-of-code?view=visualstudio
20. Data Sources — https://learn.microsoft.com/en-us/visualstudio/data-tools/add-new-data-sources?view=visualstudio
21. Extensibility repo — https://github.com/microsoft/winforms-designer-extensibility
