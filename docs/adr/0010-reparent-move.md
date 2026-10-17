# Reparenting as an Add move: container transfer without recreation

Amends [ADR 0001](0001-file-is-source-of-truth.md) and extends [ADR 0009](0009-z-order-move.md).
The file stays the source of truth; this decision defines how controls transfer across
containers (Panel, GroupBox, TabPage, form top level) without destroying unmodelled code.

## Context

Moving a control across container boundaries (e.g., dropping a Button into a Panel, or
dragging it out onto the Form) changes the parent-child relationship in the schema tree.
In a naïve generator, a node disappearing from `Form.Controls` and reappearing in
`Panel.Controls` reads as a DELETE from the form followed by an INSERT into the panel.

Expressing reparenting as delete+insert would **destroy and recreate the control**, obliterating
the ~42% of statements the schema cannot express (ADR 0001: custom event handlers, anchors,
docking, resource bindings, unmodelled properties). Furthermore, delete+insert emits new
variable names or duplicates existing ones.

In WinForms Designer code, container membership is expressed purely by which `Controls.Add(...)`
call receives the control instance:
- Form top level: `this.Controls.Add(this.btnGo);`
- Container child: `this.panel1.Controls.Add(this.btnGo);`
- TabPage child: `this.tabPage1.Controls.Add(this.btnGo);`

The declaration, instantiation, and property configuration blocks of the control are completely
independent of its container. Reparenting is therefore a surgical relocation of the `Controls.Add`
statement and nothing else.

## Decision

Admit container reparenting as a surgical **`Add` move**:

1. **Reparenting moves the `Controls.Add` statement, never deleting the control.** When a
   control's parent changes between the parsed file and incoming schema, the patcher cuts the
   old `Controls.Add` line and inserts a new `Add` line under the target container's `Add`
   block. The declaration, `new`, property assignments, and event subscriptions remain
   completely untouched.
2. **Preserve dialect and child-argument syntax.** The new `Add` line preserves the source
   file's indentation, line endings (`_eol`), and child argument expression (e.g. `this.btnGo` vs
   `btnGo`). The receiver is updated to target container syntax (`this.panel1.Controls.Add(...)` or
   `this.Controls.Add(...)` for top-level), respecting `UsesThisPrefix` and qualification.
3. **Container targeting & TabPage resolution.** TabControl never holds leaf controls directly
   (ADR 0006); a drop onto a TabControl resolves to its active TabPage (`tabPage.Controls.Add`).
   `TabPages.Add` is preserved for TabPage instances moving between TabControls.
4. **Coordinate conversion on transfer.** Canvas coordinates are relative to the parent. Dropping
   into a container converts the form-space point into the container's internal coordinate frame
   (`child.x - container.x`, `child.y - container.y`) clamped to container bounds, emitting a
   single atomic commit that updates both the parent relation and the `Location` property.
5. **Locked controls and locked containers are never rewritten through (Invariant 4).** A Locked
   Control cannot be reparented. A Locked Container cannot receive children or have children
   removed from it. If either container is locked, the reparent is refused and no changes emit.
6. **Refuse ambiguous reparents.** If a control's `Controls.Add` call appears multiple times in
   the Designer source, the operation cannot safely identify which line to relocate. The patcher
   refuses with `ok: false` and `ambiguous-reparent`, leaving the file untouched (ADR 0003).
7. **Isolation from concurrent z-order reorders.** If a container group gains or loses a member
   via reparenting during a commit, z-order reordering for that group is deferred (`skipGroups`).
   This prevents overlapping text edit spans over the same line range. The z-order settles on the
   subsequent commit.
8. **Verification via trial re-parse.** After applying text changes, the patcher re-parses the
   trial `SourceText` and asserts that every reparented control now belongs to the target container.
   If verification fails, the reparent change is dropped rather than emitting a malformed file.
9. **One debounced commit, one undo step.** Move and reparent coalesce into a single commit
   message, providing a single atomic undo/redo step in VS Code (ADR 0004).

## Consequences

- Drag-and-drop reparenting works natively on the design canvas across panels, group boxes, and
  tab pages.
- Non-modelled statements and custom code for the moved control survive byte-for-byte.
- Outline and canvas remain synchronized; outline step-order buttons operate within sibling
  groups without triggering accidental reparents.
- Moving between containers is fully undoable via standard Ctrl+Z.
