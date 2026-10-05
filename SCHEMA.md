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
"refuse anything unfamiliar" stance was rejected: 47.90% per-form coverage already means most
forms are partly unfamiliar, so refusing on unfamiliarity would refuse nearly everything.

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
  visible?: boolean
  enabled?: boolean
  font?: { size: number; bold: boolean; italic: boolean }
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

## Engine commands (stdio, newline-delimited JSON)

The engine is a **long-lived process**. One JSON request per line on stdin, one JSON response
per line on stdout. Never log to stdout — diagnostics go to stderr, or they corrupt the stream.

```
{ "id": 1, "cmd": "parse",   "path": "/abs/Form1.Designer.cs" }
{ "id": 2, "cmd": "generate","path": "/abs/Form1.Designer.cs", "schema": { ...FormSchema } }
{ "id": 3, "cmd": "ping" }
```

Response:

```
{ "id": 1, "ok": true,  "schema": { ... } }
{ "id": 1, "ok": false, "error": "InitializeComponent() not found", "errorKind": "no-initialize-component" }
```

`generate` writes the file only if the content actually changed; otherwise it is a no-op.
This keeps undo/redo and dirty-state accounting honest.

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

`Button`, `Label`, `TextBox`, `CheckBox`, `RadioButton`, `ComboBox`, `ListBox`,
`PictureBox`, `Panel`, `GroupBox`, `Form`

Everything else (~37 distinct types measured across a 154-file corpus) renders as a locked
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