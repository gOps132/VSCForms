# Phase A — leaf widgets: TrackBar, ProgressBar, NumericUpDown, DateTimePicker

**Status:** ACCEPTED — implementing now. Sibling of `spec-features.md` §2 Phase A, which ranks
these as the next step and gives the reasoning; this document is the executable detail.

## 0. Scope

Four control types. All are **leaf widgets**: no children, no nested layout, no collections.

| Type | Prefix | Default size | `Text` meaningful? |
|---|---|---|---|
| `TrackBar` | `trk` | 120 × 56 | no — geometry only |
| `ProgressBar` | `prg` | 140 × 20 | no — geometry only |
| `NumericUpDown` | `num` | 100 × 22 | no — geometry only |
| `DateTimePicker` | `dtp` | 120 × 23 | no — geometry only |

None of the four renders text, so all four are **geometry-only**, exactly like `Panel`: the
inspector must disable the `Text` field for them. That is a single shared check rather than four
cases, and it is stated here because a `Text` box that silently does nothing is worse than no box.

## 1. Why no patcher work

`Patcher.cs:76` guards deletion on `TypeTable.IsHandled`, not on a per-type list, so adding a
row makes these insertable and deletable with **zero changes to the patcher**. Inserts emit
`{type} name`, `name.Location/Name/Size/TabIndex` — all of which are type-agnostic.

## 2. The two-list rule, and why it is the likeliest way to get this wrong

`AGENTS.md` requires a row in `engine/src/TypeTable.cs` **and** a row in the canvas `HANDLED`
list. A type in only one of the two is the specific failure this section exists to prevent:

- Engine knows it, canvas does not → renders as a **locked box with no stated reason**, even
  though the engine considers it modelled. The user sees "not modelled" for a supported type.
- Canvas knows it, engine does not → the canvas offers drag and text edits, and the engine then
  **silently declines to write them** because `Patcher` skips locked controls. The control
  appears movable and nothing happens.

The second is the worse one, because it produces a control that accepts input and discards it.

Per-type checklist, all four required:

1. `TypeTable.Handled` row
2. `TypeTable.Prefix` row — otherwise every generated control is named `ctl1`, `ctl2`
3. canvas `HANDLED` row (palette swatch + drag payload)
4. canvas `PREFIX` row
5. canvas `addControl` defaults — a wrong default size writes a control the designer would not

`LockedReason` interpolates `{Handled.Count}`, so its text follows automatically. Any **test**
that hardcodes "10 handled control types" must be updated to the new count; a hardcoded count
is a test that will lie.

## 3. Canvas rendering

These are structural diagrams, not pixel reproductions (ADR 0006). The goal is a shape a user
recognises at a glance, drawn with CSS and no new assets:

| Type | Rendering |
|---|---|
| `TrackBar` | A horizontal groove with a thumb at the value. Tick marks only when the file sets `TickStyle`, which we do not model — so **no ticks**, and the canvas says nothing about them either way |
| `ProgressBar` | A track filled proportionally. With no modelled `Value`, a **static** fill is the only honest option; an animated or invented value would be a lie about the form |
| `NumericUpDown` | A text area plus two stacked arrow glyphs on the right |
| `DateTimePicker` | A text area plus a calendar glyph on the right |

None of these claim to show their *value*. That is deliberate: `Value`, `Minimum`, `Maximum`
and `Format` are not in the schema, so showing a number would be inventing state. Recording it
here so it is a decision rather than an oversight.

## 4. Verification

Per `fixtures/README.md` the corpus cannot be vendored, so each type gets a **hand-authored**
fixture. One fixture per type is overkill for four geometry-only widgets, so:

- **One new fixture** `fixtures/leafwidgets/LeafForm.Designer.cs` containing all four types, in
  the classic dialect, hand-authored to the same conventions as the existing fixtures
  (field declarations, `// name` comment headers, `SuspendLayout`/`ResumeLayout`).
- **Exact-diff assertions** in `test/verify.sh` — add each type and assert the emitted lines,
  not merely that the file changed.
- **A real compile gate**: the fixture is compiled as a WinForms project, which is the only
  check that a default size or an emitted property is legal.
- **Coverage assertion**: all four must read as modelled (`locked === false`), because a locked
  box for a supported type is failure 1 of §2.
- **Canvas harness**: the palette lists four new tools, each drops with the right prefix, and
  the `Text` field is disabled for all four.
- **`addControl` defaults**: asserted through the harness, since a wrong default size is a
  silent quality bug that no other tier sees.

## 5. Explicitly not in this phase

- **`ComboBox`/`ListBox` `Items`.** Needs a schema field, an `Items.AddRange` parser and a list
  editor. Different size of work; `spec-features.md` §8b already records it as not implemented.
- **Any property of these four types** beyond geometry. `TrackBar.Minimum/Maximum/TickStyle`,
  `ProgressBar.Minimum/Maximum/Value` and `NumericUpDown.DecimalPlaces` are all invisible. That
  is honest and matches how `Panel` is handled; modelling them is a separate, larger change.
- **`TabControl`/`TabPage`** (Phase B) and the read-only placeholders (Phase C).

## 6. Acceptance

1. All four parse as modelled, `locked === false`, from the classic dialect.
2. Adding each type emits the right field declaration, instantiation, geometry and
   `Controls.Add`, with the right prefix — asserted line by line.
3. The fixture compiles as a real `net10.0-windows` WinForms project.
4. The canvas palette offers all four; dropping one allocates `trk1`/`prg1`/`num1`/`dtp1`.
5. The inspector disables `Text` for all four.
6. **The two type lists are compared against each other, in both directions, by
   `test/verify.sh`** — the real `TypeTable.cs` against the real canvas `HANDLED` array, plus
   their prefixes. A harness assertion could only compare the canvas against a literal copy of
   the engine's list, which lets the copy drift; the other direction of §2's rule would have no
   test at all. No hardcoded "10 handled control types" remains in any current document.
7. `test/run-all.sh` is green, and the coverage figure reported for the new fixture is 100%.

## 7. Open decisions

1. **No value is displayed for any of the four** (recommended). The properties that would carry
   it are not modelled, so any number on screen would be invented.
2. **No tick marks on `TrackBar`** (recommended) for the same reason — `TickStyle` is invisible,
   and drawing or omitting ticks both claim something the schema does not know. Omitting is
   quieter.
3. **`ProgressBar` renders a static partial fill** purely so the shape is recognisable
   (recommended). It is a diagram of the type, not of the value, and the canvas already states
   that it is a structural view rather than a preview (ADR 0006).
4. **Default sizes** are the WinForms design-time defaults as near as we can state them
   (`ProgressBar` 140×20, `NumericUpDown` 100×22, `DateTimePicker` 120×23, `TrackBar` 120×56),
   because a control dropped at an arbitrary size is one the user immediately resizes — and
   every resize is a real write to their file.