# Z-order as a move: array order is paint order

Amends [ADR 0001](0001-file-is-source-of-truth.md). The file stays the source of truth;
this decision fixes what "surgical" means when the user reorders controls rather than
changing their properties.

## Context

`generate` diffed the incoming schema against a fresh parse by control `id`: a control
present in the schema but absent from the file was an INSERT, and one absent from the
schema but present in the file was a DELETE. There was no "same control, different index"
case, so a reorder was unrepresentable — and expressing it as delete+insert would
**destroy and recreate the control**, losing every property the schema does not model
(ADR 0001: the ~42% of statements no schema can express). That is data loss, not a
missing feature, which is why z-order waited for a protocol change.

Z-order in the file is the `Controls.Add` statement order, and the mapping to the runtime
is fixed by the platform, not by us: `Control.ControlCollection.SetChildIndex` puts index
0 at the top of the z-order, and `Controls.Add` appends — so the **first** `Add`
statement is the front-most sibling. The tempting reading (last-added paints on top, as in
DOM/CSS) is backwards for WinForms, and baking it in would have made the canvas and the
runtime disagree about every overlap. The schema therefore carries siblings front-to-back
(index 0 = front), verbatim in file order — a projection keeps its source's order — and
the canvas reconciles the DOM's last-on-top painting with an explicit descending
`z-index`, so DOM order stays array order.

## Decision

Admit z-order (Bring to Front / Send to Back) as a **move**:

1. **Same ids, different order is a move, never delete+insert.** The engine relocates the
   group's `Controls.Add` lines to the new order, verbatim — whole lines, bytes preserved,
   never re-spelled, so the file's dialect (classic, templated, bare, this-style) survives
   untouched. Only the lines of controls that actually changed position appear in a change
   span.
2. **Each sibling group moves independently** (top level, each container's children).
   Controls with no `Add` line, inserts, deletes and reparents take no part: only ids
   present on both sides have a line to relocate. A reparenting schema is therefore
   ignored, never half-applied — reparenting UI is a separate change.
3. **A Locked Control is never cut.** The simulation that plans the relocation refuses any
   plan that would put a locked control's statements into a change span. Its *relative*
   stacking may still shift when a sibling moves past it — that is inherent to any z-order
   operation (Visual Studio behaves the same) — but no byte of a locked statement is ever
   created, modified in content, or removed. The canvas never offers the operation on a
   locked selection in the first place.
4. **Refuse the ambiguous reorder.** A duplicated `Controls.Add` (the same child added
   twice) has no single statement to relocate, and two textually identical control blocks
   could misattribute a text-level move — so the whole `generate` is refused with
   `ok: false` and `errorKind: "ambiguous-order"`, and the file stays untouched. Spans are
   id-anchored, so on a well-formed file the move is never actually ambiguous; the refusal
   guards corrupt ones. Refuse-rather-than-guess, as in [ADR 0003](0003-refuse-rather-than-simulate.md)
   and [ADR 0008](0008-rename-boundary.md).
5. **A group whose `Add` lines are interleaved with other statements is left alone**,
   silently: the relocation assumes the group's line range holds nothing but its own `Add`
   lines and whitespace. Skipping is safe; guessing is not.
6. **The move is verified, not inspected.** After assembling the patch, the engine
   re-parses the result and checks every moved group landed in its target order; on
   mismatch the moves are dropped while the property edits still apply. A wrong order is
   never written.
7. **No new protocol message, no local undo stack.** The canvas reorders the sibling array
   and rides the existing debounced `commit()` path, so one z-order op is one VS Code undo
   step ([ADR 0004](0004-undo-through-vs-code.md)).

Refused forms stay refused (`ok: false`, file untouched) — the reorder phase runs after the
existing refusal gate and never before it.

## Consequences

- **The schema's array order is now load-bearing**, not incidental: index 0 is front, and
  `generate` treats an index change as an edit. `SCHEMA.md` states this in the Controls
  section and in the `generate()` semantics. A no-op generate on an untouched file still
  round-trips byte-identical (the parse emits `Add` order, which is what the move compares
  against), so dirty-state and undo accounting are unaffected.
- **The outline stays reorder-free.** The Document Outline omits reorder UI entirely; that
  omission was gated on this move existing, and lifting it (drag-reparent, outline
  up/down) is future work with its own scope — this ADR enables it but does not do it.
- **The front/back mapping rests on one platform sentence** (index 0 is on top). No test
  tier can prove it: the compile tier builds, and the layout tier compares `Bounds`, but
  neither sees stacking. If that sentence is ever wrong, the canvas inverts every overlap
  while every tier stays green — the ADR records the dependency so the failure has a name.
- **A refused reorder fails the whole `generate` batch**, including unrelated property
  edits in the same commit. Fix the duplication and retry. Property-only commits to such a
  file still apply, because no move is attempted.
