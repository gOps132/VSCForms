# The rename boundary: the one operation that leaves the Designer File

Amends [ADR 0001](0001-file-is-source-of-truth.md). Every other operation VSCForms performs is
confined to the Designer File. A rename cannot be.

## Context

ADR 0001 holds because every operation we perform is a **Surgical Patch** within
`InitializeComponent()`. The whole design — never regenerating the method, `TextChange`s over the
original `SourceText` — rests on that containment.

A control's name appears in two places:

```csharp
// Form1.Designer.cs  — generated, and the file we own
private System.Windows.Forms.Button btnCalculate;

// Form1.cs  — HAND-WRITTEN, and not ours
this.btnCalculate.Click += new System.Windows.Forms.EventHandler(this.btnCalculate_Click);
```

Renaming only the Designer File leaves `CS1061` in the user's project, at build time, after they
saved. Worse, **our harness would not catch it**: the compile tier builds the Designer file with a
generated `Form1.cs` shim that has no handler wiring, so a dangling reference is invisible to
every tier we have. This is precisely the failure mode the compile tier exists to prevent, and
closing it requires a fixture with real handler wiring — see Consequences.

## Decision

Admit rename, with an explicit boundary and a refusal rather than a guess.

1. **The Designer File is always updated** — field declaration, instantiation, every property
   assignment, `Controls.Add`, and any event wiring that happens to live there.
2. **The code-behind is updated only where the identifier is unambiguously a reference to the
   control** — i.e. it is the receiver of a member access: `id.Click`, `id.Scroll +=`,
   `id.Value = …`. These are references to the control and the rewrite preserves semantics
   exactly.
3. **If the identifier appears anywhere else in the code-behind** — a local, a parameter, a
   member of another class, inside a string or comment — the rename is **refused**, naming the
   file and line. The user renames in their IDE, which is a better tool for the ambiguous case
   anyway.
4. **Locked controls and refused forms cannot be renamed.** A locked control has no field we own,
   and a refused form is one we have already declined to write.

Both files' edits are computed and validated before either is written, so a refusal leaves both
byte-identical.

### Why refuse rather than guess

The same stance as [ADR 0003](0003-refuse-rather-than-simulate.md), for the same reason. A
refusal costs the user one rename in an editor they already have open. A wrong guess costs them
a build error in their own project, discovered later, with our name on the diff.

We do not touch strings or comments even in the Designer File. A control's name appearing in a
`/// <summary>` comment is not a reference, and rewriting it would be churn the user did not ask
for — the same reasoning that keeps `Locked Control` code untouched.

## Consequences

- **The boundary must be written down**, because "the Designer File is the source of truth" is
  now true with one named exception rather than unconditionally. That is the amendment.
- **A new compile fixture is required.** Renaming must be tested against a form whose code-behind
  actually wires `Click +=`, or the dangling-reference bug is undetectable. A fixture with an
  un-wired shim would pass while the product was broken.
- **`Form1.cs` is now occasionally written by us.** It stays hand-written and user-owned; we edit
  one identifier in it and nothing else. If we ever grow event scaffolding
  ([no event scaffolding in v1](0001-file-is-source-of-truth.md) is the current position), that
  is a much larger claim on the same file and wants its own decision.
- **Undo still works unchanged.** Both writes go through the same `CustomDocumentEditEvent`
  mechanism, so one Ctrl+Z restores both files. See
  [ADR 0004](0004-undo-is-vs-codes-job.md).
- Renaming across projects — a control referenced from another file — is out of scope. The scan
  covers the sibling code-behind only.