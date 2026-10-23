# ADR 0003 Amendment — Partial container modeling for SplitContainer and TableLayoutPanel

Amends [ADR 0003](0003-refuse-rather-than-simulate.md) §2 and §3.

## Context

Issues #9 (`SplitContainer`) and #10 (`TableLayoutPanel`/`FlowLayoutPanel`) are blocked
because ADR 0003 refuses all layout simulation. Both are container types whose basic
structure (`Panel1`/`Panel2`, `SplitterDistance`, `RowCount`/`ColumnCount`) does not
require Dock/Anchor simulation — only the children inside do.

## Amendment

The refusal remains for forms that use `Dock`/`Anchor` (40.91% of corpus). The amendment
allows basic container modeling for `SplitContainer` and `TableLayoutPanel`/`FlowLayoutPanel`
as container types only: the container's own geometry (`Location`/`Size`) is edited,
its structural properties (`SplitterDistance`, `RowCount`, `ColumnCount`) are modeled,
and its children are preserved-but-invisible (same as existing placeholders). No
layout simulation is added: children inside are still shown absolutely, with a
read-only banner warning. The `Dock`/`Anchor` refusal on the parent form continues
to apply.

## What changes

- `SplitContainer`: added to TypeTable (`splitcontainer`), prefix (`spl`), container type.
- `TableLayoutPanel`: added to TypeTable (`tablelayoutpanel`), prefix (`tlp`), container type.
- `FlowLayoutPanel`: added to TypeTable (`flowlayoutpanel`), prefix (`flp`), container type.
- No `Dock`/`Anchor` simulation: the refusal logic (Patcher.cs) stays unchanged.
- Children inside these containers remain preserved-but-invisible, with the same warning as C2.

## Consequences

Issues #9 and #10 unblock. The 40.91% refusal rate is unchanged (forms using Dock/Anchor
are still refused). The new types add structural visibility without claiming layout accuracy.
