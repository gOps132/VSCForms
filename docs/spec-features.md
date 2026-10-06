# Feature gaps against the Visual Studio WinForms designer

**Status:** ACCEPTED — decisions resolved in §8. **Partially implemented**: §8 decision 6 minus
`Items`. See §8b for exactly what shipped.
**Read alongside** [`spec-canvas-qol.md`](spec-canvas-qol.md), which covers the *interaction*
gaps. This covers the *capability* gaps. They are separate: a perfectly smooth canvas that
cannot represent a `TabControl` is still limited, and a complete type table with no zoom is
still painful to use.

## 0. Facts this rests on (verified, not assumed)

- **11 handled types** (`engine/src/TypeTable.cs`): Button, Label, TextBox, CheckBox,
  RadioButton, ComboBox, ListBox, PictureBox, Panel, GroupBox, and Form. **Containers: Panel and
  GroupBox only.**
- Measured over a 154-file corpus: **47.9% per-form coverage ceiling**, **16.2%** of forms fully
  representable, **41.6%** use `resources.ApplyResources`, **40.9%** use `Dock`/`Anchor`.
- The two refusals dominate everything: a form using either is read-only regardless of which
  types we support. **This is the single most important fact in this document** — see §1.
- Modelled properties are geometry (`x/y/width/height`), `text`, `tabIndex`. BackColor, Font,
  Visible, Enabled exist in the schema but are **not editable in the canvas** — only geometry
  and text are wired to the inspector.
- The schema is a **lossy view**, so any property we cannot model is preserved in the file but
  invisible. Every gap here is a visibility gap first and an editing gap second.

## 1. Start with the refusals, not the type table

The tempting plan is "add more types". Measurement says that is the *third* most valuable thing
to do, and doing it first is a mistake worth naming.

```
154 real Designer files
  ├─ 41.6%  use resources.ApplyResources   ─┐
  ├─ 40.9%  use Dock or Anchor            ─┤─ refused: read-only, canvas shows nothing usable
  │                                        │
  └─ ~17.5% neither                        ─┴─ the editable population
```

Within that ~17.5%, the 47.9% coverage ceiling then applies. So:

- **Doubling the type table from 11 to ~22 types** moves the editable population very little,
  because the forms that need those types skew toward `Dock`/`Anchor` and `.resx` — a `TrackBar`
  or a `DateTimePicker` usually arrives in a form that also docks it.
- **Support for `Dock`/`Anchor` or `ApplyResources` would multiply the editable population
  several times over.** That is why ADR 0003's refusals cost more than they appear to, and why
  the honest framing in ADR 0006 matters: we decline because we cannot produce correct code.

Neither is available today, and both are *hard*, not *large*:

- `ApplyResources` needs a `.resx` reader. The spec's own note says half-reading it is worse
  than refusing, so this is all-or-nothing.
- `Dock`/`Anchor` is a stacking-and-resize algorithm. ADR 0003 and §5 of
  `spec-example-compatibility.md` both say a *layout-panel refusal* is the honest option and a
  full simulation should not be started without an ADR amendment.

**Recommendation: do not attempt either. Keep refusing, and spend the effort on the population
we can already reach.** The type table is the right next thing — but for the reason below, not
the one it looks like.

## 2. Why the type table still earns its place

Within the editable population, a `TrackBar` is currently a **Locked Control**: grey,
non-interactive, never written. That is honest, but the user sees a form they cannot complete.
Adding types does not chase coverage percentages — it removes *specific, visible* blockers on
forms we already claim to support, and it is template-only work.

**Per the type-table rule in `AGENTS.md`, each type needs a row in `TypeTable.cs` *and* a row
in the canvas `HANDLED` list.** A type in only one of the two renders as a locked box with no
way to tell why — the exact symptom `AGENTS.md` calls out. So the cost per type is two rows
plus a renderer, and forgetting the second row is the likely failure.

### Phase A — leaf widgets (S, no schema change, no patcher work)

Ordered by how often they appear in the editable population:

| Type | Prefix | Why |
|---|---|---|
| `TrackBar` | `trk` | 3 locked controls in the shipped `example/`; slider controls are extremely common |
| `NumericUpDown` | `num` | near-universal on data-entry forms, and pairs with `TextBox` |
| `DateTimePicker` | `dtp` | same |
| `ProgressBar` | `prg` | common, geometry-only, `Text` disabled like `Panel` |

These are **leaf** widgets: no children, so only `Patcher.cs:85`'s delete guard is affected, and
that keys off type, not off the new row. **Zero patcher work.** `ProgressBar` is the cheapest —
`Text` is meaningless on it, so it renders geometry-only exactly like `Panel`.

### Phase B — `TabControl` + `TabPage` (M, schema + canvas + patcher)

The highest-value *structural* gap, and the one with a real design question.

- `TabPage` is a genuine container → add both to `Containers`, so children nest.
- Needs a **tab-strip renderer** and correct `Controls.Add` parenting (pages go to
  `tabControl.Controls.Add(page)`, and controls to `page.Controls.Add(...)`). Two levels.
- Recovers **currently invisible subtrees**: children of a locked non-container are not merely
  locked boxes, they are *absent* (`DesignerDocument.cs`). A `TabPage` full of controls is
  invisible today, so this is a visibility win as much as an editing one.

### Phase C — labelled placeholders, read-only (M, display only)

`DataGridView`, `ListView`, `TreeView` render as labelled boxes showing **name and type but no
interior**. Their contents (columns, nodes, items) are collections the schema cannot express, so
honest display stops at the boundary.

This is genuinely better than a grey box, and it is honest as long as the box says what it is.
But be clear about the payoff: these types correlate strongly with `Dock.Fill`, so most of the
benefit lands on forms we already refuse. **Document it as a coverage/visibility improvement,
not an editing one.**

## 3. Properties — the gap nobody notices until they use it

More impactful than most new types, and much cheaper. Today the inspector exposes
**X, Y, Width, Height, Text, TabIndex, Name**. Missing:

| Property | Cost | Note |
|---|---|---|
| `Enabled` | trivial | `bool` — already in the schema |
| `Visible` | trivial | `bool` — already in the schema |
| `BackColor` | small | already in the schema; needs a colour string ⇄ `Color` conversion in the patcher |
| `Font` | small | `{size, bold, italic, family}` already in the schema; a `Font` literal is a 2-arg construction with a subtlety — see below |
| `MaximumLength`, `Multiline`, `ReadOnly`, `PasswordChar` | small | per-type; TextBox-only |
| `Items` for `ComboBox`/`ListBox` | small | precedent exists: `tabIndex` in `Patcher.cs` |

The schema already declares most of these. **They are parsed-but-not-wired**, which makes them
the cheapest real capability in this document: no schema change, no ADR, and the patcher work is
one `TextChange` per property following an existing pattern.

One trap worth naming, because it is the same shape as ADR 0005: writing `this.txt.Font` means
emitting a `new System.Drawing.Font(...)`. Two hard requirements — the patcher must **preserve
the file's existing qualification style** (`new Font` must stay `new Font`), and must handle the
fact that `Font` is not a simple assignment but a re-construction. Getting this wrong is silent
churn on every edit, which is exactly what the dialect work exists to prevent.

## 4. Features, not types

| Feature | Cost | Notes |
|---|---|---|
| **Multi-select, align, distribute** | M | QOL; see `spec-canvas-qol.md` §3. Pure geometry over data we already hold |
| **Copy / paste / duplicate** | S–M | `Cmd/Ctrl+D` is the cheap version |
| **Z-order** | M + **protocol change** | **Not free** — `generate` diffs by `id`, so a reorder is currently unrepresentable and delete+insert would destroy unmodelled properties. Needs a patcher move + ADR. Deferred |
| **Event scaffolding** (`btnSubmit_Click`) | M | Deliberately absent (v1). Note it is a *bigger* claim on the hand-written `Form1.cs` than rename was — ADR 0008 is the precedent for how to bound that |
| **Tab order / tab index editing** | S | `TabIndex` exists in the schema and the canvas; the *ordering* UI does not |
| **Resource editing** (images for `PictureBox`) | L | Needs image serialisation. Out of scope |
| **UserControl composition** | L | A nested designer. Genuinely a different product |

## 5. Explicitly not planned

- **`Dock`/`Anchor` support.** ADR 0003. §1 above.
- **`.resx` reading.** ADR 0003. Half-reading is worse than refusing.
- **`TableLayoutPanel` / `FlowLayoutPanel`.** Rendering children absolutely would contradict
  ADR 0003's stance and produce a canvas that *lies*. The honest options are a new
  `layout-panel` refusal, or a full simulation — and the spec says not to start the latter
  without an ADR amendment.
- **`MenuStrip` / `ToolStrip` / `StatusStrip` / `ContextMenuStrip`.** Items are not `Control`s.
  They have no `Location`/`Size`, so they are unmodellable by construction without a new schema
  shape. Cosmetic, and their host forms usually refuse anyway.
- **Pixel parity.** ADR 0006. Not a roadmap item; it is not achievable.
- **Tray / non-visual types** (`Timer`, `NotifyIcon`, `ImageList`, `ToolTip`,
  `ErrorProvider`): these belong in `NonVisualFields`, never in the handled table. They are not
  controls and must not render as boxes.

## 6. Recommended order

Each step is independently shippable and independently testable.

1. **QOL** (`spec-canvas-qol.md`) — zoom first, alone. It touches every coordinate calculation,
   so doing it before new controls exist is strictly cheaper.
2. **Properties that are already in the schema** (§3) — cheapest real capability here. No schema
   change, no ADR, and it makes every form more editable the moment it lands.
3. **Phase A leaf widgets** (§2) — `ProgressBar`, `TrackBar`, `NumericUpDown`, `DateTimePicker`.
   Four `TypeTable` rows, four canvas rows, four renderers, four fixtures.
4. **Phase B `TabControl` + `TabPage`** — the one structural feature worth the schema work.
5. **Multi-select + align + distribute** — depends on nothing above, but is more valuable after
   there are more controls to align.
6. **Phase C placeholders** — cheapest of the visibility wins, lowest editing payoff. Do it when
   there is time, not before.
7. **Z-order**, only with the protocol change and an ADR.

## 7. Verification

Per the established pattern, each step needs all three of:

- a **hand-authored fixture** with the exact expected model output (`fixtures/README.md`: the
  real corpus is GPL-3.0 or unlicensed and cannot be vendored);
- an **exact-diff** assertion in the relevant tier — not "it did not crash";
- a **real compile gate**, because a badly-emitted `Font` or `Items` literal compiles fine and
  is wrong in a way only inspection catches.

For Phase B specifically, add a canvas DOM case asserting a control nested two levels deep
(a control inside a `TabPage` inside a `TabControl`) resolves its position relative to the page,
not the form. That is the bug a flat renderer would have.

## 8. Decisions

1. **Refusals stay** (ADR 0003). §1 explains why this is the highest-leverage decision in the
   document: it is what makes the type table look more valuable than it is.
2. **Properties before types.** Cheapest capability available — no schema change, no ADR — and
   it improves every form rather than unblocking a few.
3. **Phase C placeholders are display-only and say so.** A box that admits what it cannot show
   is honest; one that implies an editable grid is not.
4. **Z-order deferred** pending a protocol change + ADR. Shipping it as delete+insert destroys
   unmodelled properties.
5. **`example/` stays untouched** while `spec-phase-2.md` §5 is unresolved. `TrackBar` (Phase A)
   would take it from 91.4% to 100%, which is a good demonstration and a reason to revisit
   whether it should be committed at all.
6. **Properties wired in this pass, in order of cost:** `Enabled`, `Visible`, `BackColor`, then
   `Font`. `Font` is last because emitting a `new Font(...)` is a *construction*, not an
   assignment, and it is the one that can silently churn a file's dialect — see §3.
   **`Items` was dropped from this pass.** It needs a schema field, a parser change for
   `Items.AddRange(...)`, and a list editor in the canvas, which is a different size of work
   from the other four. It stays the obvious next property.

## 8b. Implementation scope for this pass

Implemented now: §8 decision 6 **minus `Items`** — `Enabled`, `Visible`, `BackColor`, `Font`.
Plus the QOL work in `spec-canvas-qol.md`, without which these are unusable at zoom.

Not implemented, recorded so the boundary is explicit: `ComboBox`/`ListBox` `Items`, Phase A
leaf widgets, Phase B `TabControl`, Phase C placeholders, z-order, event scaffolding.

Within QOL, also not implemented: clipboard copy/paste (`Cmd/Ctrl+D` duplicates instead) and
z-order, which is deferred by decision 4.
