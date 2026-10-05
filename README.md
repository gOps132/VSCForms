# MacForms

A VS Code extension that opens a WinForms `Form.Designer.cs` as a visual canvas and edits
it — running natively on **macOS, Linux and Windows**, with no Wine and no Windows-only
dependency.

```
dist/macforms-darwin-arm64.vsix   35.0 MB   install and run
```

## What it does

- Parses `InitializeComponent()` with **Roslyn** into a JSON projection of the form.
- Renders it as a canvas with a toolbox, drag-and-drop, 8-handle resize, snapping guides
  and a property inspector.
- Writes changes back as **surgical patches** — only the lines you touched change, every
  other byte of the file is preserved exactly.

## What it deliberately does not do

This is a visual editor for **flat, non-localizable dialogs**, not a Visual Studio
replacement. Those limits are measured, not assumed — see
[Why the limits](#why-the-limits) — and the canvas states them on every open.

| Limit | Why |
|---|---|
| Forms using `Dock`/`Anchor` are **read-only** | 40.9% of real forms. Dock/Anchor are a stacking *and* resize algorithm; editing geometry that is overwritten at runtime produces code that looks right here and does nothing on Windows. |
| Forms using `resources.ApplyResources` are **read-only** | 41.6% of real forms. For these the `.Designer.cs` is not the form — text and geometry live in the sibling `.resx`. |
| Controls outside 10 types render as **locked boxes** | Type resolution is purely syntactic; we never load your assemblies. A locked control is parsed perfectly and simply not modelled. Its code is never touched. |
| **No pixel parity** | The Windows-only alternatives get fidelity by calling `OnPaint` on real controls. WinForms is Windows-only and that dependency is in the rendering primitive itself. This canvas is a *layout* view, not a *rendering* view. |
| **No event scaffolding** | No `btnSubmit_Click` generation. Planned for v2. |

Measured on 154 real Designer files from ShareX, dot42, dotnet/samples and mRemoteNG:
**47.9% per-form coverage ceiling** for the v1 type set; **16.2%** of forms are fully
representable. The coverage banner always tells you which you are looking at.

## How it works

Three processes, and one authoritative contract:

```
 VS Code
┌──────────────────────────────────────────┐
│  Webview canvas (vanilla JS)             │  postMessage (JSON)
│  owns an OPTIMISTIC model; renders        │◄──────────────┐
│  instantly, debounces writes 220ms       │               │
└──────────────────────────────────────────┘               │
┌──────────────────────────────────────────┐               │
│  Extension host (TypeScript)             │               │
│  CustomTextEditorProvider on *.Designer.cs              │
└──────────────────┬───────────────────────┘
                   │ stdio, newline-delimited JSON
┌──────────────────▼───────────────────────┐
│  macforms-engine (.NET, Roslyn)           │
│  parse:  C# -> Form Schema               │
│  generate: Form Schema -> surgical patch  │
└──────────────────────────────────────────┘
```

The contract between them is [`SCHEMA.md`](SCHEMA.md), which is authoritative.

### The load-bearing decision: the file is the source of truth

The engine **never regenerates `InitializeComponent()`** from the schema. It locates the
exact syntax nodes you changed and emits `TextChange`s over the original `SourceText`, then
throws the tree away and writes text. "Every other byte is identical" is therefore
structural, not something we test for and hope.

This is what makes it safe to point at files Visual Studio generated, containing code the
canvas cannot model. See [ADR 0001](docs/adr/0001-file-is-source-of-truth.md).

## Build and run

```bash
# engine (self-contained, single file, for this platform)
node scripts/publish-engine.js

# extension
cd extension && npm install && npm run compile && cd ..

# package a .vsix for this platform
node scripts/package-all.js

# then, in VS Code:
code --extensionDevelopmentPath=extension <some-workspace>
```

Open any `*.Designer.cs`. Use **WinForms: Open as Text** (`⌘/Ctrl` fallback is always
available) to see the generated source behind the canvas.

## Verify

```bash
./test/run-all.sh
```

| Tier | What it proves | Count |
|---|---|---|
| Roslyn | parse, refusals, byte-identical round trip, surgical move/add/delete, locked controls never written, refused forms never written | 14 |
| Compile | the generated C# builds as a **real WinForms project** (`net*-windows` + `EnableWindowsTargeting`) | 5 |
| Canvas | DOM harness over the real canvas code: rendering, locked boxes, banner, inspector, commit debounce | 22 |
| End-to-end | real canvas → real engine → real file, through the actual message contract | 21 |

The compile tier is the one that matters most: it checks the actual product claim — that
MacForms writes C# which still builds — rather than inferring it from a diff.

`MF_DEBUG=1` prints every span the patcher emits, to stderr:

```
change [3085..3085) '\n            //\n            // btnExtra\n ...'
```

## Layout

```
engine/          Roslyn parser + surgical patcher (.NET 10)
extension/
  src/           extension host, engine client, CustomTextEditorProvider
  media/         canvas (vanilla JS/CSS)
  bin/<triple>/  self-contained engine for the packaged platform
fixtures/        hand-authored Designer files (deliberately NOT copied from OSS — see below)
test/            verify.sh, e2e.js, run-all.sh
scripts/         publish-engine.js, package-all.js
docs/adr/        the decisions worth remembering
```

The fixtures are **hand-authored on purpose**. The corpus that produced the statistics above
is real and GPL-3.0- or unlicensed, so vendoring it would have imposed copyleft; authored
fixtures let the tests assert exact expected output instead of merely "didn't crash".

## Distribution

One published extension, one platform-targeted `.vsix` per platform, one binary inside each
(~35 MB downloaded vs ~176 MB for a universal bundle). Two traps are handled in
`scripts/`: vsce's `--ignore-other-target-folders` is a **documented no-op** in 4.x, so
stale targets are pruned explicitly; and packaging from Windows **loses the POSIX executable
bit**, so the `win32` CI leg must be built on a Linux runner.

## Verified against the installed VS Code

The custom-editor integration was validated by reading VS Code 1.140's own implementation, not
assumed. Findings that shaped the code:

| Question | Verdict |
|---|---|
| Must edits go through `WorkspaceEdit`? | **No.** The undo stack is driven entirely by `CustomDocumentEditEvent`. Writing the file directly and firing the event gives dirty tab, Ctrl+S and Ctrl+Z — all verified. |
| `CustomDocumentEditEvent` vs `ContentChangeEvent`? | **Edit event.** The content-change variant sets a sticky dirty flag that undo cannot clear. |
| Does `saveCustomDocument` need to write? | **No.** VS Code advances its save point unconditionally after awaiting it. We re-read to keep `doc.text` truthful for backup. |
| Automatic text fallback when a custom editor fails? | **No — there is none.** VS Code shows its Error Editor with a bare OK. So `openCustomDocument` throws an error that *names* the `Open as Text` command, and parse failures offer that button. |
| `priority: "option"` opens automatically? | **No.** Only `"default"` wins automatic resolution; `"option"` requires Reopen With every time. Ours is `{"textEditor":"default","diffEditor":"explicit"}`. |
| Does csdevkit claim `*.Designer.cs`? | **No.** Neither csdevkit nor the C# extension contributes `customEditors`; the only `.Designer.cs` reference is a file-nesting pattern. No conflict. |

Save As is deliberately refused with an explanation: writing `doc.text` to a new path would copy
a snapshot while the canvas stayed keyed to the original, which is worse than an error.

## Known limitations

- Per-form coverage tops out at 47.9% for the v1 type set. Widening the type table is the
  highest-value next step; every added type raises coverage directly.
- `TableLayoutPanel`/`FlowLayoutPanel` children are locked — nested layout is a separate
  problem.
- Undo goes through VS Code's own stack (the extension fires real `CustomDocumentEditEvent`
  undo/redo continuations), so canvas and text editing share one history. Renaming a
  control is deliberately *not* implemented: a control rename leaves a dangling event hookup
  unless handlers are renamed too, which requires editing `Form1.cs` — out of scope for v1.

## License

MIT.