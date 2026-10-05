# Fixtures

These Designer files are **hand-authored**, not copied from any project.

## Why not vendored real files

The measurements in `../README.md` and `../CONTEXT.md` were taken from a corpus of 154 real
`Form.Designer.cs` files (ShareX, dot42, dotnet/samples, mRemoteNG). That corpus is
deliberately **not** committed:

| Source | License | Usable? |
|---|---|---|
| dot42 | no license file at all ("Copyright (c) Citrix Systems") | no grant exists |
| ShareX | GPL-3.0 | would impose copyleft |
| mRemoteNG | GPL-3.0 | would impose copyleft |
| dotnet/samples | CC-BY-4.0 (grant unconfirmed) | attribution required, unclear scope |

Authoring equivalents is also *better as a test suite*: the tests can assert exact expected
model output and exact line-level diffs, which with real vendored files they could not — the
best they could do is assert "didn't crash".

## The three fixtures

Each was chosen to stress a specific decision, and each maps to a test in `../test/verify.sh`.

- **`simple/SimpleDialog.Designer.cs`** — the happy path. 5 controls, all handled types, all
  literal right-hand sides. Tests the surgical move/add/delete invariants and, critically,
  that an untouched file round-trips **byte-identical**.
- **`docked/DockedForm.Designer.cs`** — Dock and Anchor on 5 controls, plus the
  cast-wrapped bitwise-or `Anchor` spelling that breaks regex-based parsers. Must produce a
  `dock-anchor` refusal.
- **`localizable/LocalizableForm.Designer.cs`** — `resources.ApplyResources` mixed with a
  third-party control (`ThirdParty.Widgets.GaugeControl`) and an `IContainer` field. Must
  produce a `localizable` refusal, and the third-party control must come back `locked`.

## A note on faithfulness

`#region Windows Form Designer generated code` and the control field declarations are
included in all three, because real Visual Studio output includes them. An earlier version of
these fixtures omitted the field declarations entirely, and the engine correctly dropped
every control as a result — which is exactly the kind of thing authored fixtures have to get
right for the tests to mean anything.
