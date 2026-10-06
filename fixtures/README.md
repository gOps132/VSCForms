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

## The declared-style fixtures

`declared/{qualified,bare,contradicts,malformed}/` exist only to pin the `.editorconfig`
behaviour documented in `../SCHEMA.md` — advisory input that fills the one gap dialect
detection has (the `templated` dialect contains no instantiations, so the signal is inferred
from absence).

They are used **in place**, never copied to `/tmp`: `.editorconfig` is discovered by walking up
from the Designer file, so a copy outside the fixture directory would find nothing. That is not
incidental — it is exactly what happens when a user opens a real file.

- **`qualified/`** — declares `= true`. The insert must come out `this.`-qualified.
- **`bare/`** — declares `= false`. The insert must come out bare.
- **`contradicts/`** — has ONE control, written bare, while the config says `= true`. **The
  file must win.** This is the assertion that makes the feature safe rather than a source of
  mixed-convention churn; if it ever fails, the config has become authoritative and ADR 0005 is
  being violated.
- **`malformed/`** — empty value, a line with no separator, a `true:warning` severity form, and
  a leading `=`. None may be fatal, and none may be read as intent.

## The leaf-widget fixture

`leafwidgets/LeafForm.Designer.cs` carries all four Phase A types — `TrackBar`, `ProgressBar`,
`NumericUpDown`, `DateTimePicker` — in one classic-dialect file, and exists for
`docs/spec-leaf-widgets.md`.

It is one fixture rather than four because all four are geometry-only leaves: they differ in
their prefix and default size, not in any parsing behaviour. Splitting them would duplicate the
same assertions four times.

**Its `Controls.Add` calls are load-bearing.** Real Visual Studio output always emits one per
control, and without them the parser has no way to know a control belongs to the form — the
first version of this fixture omitted them and all four controls silently vanished from the
schema. That is the fixture-fidelity trap described above, hit again by the same author.

Its `DateTimePicker` also carries `Value`, `Format` and `CustomFormat`, none of which are in the
schema, so the rename and move assertions can prove they survive untouched.
