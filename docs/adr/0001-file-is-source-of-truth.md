# The Designer File is the source of truth, and edits are surgical

The engine must never regenerate `InitializeComponent()` from the Form Schema. It locates the
specific syntax nodes the user changed and emits `TextChange`s over the `SourceText`, leaving
every other byte identical.

## Context

`InitializeComponent()` in a real Designer File is not a data structure. Across 154 real files,
only 58.35% of statements are simple property assignments; the rest are `SuspendLayout` calls,
`resources.ApplyResources`, `(components).Container.Add`, resource-loaded images, event
hookups, and third-party control types. A Form Schema that models a subset cannot express the
remainder, so regenerating from it necessarily destroys code.

The original spec proposed rewriting `InitializeComponent()`, which would silently delete the
user's unmodelled code on first edit.

## Decision

The Designer File is authoritative. The Form Schema is a projection of it, and the engine
computes a diff between the incoming schema and a fresh parse of the file on disk, emitting
changes only for controls and properties the user actually touched.

A control marked `locked` is never written to at all — no property edits, no deletion. If the
diff logic is ever uncertain, it emits nothing.

## Consequences

Per-form coverage tops out around 47.90% for the v1 Handled Types, so the canvas is frequently a
partial view. That is why Coverage Banner disclosure is mandatory rather than optional: a canvas
that silently renders half a form is worse than one that refuses.

The alternative — regenerating the method — was rejected because it converts a correctness
problem into a data-loss problem. It also means the engine cannot simplify a file it did not
create, which is the correct behaviour for a tool that edits source other people generate.