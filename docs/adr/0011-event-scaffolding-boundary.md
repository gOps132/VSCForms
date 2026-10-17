# Event scaffolding boundary: the second operation that leaves the Designer File

Amends [ADR 0001](0001-file-is-source-of-truth.md) and [ADR 0008](0008-rename-boundary.md). Event
scaffolding joins rename as the only operations in VSCForms permitted to edit hand-written code.

## Context

Visual Studio WinForms pair-programming and visual design workflows fundamentally rely on event
wiring: double-clicking a control or selecting an event in the Properties window scaffolds an
event handler in code-behind (`Form1.cs`) and connects it in `InitializeComponent()`
(`Form1.Designer.cs`).

In VSCForms, [ADR 0001](0001-file-is-source-of-truth.md) established that the `.Designer.cs` file
is the source of truth, confining all surgical patches to `InitializeComponent()`.
[ADR 0008](0008-rename-boundary.md) introduced the first exception: control renames must update
member-access receivers in `Form1.cs` to prevent dangling references (`CS1061`), bound by strict
refusal rules rather than guessing.

Event scaffolding is a deliberate addition to `Form1.cs`: it inserts new member methods into the
user-owned class. Because user code in `Form1.cs` must never be corrupted, lost, or reformatted,
this capability requires explicit architectural containment and failure semantics.

## Decision

Admit event scaffolding and unwiring via dedicated engine commands (`wireEvent` and `unwireEvent`),
governed by transactional safety, strict refusal criteria, and exact dialect/byte preservation.

### 1. Dual-file transactional edit

1. Both files (`Form1.Designer.cs` and `Form1.cs`) are parsed, their edits calculated, and syntax
   validated in memory before either file is modified on disk.
2. If either calculation fails or violates a safety invariant, neither file is touched and a typed
   `errorKind` is returned.
3. Undo/redo integrates through VS Code's `CustomDocumentEditEvent` so that a single `Ctrl/Cmd+Z`
   reverts edits across both files simultaneously.

### 2. Refusal rather than guess

Event scaffolding refuses cleanly (`ok: false`) without touching any file when:
- **`no-code-behind`**: The sibling `Form1.cs` does not exist on disk.
- **`unparsable-code-behind`**: `Form1.cs` has syntax errors, lacks a matching partial class declaration,
  or has multiple ambiguous declarations that cannot be resolved.
- **`locked` / `refused`**: The target control is locked (Invariant 4) or the form itself is refused
  (Invariant 5).

### 3. Dialect fidelity and placement

1. **`Form1.Designer.cs` (`+=` wiring)**:
   - Emitted strictly in the file's own observed dialect:
     - `UsesThisPrefix`: `this.btn.Click += ...` vs `btn.Click += ...`.
     - Delegate style: matches the dominant style in the file (`new System.EventHandler(...)` vs
       method group `..._Click`).
   - Placed within the control's initialization block in `InitializeComponent()`.
2. **`Form1.cs` (handler method stub)**:
   - Placed immediately before the closing brace `}` of the form's partial class.
   - Emits standard signature matching the event's delegate (e.g. `(object sender, EventArgs e)` or
     typed arguments like `MouseEventArgs`, `KeyEventArgs`, `CancelEventArgs`).
   - Emits an empty method body `{ }`.
   - Respects the existing indentation (spaces/tabs) of sibling methods in the class.
   - Preserves line endings (CRLF vs LF) and UTF-8 BOM.

### 4. Method reuse and idempotency

If a method matching the specified handler name already exists in `Form1.cs`:
- The engine does NOT insert a duplicate method.
- The engine wires the event in `InitializeComponent()` to the existing method.
- The engine returns the source location of the existing method for navigation.

### 5. Clearing (unwire) semantics

When an event is cleared or reset in the inspector:
- The `+=` subscription line is surgically removed from `Form1.Designer.cs`.
- **`Form1.cs` is left untouched.**
- *Rationale*: Deleting methods in `Form1.cs` would risk deleting user logic, user comments, or
  breaking other controls that share the same handler method. This matches Visual Studio's exact
  behavior.

### 6. Protocol isolation

Event operations travel as dedicated engine commands over stdio:
- `wireEvent`: `{ "cmd": "wireEvent", "path": "...", "controlId": "...", "eventName": "...", "handlerName"?: "..." }`
- `unwireEvent`: `{ "cmd": "unwireEvent", "path": "...", "controlId": "...", "eventName": "..." }`

Event scaffolding does NOT ride normal `generate` schema commits. `generate` remains dedicated to
syncing canvas geometry/property state to `Form1.Designer.cs` alone.

## Consequences

- `Form1.cs` is now written for two distinct purposes: receiver identifier updates (rename) and
  method stub generation (scaffolding).
- The engine protocol gains `wireEvent` and `unwireEvent` commands returning navigation coordinates
  (`targetLine`, `targetColumn`).
- Dedicated tests with real code-behind (`fixtures/events/`) and real `dotnet build` compile checks
  are mandatory to prevent signature mismatches or dangling delegate references.
