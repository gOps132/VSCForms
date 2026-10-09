# VSCForms Form Schema v1 — the contract

This file is the **interface** between the Roslyn engine (C#) and the webview (TypeScript/JS).
It is authoritative. If any component disagrees with it, the component is wrong.

All three processes (extension host, engine, webview) speak exactly this shape.

## Why a *projection*, not a model

The `.Designer.cs` file is the **source of truth**. The schema is a lossy *view* of it.

The engine NEVER regenerates `InitializeComponent()` from this schema. It surgically patches
only the statements the user actually changed, leaving every other byte identical. See
`docs/adr/0001-file-is-source-of-truth.md`.

Consequence: anything not in this schema survives a round trip untouched — but is invisible
to the canvas. That is why `locked` controls exist.

## Top level

```ts
interface FormSchema {
  schemaVersion: 1
  form: FormInfo
  controls: ControlNode[]      // top-level, i.e. children of the form
  analysis: Analysis
}

interface FormInfo {
  name: string                // "Form1"
  text: string                // "" if unset
  clientSize: { width: number; height: number }
  className: string           // the generated partial class name
  backColor?: string          // CSS colour string, e.g. '#f0f0f0' or '' for default
}

interface Analysis {
  // Coverage, per form. NEVER omit — the canvas must always show the gap.
  modelledCount: number
  unmodelledCount: number
  coveragePercent: number     // 0-100, 2dp, computed per form

  // Blocking reasons: if any is true the canvas REFUSES to edit.
  // (a) resources.ApplyResources is present -> geometry/text live in the .resx
  // (b) form uses Dock/Anchor -> layout semantics we do not simulate
  refuses: RefusalReason[]

  // Non-blocking notices to show in the canvas banner.
  warnings: string[]
}

type RefusalReason = 'localizable' | 'dock-anchor' | 'unparsable' | 'no-initialize-component'
```

`refuses` is an **allowlist of known blockers only**. Unknown/odd code that we do not
understand but that is safe to leave alone is a *warning*, not a refusal — the conservative
"refuse anything unfamiliar" stance was rejected: measured per-form coverage (47.9% at 10
types — stale, see `docs/tracker.md` §4) already means most forms are partly unfamiliar, so
refusing on unfamiliarity would refuse nearly everything.

## Controls

```ts
interface ControlNode {
  id: string                  // C# field name: 'btnSubmit'. Unique per form.
  type: string                // FULLY QUALIFIED as written in the file:
                              //   'System.Windows.Forms.Button'
                              // Type resolution is PURELY SYNTACTIC. We never load an
                              // assembly, so unknown types are simply unmodelled.

  // Children of containers (Panel, GroupBox). Nested layout engines
  // (TableLayoutPanel/FlowLayoutPanel) are NOT modelled in v1 and arrive as `locked`.
  children: ControlNode[]

  // Geometry is ALWAYS present and ALWAYS modelled — even for locked controls.
  // We can always read and write Location/Size safely; it is the *appearance*
  // properties we may not be able to model.
  properties: ControlProperties

  // true => canvas must render this as a locked grey box, non-interactive.
  // `lockedReason` explains why, in one short sentence, shown in a tooltip.
  locked: boolean
  lockedReason?: string

  // Present only for forms we can read but not edit (refuses non-empty).
  // The canvas renders read-only in this case.
}

interface ControlProperties {
  // --- geometry: modelled for EVERY control, locked or not ---
  x: number
  y: number
  width: number
  height: number

  // --- appearance: modelled only when `locked === false` ---
  text?: string
  tabIndex?: number
  backColor?: string           // CSS colour string, e.g. '#ff0000' or '' for default
  foreColor?: string           // CSS colour string, e.g. '#008000' or '' for default
  visible?: boolean
  enabled?: boolean
  font?: { size: number; bold: boolean; italic: boolean; family?: string }
  items?: string[]             // ComboBox and ListBox items
  multiline?: boolean          // TextBox only
  readOnly?: boolean           // TextBox only
  maxLength?: number           // TextBox only
  passwordChar?: string        // TextBox only
  scrollBars?: string          // TextBox only: 'None' | 'Horizontal' | 'Vertical' | 'Both'
  minimum?: number             // TrackBar, ProgressBar, NumericUpDown
  maximum?: number             // TrackBar, ProgressBar, NumericUpDown
  value?: number               // TrackBar, ProgressBar, NumericUpDown
  checked?: boolean            // CheckBox, RadioButton
  textAlign?: string           // Label, Button: ContentAlignment
  borderStyle?: string         // Panel, GroupBox, PictureBox, Label: BorderStyle
  autoSize?: boolean           // Label, CheckBox, RadioButton, Button
}
```

### Invariants the engine MUST enforce

1. `id` is a valid C# identifier, unique within the form.
2. `x, y` are integers (WinForms designer emits `int`).
3. `width, height` are integers, `>= 0`. Zero width/height is legal in WinForms — do NOT clamp.
4. `text` is `undefined`, never `null`.
5. `children` is always present (possibly `[]`), never `undefined`. Keeps JSON shapes stable.
6. `properties` always has all four geometry fields. Optional appearance fields are omitted,
   not null — distinguishes "unset" from "set to empty string".
7. `visible`, `enabled` and `backColor` are **BOOLEAN / hex-string typed, never strings**.
   `enabled: false` and `enabled: "false"` are different JSON and only one is correct.

## Engine commands (stdio, newline-delimited JSON)

The engine is a **long-lived process**. One JSON request per line on stdin, one JSON response
per line on stdout. Never log to stdout — diagnostics go to stderr, or they corrupt the stream.

```
{ "id": 1, "cmd": "parse",   "path": "/abs/Form1.Designer.cs" }
{ "id": 2, "cmd": "generate","path": "/abs/Form1.Designer.cs", "schema": { ...FormSchema } }
{ "id": 3, "cmd": "ping" }
{ "id": 4, "cmd": "new",     "name": "MyDialog", "parent": "/abs/dir" }
```

### `new` — project generation

Creates a WinForms project by shelling out to `dotnet new`, plus a classic `.sln`. `template`
defaults to `winforms`, `language` to `C#`. The engine does this rather than the extension host
because the csproj's BOM and CRLF must survive the `EnableWindowsTargeting` injection, and the
engine is the only component that already edits files byte-faithfully.

```ts
{ "id": 4, "cmd": "new", "name": "MyDialog", "parent": "/abs/dir",
  "template"?: "winforms" | "winformslib" | "winformscontrollib",
  "language"?: "C#" | "VB" }

{ "id": 4, "ok": true, "changed": true,
  "projectDir": "/abs/dir/MyDialog",
  "solution":   "/abs/dir/MyDialog.sln",
  "designer":   "/abs/dir/MyDialog/Form1.Designer.cs",   // "" if the template has none
  "windowsTargetingAdded": true }                        // false on Windows hosts
```

`errorKind` on failure: `bad-name` (not an identifier, or a C# keyword), `bad-language`,
`no-dotnet`, `no-template`, `exists`, `sdk`.

### `rename` — the one operation that leaves the Designer File

Renames a control, and possibly the hand-written code-behind. **It is not a schema commit**: a
schema carrying a new `id` reads to `generate` as *old deleted + new inserted*, which would
duplicate the control and discard its properties.

```ts
{ "id": 5, "cmd": "rename", "path": "/abs/Form1.Designer.cs", "from": "btnGo", "to": "btnSend" }

{ "id": 5, "ok": true, "changed": true,
  "codeBehind": "/abs/Form1.cs",        // null when there is none
  "referenceCount": 9 }                 // references in the Designer File
```

`errorKind`: `bad-rename`, `not-found`, `conflict`, `locked`, `refused`,
`ambiguous-reference`.

The boundary is [ADR 0008](docs/adr/0008-rename-boundary.md): the Designer File is rewritten
unconditionally; the code-behind only where the identifier is the **receiver of a member
access**. Anything else — a local, a parameter, another class's member — is refused with the
file and line named, because a wrong guess is a build error in the user's project. Both files'
edits are validated before either is written, so a refusal leaves both byte-identical.

Two shapes are worth stating because they are the ones that would otherwise be silently wrong:

- **`Name = "btnGo"` IS rewritten**, while every other string and comment is not. It is not
  prose — it is the control's *runtime identity*, and the schema's `id` comes from the field
  name, so leaving it stale would make the canvas and WinForms disagree about what the control
  is called. `FindControl("btnGo")` in the user's own code would keep working while the canvas
  showed the new name. Visual Studio keeps the two in sync for the same reason.
- **A verbatim identifier (`@btnGo`) is REFUSED, not skipped.** The `@` cannot be preserved by a
  plain identifier rewrite, and skipping it would report success while leaving a dangling
  reference — the exact failure this operation exists to prevent.

`MF_DEBUG=1` prints every emitted span to stderr, as the patcher does.

`exists` is checked **before any file is written**, so a refused generation never leaves a
half-made project. `name` is validated as a C# identifier and rejected if it is a reserved word:
`dotnet new class` succeeds and yields a project that cannot compile.

Response:

```
{ "id": 1, "ok": true,  "schema": { ... } }
{ "id": 1, "ok": false, "error": "InitializeComponent() not found", "errorKind": "no-initialize-component" }
```

`generate` writes the file only if the content actually changed; otherwise it is a no-op.
This keeps undo/redo and dirty-state accounting honest.

### Appearance properties are patched per ARGUMENT, not by rebuilding

`BackColor` and `Font` are **constructions**, not plain values, and each has several spellings
in real files (`Color.FromArgb(...)`, `Color.Red`, `FontStyle.Regular` vs no style argument at
all). Writing back follows the same rule as `Location`/`Size` — **replace only what differs**:

- **Type names are never rewritten** (ADR 0005). A file writing
  `System.Drawing.Color.FromArgb(…)` keeps that exact spelling.
- **`Font` is patched argument by argument** — family string, size literal, style — and each is
  touched only when it actually differs. Rebuilding the whole argument list rewrote a file
  whose font was already correct, because the designer writes `FontStyle.Regular` explicitly
  and dropping it turned a no-op generate into a real edit. That is byte-level churn on an
  untouched form, which is the invariant the patcher exists to prevent.
- A shape we do not recognise — a 1-argument `FromArgb(int)`, a 1-argument `Font` — produces
  **no change at all**, rather than a rewrite across overloads.

**Every child process the engine spawns must have stdout redirected.** Our stdout is the
protocol channel, so an inherited stdout lands in the middle of a JSON response and the host
reports a parse error with no cause. `dotnet --version` did exactly this once.

## generate() semantics — precise

1. Parse the CURRENT file from disk (never trust the extension's cached text).
2. Diff the incoming `schema` against a fresh `parse` of that same file.
3. Emit **only** the differences, as a list of `TextChange`s over the `SourceText`.
4. A control present in the schema but absent from the file => INSERT (new control).
5. A control absent from the schema but present in the file and NOT locked/unmodelled
   => DELETE (user removed it from the canvas).
6. A control `locked === true` => **NEVER** touch it. No property edits, no delete.
7. Everything the schema does not mention => byte-identical.

Step 6 is the safety invariant. If the diff logic is ever unsure, it emits nothing.

## v1 supported control types (the "type table")

Fully modelled — real widgets, editable properties:

**19 control types**, plus `Form` itself:

`Button`, `Label`, `TextBox`, `CheckBox`, `RadioButton`, `ComboBox`, `ListBox`,
`PictureBox`, `Panel`, `GroupBox`, `TrackBar`, `ProgressBar`, `NumericUpDown`,
`DateTimePicker`, `TabControl`, `TabPage`, `DataGridView`, `ListView`, `TreeView`,
and `Form`

`Form` is listed here but is NOT in `TypeTable.Handled` — it is resolved separately, because a
form is the document rather than a control inside it. So "19 types" means 19 rows in
`Handled`, and 20 names on this list. The two must not be conflated; the count in
`CONTEXT.md` is the `Handled` count.

Containers modelled: `Panel`, `GroupBox`, `TabControl`, `TabPage` (two-level:
`tabControl.Controls.Add(page)`, `page.Controls.Add(...)`). `DataGridView`, `ListView`,
`TreeView` are read-only placeholders — labelled boxes with no interior, display-only by
design.

The four leaf widgets render no text, so the canvas disables the `Text` field for them —
see `docs/spec-leaf-widgets.md` §3. `Minimum`/`Maximum`/`Value` are modelled for
`TrackBar`, `ProgressBar` and `NumericUpDown`; `DateTimePicker` shows no value by decision
(`docs/spec-leaf-widgets.md` §6, tracker B7).

Everything else (~33 distinct types measured across a 154-file corpus) renders as a locked
grey placeholder box labelled with its type name. This is intentional and documented, not a
gap to be papered over.

## Dialects

Designer files exist in at least four shapes, all of which occur in real projects. VSCForms
reads all of them and **writes back in whichever it found** — mixing conventions is visible
churn the user did not ask for.

| Dialect | Instantiation | Property | `Controls.Add` | Where it occurs |
|---|---|---|---|---|
| classic | `this.x = new System.Windows.Forms.Button();` | `this.x.Location = new System.Drawing.Point(1, 2);` | `this.Controls.Add(this.x)` | Visual Studio designer output; every file in the 154-file corpus |
| templated | *none — no controls yet* | `ClientSize = new Size(800, 450);` | *none* | a freshly `dotnet new winforms` project |
| bare | `x = new Button();` | `x.Location = new Point(1, 2);` | `Controls.Add(x)` | files whose `this.` was never introduced |
| this-style | `this.x = new ...Button();` | `this.x.Location = ...Point(1, 2);` | `Controls.Add(this.x)` | Visual Studio after it rewrites a fresh template |

The `templated` dialect is why a form-level property must accept a **bare identifier** on the
left. Its `InitializeComponent()` has only four statements and no controls at all:

```csharp
components = new System.ComponentModel.Container();
AutoScaleMode = AutoScaleMode.Font;
ClientSize = new Size(800, 450);
Text = "Form1";
```

Reading only the classic dialect reports such a file as an empty form **at 100% coverage** —
the most dangerous possible failure, because the coverage banner then reassures the user that
everything is modelled.

### Dialect detection

Two independent signals, both required:

| Signal | Meaning | Detected from |
|---|---|---|
| `UsesThisPrefix` | control members are `this.`-qualified | control **instantiations** only |
| `ControlsCollectionIsQualified` | `Controls.Add` is `this.`-qualified | the last `Controls.Add` call |

They are tracked separately because `this-style` is genuinely mixed: `this.txt.Location` sits
beside a bare `Controls.Add`. A single prefix for both produces visibly inconsistent output in
exactly the files real users have.

Detection keyed on the literal substring `this.` is wrong in both directions — it fires on form
members, and misses a bare file whose only `this.` is on the form.

Infrastructure fields do not count as evidence. `components = new System.ComponentModel.
Container();` has the same syntax shape as an instantiation and is filtered out of the schema as
a non-visual field — but if it counted toward the dialect signal, every `templated` file would
look like it had evidence and the declared-style fallback below would never be consulted.

### Declared style (`.editorconfig`) — advisory, and only where the file is silent

`UsesThisPrefix` is inferred from control **instantiations**. The `templated` dialect contains
none, so there the signal is inferred from *absence* and is indistinguishable from a genuinely
bare file. A user adding their first control to a fresh `dotnet new winforms` project gets
`this.`-qualified or bare output based on nothing at all.

Visual Studio decides this from `dotnet_style_qualification_for_field`, and so do we — by
walking up from the Designer file to the nearest `.editorconfig`.

**Resolution order, and the order is the whole design:**

1. **Observed in the file.** Always wins. ADR 0005 commits us to writing in the file's own
   dialect, so a file that demonstrates a convention is never overridden by a config that
   disagrees with it.
2. **Declared style**, consulted *only* when the file contains no control instantiation at all.
3. **The existing default** (bare).

The single setting we read governs both write-back signals, because in a Designer File every
qualified member is a control **field** reference — `this.btnGo.Location` and `this.Controls.Add`
are both field references, and there is no bare property anywhere for
`dotnet_style_qualification_for_property` to apply to. Reading it and ignoring it would be dead
code that looks like a feature.

Two further settings are deliberately **not** read, and this is a decision rather than an
omission:

- **`dotnet_style_qualification_for_property`** — as above, nothing for it to govern.
- **`<ImplicitUsings>`** — it decides whether an unqualified type name compiles, which looks like
  it should govern whether we write `new Button()` or `new System.Windows.Forms.Button()`. But we
  always emit the fully-qualified form, which compiles **either way**. A switch would be churn
  with no correctness gain, and would risk ADR 0005's rule against rewriting a type name the file
  already wrote. (An earlier draft did read it — with a `true`/`false` parser, which silently
  never matched the csproj's actual `enable`/`disable` spelling, so it was always `null`.)

Two more consequences worth stating explicitly:

- Only exact `true` / `false` are honoured. `true:warning` and `false:suggestion` are how an IDE
  decides whether to underline code, not what the author wants the code to look like.
- Discovery stops at a directory containing `.git`, `*.sln` or `*.slnx`. A machine-wide or
  organisation-wide `.editorconfig` above the project root must not rewrite the dialect of every
  project on the machine.
- A malformed `.editorconfig` is ignored, never fatal. An advisory input cannot break the
  operation it informs.

### Write-back rules

1. **Never qualify a type name that was already unqualified.** Patching `Location`/`Size`
   replaces only the *argument list*, so `new Point(1, 2)` stays `new Point(1, 2)`. It compiles
   either way; rewriting is churn.
2. **Preserve the line ending.** CRLF files get CRLF, LF files get LF. Mixed endings turn every
   subsequent `git diff` into a whole-file change.
3. **Preserve the UTF-8 BOM.** Read bytes, not `File.ReadAllText` — that overload consumes the
   BOM, which would alter line 1 of every file on every edit.
4. **Match the body indentation**, taken from the body's first statement rather than from
   whichever node is being used as an anchor — an anchor may sit on a continuation line.
5. **Emit `this.` per the two signals above**, never unconditionally.