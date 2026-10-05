# Refuse rather than simulate layout or resource-driven geometry

The canvas refuses to edit a form that uses `Dock`/`Anchor` or `resources.ApplyResources`,
instead of attempting to render or edit it.

## Context

Two measured facts force this:

- **40.91%** of real forms (63 of 154) set `Dock` or `Anchor` to a non-default value. These
  controls have `Location`/`Size` values in the Designer File that are design-time artifacts
  overwritten at runtime. A user dragging such a control in our canvas produces new geometry
  that renders correctly in our canvas and does nothing on Windows.
- **41.56%** of real forms (64 of 154) call `resources.ApplyResources`. For these, the Designer
  File is *not* the form: geometry and text live in the sibling `.resx`. Half-reading it shows a
  control in one position while Windows places it in another.

Dock/Anchor are a stacking algorithm and a resize algorithm, not two values of one enum.
`RowStyles`/`ColumnStyles`/`SetRowSpan` (265 statements in the corpus) constitute a second
layout language in its own right.

## Decision

Both cases produce a Refusal: the canvas names the reason and offers the text editor. Simulating
Dock/Anchor is deferred; reading `.resx` is out of scope.

## Alternatives rejected

- *Allow editing, accept the divergence.* Fast, and quietly produces broken Windows builds — the
  failure mode this project exists to avoid.
- *Read `.resx` for display only, mark properties read-only.* A trap: it displays a truth the
  user cannot edit, which is the same dishonest-canvas problem in a subtler form.
- *Full layout simulation.* Effectively a second project.

## Consequences

Roughly two of every five real forms are refused outright, which is why the honest marketing
claim is "a visual editor for flat, non-localizable dialogs" rather than "a WinForms designer".
This is stated in the README and the marketplace listing rather than discovered by users.