# ComboBox / ListBox `Items`

**Status:** ACCEPTED — implementing now. Ranked "the obvious next property" in
`spec-features.md` §8b; this document is the executable detail.

## 0. Scope

The `Items` collection of `ComboBox` and `ListBox` — the single most basic property of a list
control, and the one that makes a list control *editable* rather than merely movable.

A `ComboBox` you cannot add an item to is not a working form designer. This is the gap the user
named as "basic editing".

**In scope:** `Items` on `ComboBox` and `ListBox`, in the classic and templated dialects.

**Out of scope:** `CheckedListBox`, `DomainUpDown`, `ListView` (different collection shapes);
reordering by drag; `SelectedIndex`/`SelectedItem`; `DropDownStyle`. Each is a separate change.

## 1. Why this is harder than it looks

`Items` is not a property assignment. It is an **invocation**:

```csharp
this.cboRole.Items.AddRange(new object[] { "Admin", "User", "Guest" });
this.lstTags.Items.Add("urgent");
```

The parser's property branch (`DesignerDocument.cs:204`) only matches `AssignmentExpressionSyntax`,
so these statements currently fall through every branch and are silently ignored. That is why
`Items` needs its own parse path rather than a one-line addition to `ReadProperties`.

Three shapes must be recognised, in source order, because order is the list:

| Shape | Meaning |
|---|---|
| `x.Items.AddRange(new object[] { "a", "b" })` | the whole collection, VS-typical |
| `x.Items.AddRange(new string[] { ... })` | same, string-typed array |
| `x.Items.Add("a")` | one item appended |

Anything else on `Items` — `Insert`, `Clear`, `Remove`, `RemoveAt`, or an `AddRange` whose argument
is not a literal array — makes the collection **unmodelled**. We then surface no `items` field and
never rewrite it, because a partial parse followed by a rewrite would destroy the operations we
did not understand. This is the same "refuse rather than simulate" stance as `Dock`/`Anchor`
(ADR 0003), applied to a single property.

## 2. Schema

`ControlProperties` gains:

```ts
items?: string[]   // present only for ComboBox/ListBox, and only when fully modelled
```

The canvas keys the editor off `Array.isArray(c.properties.items)` — **not** off a type list. One
source of truth (the schema) is better than two lists that can disagree, and it means a future
`CheckedListBox` needs no canvas change.

`items` is `[]` (not omitted) for a `ComboBox` with no items yet, so the editor is shown and the
INSERT path is reachable. It is omitted entirely when the collection is unmodelled.

## 3. Patcher — three paths

| Case | Action |
|---|---|
| Control has items, schema items **differ** | **Replace** the items statements with one `Items.AddRange(...)` |
| Control has **no** items, schema items non-empty | **Insert** one `Items.AddRange(...)` |
| Control has items, schema items **empty** | **Delete** the items statements |

**Replace and delete share a safety check.** The items statements are replaced as a single span,
from the first to the last. If any *non-items* statement lies strictly between them, the rewrite
is skipped — otherwise replacing the span would delete unrelated code. This is the same
byte-preservation invariant as everything else in the patcher (ADR 0001).

The replacement is always a single `Items.AddRange(new object[] { ... })`, regardless of whether
the original was `Add` or `AddRange`. That is a deliberate normalisation: the collection is
replaced wholesale, so its representation is ours to choose, and `AddRange` is what Visual Studio
emits.

**Insert** anchors after the control's last property assignment (or its instantiation, or its
`Controls.Add`), exactly as `InsertProperty` does — the statement must land inside the control's
own block, never after its `Controls.Add`.

## 4. Canvas

A list editor, not a text field: one text input per item, a remove button per row, and an "Add
item" button. A textarea would conflate "no items" with "one empty item" and would break on
items containing newlines; a list editor is the honest control and is not much more code.

Shown only when `Array.isArray(c.properties.items)`. Editing posts a commit with the new array —
the same `commit` path as every other property, so undo and the document-sync invariants come
for free.

## 5. Verification

Per `fixtures/README.md` the corpus cannot be vendored, so a **hand-authored** fixture:

- `fixtures/items/ItemsForm.Designer.cs` — a `ComboBox` with an `Items.AddRange`, a `ListBox`
  with two `Items.Add` calls, and a `ComboBox` with **no** items (so the insert path is
  exercised). Classic dialect, hand-authored to the existing fixtures' conventions.

Assertions, in `test/verify.sh`:

- **Parse:** all three read back with the right items, in order; the no-items one reads `[]`.
- **Replace:** changing the `ComboBox`'s items rewrites exactly the `AddRange` argument and
  nothing else — asserted by exact diff.
- **Insert:** adding items to the empty `ComboBox` inserts one `Items.AddRange` line.
- **Delete:** emptying the `ListBox` removes its `Items.Add` statements.
- **Unmodelled:** a control with `Items.Insert` surfaces no `items` field and is never rewritten.
- **Compile gate:** the fixture compiles as a real `net10.0-windows` WinForms project — the only
  check that an emitted `AddRange` is legal C#.
- **Canvas harness:** the editor appears for a `ComboBox`, editing posts a commit carrying the new
  array, and it does **not** appear for a `Button`.

## 6. Acceptance

1. `Items.AddRange` and `Items.Add` both parse, in order, for `ComboBox` and `ListBox`.
2. Changing items rewrites only the items statements — exact diff, nothing else moves.
3. Adding items to a control that has none inserts a single `Items.AddRange`.
4. Emptying a control removes its items statements.
5. A control with `Items.Insert`/`Clear`/`Remove` is never rewritten and shows no editor.
6. The fixture compiles as a real WinForms project.
7. The canvas shows a list editor for `ComboBox`/`ListBox` and not for other types.
8. `test/run-all.sh` is green.

## 7. Open decisions

1. **Normalise to a single `AddRange`** on replace (recommended). The collection is replaced
   wholesale, so mixing `Add` and `AddRange` in the output would be churn the user did not ask
   for. `AddRange` is what Visual Studio emits.
2. **No drag-to-reorder** (recommended). Up/down buttons are a separate change; add/remove/edit
   is the "basic editing" the user asked for.
3. **`Items.AddRange(new object[] { ... })`**, not `new string[]` (recommended). `object[]` is
   what the WinForms designer emits and what real files contain, so it matches the corpus.
