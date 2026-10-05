# WinForms Visual Designer

A VS Code extension that opens a WinForms `Form.Designer.cs` as a visual canvas and edits it,
running natively on macOS, Linux, and Windows with no Wine and no Windows-only dependency.

## Language

**Designer File**:
The generated `Form.Designer.cs`. Despite the name this is the file MacForms edits, and it is
the source of truth for the form's layout — not a build artifact to be discarded.
_Avoid_: generated code, codegen output (it is edited in place, so "generated" misleads)

**Form Schema**:
The JSON projection of a Designer File that the canvas renders and edits. Lossy by design:
it models a subset of a form, and everything it omits is preserved in the file but invisible
to the canvas.
_Avoid_: model, IR, AST (it is a view, not a representation of the whole file)

**Modelled Control**:
A control whose type the canvas understands, with editable properties. Only geometry is
editable on any control; appearance properties require the type to be modelled.
_Avoid_: supported control, known control

**Locked Control**:
A control rendered as a grey, non-interactive box because its type is not modelled. Present in
the form, visible in the canvas, never editable, never rewritten.
_Avoid_: unknown control, unsupported control ("unknown" implies we failed to parse it; we
parsed it perfectly and simply decline to model it)

**Coverage**:
The per-form percentage of controls the canvas can actually model, computed fresh on every
parse and always displayed. It is a disclosure obligation, not a quality score.
_Avoid_: completeness, support level

**Coverage Banner**:
The persistent canvas notice stating how many controls are modelled, how many are locked, and
why. Must never be hidden or collapsed away.
_Avoid_: status bar (it is not dismissible chrome)

**Refusal**:
The canvas declining to edit a form at all, with the reason named. Reserved for cases where
we cannot faithfully represent the form: resource-driven geometry, or simulated layout
semantics we do not implement.
_Avoid_: error, disabled (a refusal is a correct decision, not a failure)

**Surgical Patch**:
A code change that touches only the exact syntax nodes the user modified, leaving every other
byte of the file identical. The alternative — regenerating the method — destroys unmodelled
code.
_Avoid_: minimal diff, incremental edit (both are weaker; surgical means the untouched bytes
are provably unchanged)

**Handled Types**:
The 11 control types with modelled rendering and editable appearance, enumerated in
`SCHEMA.md`. Chosen from measurement over a corpus of 154 real Designer Files.
_Avoid_: v1 types (v1 is a version, these are a set)

## Deliberate non-goals

These are decisions, not omissions. Each has an ADR.

- **No layout simulation.** Dock/Anchor are a stacking and resize algorithm. We detect them and
  refuse the form rather than render it wrongly.
- **No `.resx` reading.** For 41.56% of real forms, the Designer File is not the form; geometry
  and text live in the sibling resource file. Half-reading it is worse than refusing.
- **No pixel parity.** We cannot call `OnPaint` on real controls, because WinForms is
  Windows-only and that dependency is in the rendering primitive itself. The canvas is a
  *layout* view, not a *rendering* view.
- **No event scaffolding.** No `btnSubmit_Click` generation in v1.