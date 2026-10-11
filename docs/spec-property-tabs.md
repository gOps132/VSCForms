# Properties-window tabs & companion surfaces: research

**Status:** RESEARCH — no code. Informs tracker row **A3** (Event scaffolding,
`missing`), decision issue **#28** (narrow ADR or defer), and filing issue
**#29** (D5+ rows). Read with `docs/tracker.md` (state) and `CONTEXT.md`
(invariants); when this file disagrees with the tracker on state, the tracker
wins.

**Sources:** every VS-behavior claim below cites the primary source that owns
it (Microsoft Learn IDE/SDK/API reference or the public WinForms designer
source). VSCForms-local claims cite repo files instead. Seed:
[Extending Properties](https://learn.microsoft.com/en-us/visualstudio/extensibility/internals/extending-properties?view=visualstudio)
— the Properties window is "a universal property browser for COM and COM+
components", opened with **F4**, for "configuration-independent, design-time
properties and events of selected objects". The toolbar inventory
(Categorized, Alphabetical, Property Pages, Properties, Events, object-name
dropdown, description pane, gray = read-only, multi-select intersection) is
enumerated in the
[IDE Properties-window reference](https://learn.microsoft.com/en-us/visualstudio/ide/properties-window).

**Baseline (what exists today):** `renderInspector()`
(`extension/media/canvas.js:1106-1318`) is one flat stack — no tabs, no
categories, four `h4` sub-heads only (Appearance `:1165`, Items `:1212`,
TextBox `:1261`, Range `:1277`, Arrange `:1306`) plus a text filter
(`setupInspectorFilter :1442-1449`). All edits converge on `commit()`
(`:762-769` → host `extension/src/extension.ts:249-293` → `engine.generate`).
Full per-type property inventory: `engine/src/Schema.cs:46-75`,
parse `engine/src/DesignerDocument.cs:534-692`, patch
`engine/src/Patcher.cs:172-406`.

---

## 1. Categorized view — presentational, safe

- **VS mechanism.** A *sort mode*, not a tab: "Categorized — Lists all
  properties and property values for the selected object, by category…"
  ([IDE reference](https://learn.microsoft.com/en-us/visualstudio/ide/properties-window)).
  Backed by the
  [`PropertySort.Categorized`](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.propertysort)
  enum on the [`PropertyGrid`](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.propertygrid)
  control; switching sort touches no files.
- **Where categories come from.** `[Category("…")]` on the member itself
  ([`CategoryAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.categoryattribute)).
  Predefined set: `Action, Appearance, Behavior, Data, Default, Design,
  DragDrop, Focus, Format, Key, Layout, Mouse, WindowStyle`; uncategorized
  members fall in **Misc**. Custom names create new categories.
- **File edits.** None — pure view state.
- **VSCForms needs.** Nothing in the patcher. The catch: category metadata
  lives in .NET attributes, which the engine cannot load (type resolution is
  purely syntactic; unrecognised types lock — `AGENTS.md`). Categories would
  have to be a hardcoded per-property table in `TypeTable.cs` + canvas
  `HANDLED`, synced both directions (sync already enforced by
  `test/verify.sh`). Read-only presentation, zero patcher surface — same
  change class as shipped D1 readout. Cost **S**, no ADR.

## 2. Alphabetical view — presentational, safe

- **VS mechanism.** The sibling sort mode: "Alphabetically sorts all
  design-time properties and events" (`PropertySort.Alphabetical`,
  [same enum page](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.propertysort)).
  Cell editing is identical to Categorized view; dimmed (read-only) cells
  reject edits in both.
- **File edits.** None for the sort itself.
- **VSCForms needs.** An inspector sort toggle changes no `generate` code.
  Cost **S**, no ADR. (Categorized + Alphabetical can ship as one change:
  one grouping key + one sort toggle over the existing flat rows.)

## 3. Properties tab (standard grid) — this is the shipped path

- **VS mechanism.** The default `PropertiesTab` filters to browsable members
  (`BrowsableAttribute.Yes`) via `TypeDescriptor.GetProperties`
  ([`PropertiesTab.cs`](https://source.dot.net/System.Windows.Forms/System/Windows/Forms/Controls/PropertyGrid/PropertyGridInternal/PropertiesTab.cs.html));
  hidden rule in
  [`BrowsableAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.browsableattribute).
  Default selected row is the `[DefaultProperty]` member, else `Name`
  ([`DefaultPropertyAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.defaultpropertyattribute)).
  Per-property editors attach via `[Editor]`
  ([`EditorAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.editorattribute));
  gray rows are read-only (`[ReadOnly(true)]` or no setter,
  [`ReadOnlyAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.readonlyattribute));
  the bottom pane shows `[Description]` text
  ([`DescriptionAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.descriptionattribute)).
  Multi-select shows only common properties
  ([`SelectedObjects`](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.propertygrid.selectedobjects))
  — VSCForms already mirrors this by showing group ops only
  (`canvas.js:1115-1125`, "would be a lie unless every selected control
  happens to agree").
- **File edits (C#).** Property edits serialize into `InitializeComponent`
  in `.Designer.cs` (CodeDOM tree → generated code,
  [CodeDOM modernization doc](https://github.com/dotnet/winforms/blob/main/docs/designer/modernization-of-code-behind-in-OOP-designer/modernization-of-code-behind-in-oop-designer.md)).
  `Form1.cs` is **untouched**. Visibility is attribute-driven (`Visible` /
  `Hidden` / `Content`,
  [`DesignerSerializationVisibilityAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.designerserializationvisibilityattribute)).
- **VSCForms needs.** Already shipped (tracker §1). Constraints that stay:
  surgical `TextChange`s only (invariant 1), byte-identity incl. BOM/CRLF
  (invariant 3), file's own dialect (invariant 2), every offered property
  needs an INSERT path (BackColor/Font lesson), per-argument patching for
  multi-spelling constructions (ADR 0005). Refused forms stay refused — VS
  would show `Dock`/`Anchor` editors, but we must not simulate them
  (ADR 0003).

## 4. Events tab (lightning bolt) — row A3, the only tab that writes `Form1.cs`

- **VS mechanism.** `EventsTab : PropertyTab`, resolved via
  `IEventBindingService` (host → site → context), one string-valued
  `PropertyDescriptor` per `EventDescriptor`
  ([`EventsTab.cs`](https://github.com/dotnet/dotnet/blob/2b7dacb6b5a5385790e371bf2655842f7a5918d1/src/winforms/src/System.Windows.Forms/System/Windows/Forms/Design/EventsTab.cs),
  [`IEventBindingService`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.design.ieventbindingservice)).
  Available only with a form/control designer active in a C# project
  ([IDE reference](https://learn.microsoft.com/en-us/visualstudio/ide/properties-window)).
  COM objects are excluded (`Marshal.IsComObject` check) — they get property
  pages instead (§5).
- **Double-click, blank cell → two coordinated writes**
  ([how-to](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-add-an-event-handler)):
  (a) wiring line in `InitializeComponent`,
  `this.button1.Click += new System.EventHandler(this.button1_Click);`;
  (b) stub method in code-behind `Form1.cs`, editor navigates there.
  Name via `CreateUniqueMethodName` — language-compatible, collision-free
  ([`CreateUniqueMethodName`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.design.eventbindingservice.createuniquemethodname));
  conventionally `<control>_<Event>`.
- **Double-click, filled cell → navigate** (`ShowCode`, defers to
  `Application.Idle`; false when unbound,
  [`EventBindingService.cs`](https://github.com/dotnet/winforms/blob/e4ede9b8979b9d2b1b1d4383f30a791414f0625b/src/System.Windows.Forms.Design/src/System/ComponentModel/Design/EventBindingService.cs)).
- **Double-click the control itself → default event** (`Click` for Button,
  `Load` for Form) via `[DefaultEvent]`
  ([`DefaultEventAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.defaulteventattribute)).
  **Blocked today:** dblclick is taken by in-place Text edit (shipped #21,
  `beginTextEdit canvas.js:681-710`) — reclaiming it for default-event
  scaffolding is a UX conflict to resolve, not a free gesture.
- **Dropdown lists compatible methods** (`GetCompatibleMethods`); one
  handler may serve many events. **Clearing = Reset**, not code deletion:
  "you can't just delete handler code … it's still referenced by the
  designer" (same how-to); deleting behind the designer's back breaks load
  ([designer errors](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-errors)).
- **Rename does NOT rename handlers** — "not automatically propagated …
  This is expected behavior … not a bug"
  ([Q&A 5621477](https://learn.microsoft.com/en-us/answers/questions/5621477/visual-studio-winforms-control-name-changes-not-pr));
  method names are free text, one method can serve several controls
  ([Q&A 115849](https://learn.microsoft.com/en-us/answers/questions/115849/visual-studio-handling-renaming-of-items-with-desi)).
  VSCForms refusing to guess on rename (ADR 0008) **matches** VS, not
  contradicts it.
- **VSCForms state today.** Wirings (`+=`) fall into the generic assignment
  branch (`DesignerDocument.cs:225-230`) but `ReadProperties` (`:534-692`)
  reads only known keys, so they never reach the schema — preserved
  byte-identical through `generate` (patcher has zero event handling by
  design), deleted with their control (`DeleteControl`, `Patcher.cs:941-970`),
  receiver-renamed by `rename` (`Renamer.cs:187-202`; proven in
  `test/verify-rename.sh:89-119` where `btnCalculate_Click` stays stale
  deliberately). No refusal, no inspector row, no warning.
- **Sequencing (invariant-safe, cheapest first):**
  1. **Read-only Events display** — parse `+=`/`-=` wirings into the schema
     as preserved-but-visible strings. Zero new write surface, no ADR.
     (Closes the visibility gap: wirings are currently invisible.)
  2. **Reset** — designer-file-only wiring delete through the existing
     surgical deleter. Same path class as property edits.
  3. **Full scaffolding** — new `generate` op writing the `+=` line in the
     file's own dialect **plus** a `Form1.cs` stub: the second operation ever
     to touch hand-written code after rename. Needs unique-name generation,
     `ShowCode`-equivalent navigation, and an ADR amendment (this is what
     issue #28 decides). Cost **M** for the full step; steps 1–2 are **S**.

## 5. Property Pages — correctly absent, do not implement

Two features share the name; neither applies:

- **(a) Project-level pages** (Common vs Configuration Properties;
  `ISpecifyPropertyPages`/`IVsPropertyPage`; empty when unsupported —
  [property-pages](https://learn.microsoft.com/en-us/visualstudio/extensibility/internals/property-pages)).
  Concerns `.csproj`/solution configuration, which the engine touches only
  for `new`-project generation, never editing.
- **(b) Per-component editors** (`[Editor(typeof(…), typeof(ComponentEditor))]`,
  [`ComponentEditor`](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.componenteditor);
  WinForms modal flavor
  [`WindowsFormsComponentEditor`](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.design.windowsformscomponenteditor)
  hosting `ComponentEditorPage`s in a tree-view dialog;
  ActiveX specialization
  [`AxComponentEditor`](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.axhost.axcomponenteditor)).
  The grid enables the button only when pages exist (`NeedsComponentEditor`
  checks `MapPropertyToPage`/`GetPages`,
  [`Com2ComponentEditor.cs`](https://source.dot.net/System.Windows.Forms/System/Windows/Forms/ComponentModel/COM2Interop/COM2ComponentEditor.cs.html));
  no association ⇒ disabled/empty. On OK/Apply the delta serializes to
  `InitializeComponent` like any property edit; `Form1.cs` untouched.
- **Why absence is correct:** the 19 handled types carry no
  `ComponentEditor`s (button would be grayed in VS too); anything with rich
  pages is ActiveX/COM — already a Locked Control we must never write
  (invariant 4). No button, no simulation. If ever added: designer-file-only
  writes through the surgical patcher, never a modal-dialog simulation.

## 6. Cross-cutting file-edit map (C#)

| Operation | `Form.Designer.cs` | Hand-written `Form1.cs` |
|---|---|---|
| Property edit (any sort) | serialized into `InitializeComponent` | untouched |
| Events dblclick, blank cell | `+=` wiring added | stub generated + navigate |
| Events dblclick, filled cell | untouched | navigated to |
| Events Reset | wiring removed | stale stub left to user |
| Rename control | all `InitializeComponent` refs updated | handler names **not** updated (expected) |
| Property Pages OK/Apply | delta serialized | untouched |
| Sort/tab switch | untouched | untouched |

**Invariant reading:** only property edits and rename write today, to
`Designer.cs`-only and `Designer.cs`+`Form1.cs`-receivers-only
respectively. Event scaffolding is the first feature besides rename to
touch `Form1.cs` — exactly why A3 names ADR 0008 "the bounding precedent".

## 7. Companion surfaces (beyond the Properties window)

Supplied from VS behavior; mapped to tracker state:

| VS surface | VSCForms state | Tracker |
|---|---|---|
| Object selector dropdown (jump to hidden/buried control) | missing; selection is click/marquee/drill-down only | unfiled — file with D5+ rows when claimed (#29) |
| Document Outline (`Ctrl+Alt+T`) hierarchy + drag-reparent + Z-order | missing; drill-down + tab-strip exist, reorder unrepresentable (`generate` diffs by `id`) | A1 deferred+ADR |
| Toolbox (`Ctrl+Alt+X`), drawers | partial — 19 handled types only (`addControl canvas.js:1484`) | B-rows per family (B3/B6 missing) |
| Component tray (Timer, ToolTip, `BackgroundWorker`, …) | deliberately absent — non-visuals in `NonVisualFields`, never rendered | §3 not-planned |
| Smart tags (▶ flyout) | unfiled P0 candidate (`spec-vs-parity.md` §3) | file when claimed (#29) |
| Data Sources (`Shift+Alt+D`) drag-to-bind | out of scope — interiors display-only | B4 partial |
| Tab Order tool overlays | shipped — status-bar mode, click-assign via TabIndex path | A4 shipped (#5) |

## 8. Recommended order

1. Categorized + Alphabetical inspector modes (S, no ADR) — pure view over
   existing rows; needs the hardcoded category table.
2. Read-only Events display (S, no ADR) — parse wirings into schema as
   visible strings.
3. Events Reset (S, existing deleter path).
4. #28 decision → narrow ADR → full scaffolding (M).
5. Object selector dropdown (S–M, presentational + selection only).
6. Document Outline / Z-order — blocked on A1 ADR; do not start.
7. Property Pages, Component tray, Data Sources — do not implement (§5, §3).
