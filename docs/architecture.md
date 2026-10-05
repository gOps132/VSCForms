# Architecture

How the three processes fit together, and why the boundaries are where they are.

## Shape

```
 VS Code
┌────────────────────────────────────────────┐
│  Webview canvas (vanilla JS)               │
│  owns an OPTIMISTIC model; renders          │◄──── postMessage (JSON)
│  instantly, debounces writes 220ms         │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│  Extension host (TypeScript)               │
│  CustomTextEditorProvider on *.Designer.cs  │
│  engine client: newline-delimited JSON      │
└──────────────────┬─────────────────────────┘
                   │ stdio
┌──────────────────▼─────────────────────────┐
│  vscforms-engine (.NET 10, Roslyn 5.9.0)   │
│  parse:    C# → Form Schema                │
│  generate: Form Schema → TextChange[]       │
└────────────────────────────────────────────┘
```

One process, one contract: [`SCHEMA.md`](../SCHEMA.md).

The engine is **long-lived and shared** across all open editors. Spawning a .NET process per
document would pay Roslyn's JIT cost repeatedly.

## Why the engine writes the file directly

The engine could apply a `WorkspaceEdit` through the host, but that would require re-parsing
and re-diffing in the host and would round-trip the whole file per gesture. Instead the engine
writes, and the host announces the edit with a `CustomDocumentEditEvent` so VS Code's save
point advances and Ctrl+Z works. Verified against VS Code 1.140: no `WorkspaceEdit` is required
anywhere in the custom-editor path.

The seam this creates is `saveCustomDocument`, which only re-reads and must **not** write
`doc.text` back — that would double-apply.

## The write path

1. Canvas mutates its optimistic model on `mousedown`; DOM updates immediately.
2. On gesture end, a 220 ms debounce fires `commit` with the whole schema.
3. The host calls `generate`.
4. The engine **re-parses the file from disk** (never trusts the host's cached text), diffs the
   incoming schema against that fresh parse, and emits `TextChange`s for the differences only.
5. If anything changed, the file is written and the edit is announced.

A no-op `generate` does not write, which keeps dirty-state accounting and the undo stack
honest.

### Why `TextChange` and not a rewriter

`CSharpSyntaxRewriter` regenerates the whole tree and reformats the file. `ReplaceNode` is
worse in practice — trivia lives on the node, not the token, so replacing an argument strips
indentation and can collapse lines. Computing spans against the original `SourceText` and then
writing text makes "every other byte is identical" structural rather than something tested for.

`MF_DEBUG=1` prints every emitted span to stderr.

## Model ownership

The canvas owns the render truth; the engine is a slow validator. Dragging a control must feel
instant, and Roslyn will not always be. A change that makes the canvas wait on the engine before
repainting is a regression even though every test still passes.

## Refusals

Two conditions make a form read-only, and both are refusals rather than degraded rendering:

- `localizable` — the form calls `resources.ApplyResources`, so geometry and text live in the
  sibling `.resx`.
- `dock-anchor` — a non-default `Dock`/`Anchor`, which is a stacking *and* resize algorithm we
  do not simulate.

Both are computed syntactically per form. See [ADR 0003](adr/0003-refuse-rather-than-simulate.md).

## Coverage is a disclosure obligation

`analysis.coveragePercent` is computed fresh on every parse and rendered in a mandatory,
non-dismissible banner. It is not a quality score — it tells the user how much of the form the
canvas is actually showing. A canvas that silently renders 48% of a form is the failure mode
this project exists to avoid.

## Distribution

One published extension, one platform-targeted `.vsix` per platform, one binary inside each.

| | user downloads |
|---|---|
| Universal bundle (5 binaries) | ~176 MB |
| Platform-targeted | **~35 MB** |

Total published bytes are roughly a wash; the win is entirely per-user bandwidth. Two traps:

- `vsce`'s `--ignore-other-target-folders` is a **documented no-op** in 4.x. `bin/` is pruned
  explicitly by `scripts/publish-engine.js`.
- Packaging from Windows **loses the POSIX executable bit**, so the `win32` CI leg is built on a
  Linux runner.

See [ADR 0002](adr/0002-distribution.md).

## Verification

| Tier | Proves | Count |
|---|---|---|
| Roslyn | parse, refusals, byte-identical round trip, surgical move/add/delete, locked and refused controls never written | 14 |
| Compile | the generated C# builds as a real `net*-windows` WinForms project | 5 |
| Canvas | DOM harness over the real canvas code | 22 |
| End-to-end | canvas → host → engine → file, through the actual message contract | 21 |
| Integration | VS Code's own semantics: editor selection, dirty marker, undo continuations, Save As refusal | 17 |

The compile tier matters most — it is the only one that checks the actual claim, that VSCForms
writes C# which still builds. It needs the WindowsDesktop reference pack from NuGet on first
run, and skips cleanly offline.

The integration tier needs a display. It reaches internals through the hidden
`vscforms._testSeam` command because the webview is unreachable from the extension host API;
each case runs the real production path rather than a simulation.

One thing it cannot drive: VS Code routes Ctrl+Z to custom editors via a keybinding
implementation (`addImplementation(105,"custom-editor")`) that the extension host API cannot
dispatch — `executeCommand('undo')` does not reach it. So the suite asserts that *our*
continuations restore the file byte-for-byte, and VS Code's dispatch is verified against its
source instead.