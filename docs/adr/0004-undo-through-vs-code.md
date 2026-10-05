# Canvas undo is delegated to VS Code's undo stack

The webview canvas holds no undo stack of its own. Undo and redo are served by VS Code's
standard text-editor undo stack, driven by `CustomDocumentEditEvent` with real `undo()` and
`redo()` continuations.

## Context

A visual editor has two plausible models:

1. **Own the history.** Keep a model-level undo stack inside the webview. Fast, and undo
   costs nothing.
2. **Delegate.** After each committed edit, fire a `CustomDocumentEditEvent` so the edit
   lands on VS Code's stack, and implement `undo()`/`redo()` by rewriting the file to the
   captured previous text.

The tempting failure is shipping both: a local stack *and* the document events. Then one
Ctrl+Z is applied twice — once in the canvas model, once to the file — and the two diverge.
The canvas is showing geometry the file no longer describes, which is the exact failure mode
this project is built to avoid.

## Decision

Delegate entirely. The extension captures the file text before each commit and fires a
`CustomDocumentEditEvent` whose `undo()` writes the previous text back and asks the canvas
to re-parse. The canvas handles no undo keys itself.

The cost is real and worth stating: undo is only as granular as the debounced commit, and
undo must round-trip through the engine, so it is slower than a pure model revert. We accept
that in exchange for the canvas and the fallback text editor sharing one history, which is
what users actually expect from a document-based editor.

## Consequences

- `Ctrl/Cmd+Z` works identically whether the canvas or the text editor has focus.
- Renaming a control is deliberately **not** implemented for the same underlying reason: a
  control rename leaves a dangling event hookup (`CS1061`) unless the handler in `Form1.cs`
  is renamed too, and that file is not ours to edit. This is a correctness limit, not a
  missing feature.
- Because the engine writes the file directly, `saveCustomDocument` only re-reads and clears
  the dirty flag. Writing `doc.text` back would double-apply.