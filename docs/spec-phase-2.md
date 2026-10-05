# Phase 2 — generator command, rename, declared dialects

**Status:** draft for review — no code changed.
**Scope:** three independent items, sequenced below. Each is additive; none changes the
Form Schema's meaning, and none touches a byte of any existing fixture.

## 0. Facts these rest on (verified, not assumed)

- The engine is the only component that edits files byte-preservingly. `engine/src/Program.cs`
  reads raw bytes so the UTF-8 BOM survives; `Patcher.cs` preserves CRLF/LF and body
  indentation. The extension host does no file editing at all.
- `scripts/new-project.sh` edits a csproj with a Python heredoc. That injection **rewrote the
  SDK's CRLF as LF** until it was given `newline=''` — caught only because
  `test/verify-generator.sh` asserts BOM *and* CRLF rather than just the property's presence.
  Any second implementation of that edit inherits the same bug.
- `scripts/` is not packaged. `scripts/package-all.js` runs `vsce package` with `cwd: extension/`,
  so only `extension/` ships. A command that shells out to `new-project.sh` would work in
  `--extensionDevelopmentPath` and fail in the installed `.vsix`.
- `activationEvents` is `["onCustomEditor:macforms.formDesigner"]` only. A command that must
  work with no Designer file open cannot rely on that.
- `Patcher.cs` has no rename path. Deletion is guarded by `TypeTable.IsHandled`; modification
  skips `node.Locked`. A rename would be the first operation to touch an *identifier* rather
  than a property value.
- Dialect detection is two booleans set at `DesignerDocument.cs:206-207` from control
  instantiations and the last `Controls.Add`. The `templated` dialect contains **no control
  instantiations at all**, so `UsesThisPrefix` is false there for want of evidence, not by
  observation — indistinguishable from a genuinely bare file.
- There is no `.editorconfig` anywhere in this repo, and none in `example/`. Every dialect
  fixture is hand-authored and dialect-committed by its content alone.
- `example/` contains `.git/`, `.slnx`, `.DS_Store`, and committed `bin/`/`obj/`.

## 1. Sequencing

| # | Item | Depends on | Why here |
|---|---|---|---|
| 1 | `macforms.newProject` | nothing | Makes an existing feature reachable. Purely additive. |
| 2 | Declared dialects (`.editorconfig`) | nothing | Smallest, lowest risk. Removes one inference. |
| 3 | Rename | an ADR amendment | The only operation that leaves the Designer File. |

Item 3 goes last because it is the only one that can produce a file that does not compile, and
it needs a decision from you (D3 below) before code is worth writing.

---

## 2. Item 1 — the generator as an engine command

### The problem with the obvious implementation

The obvious implementation is a TypeScript command in the extension host that spawns
`dotnet new`. Rejected: it cannot reuse `new-project.sh`, and re-implementing the csproj edit in
TypeScript re-implements the CRLF bug above in a second language, where nothing asserts it.

The other obvious implementation — shelling out to `new-project.sh` — is worse. The script is
not in the `.vsix`, and it needs bash.

### Decision

**Add a `new` command to the engine.** The engine is already the byte-faithful file editor, it
is already covered by `test/verify.sh` with no VS Code present, and it already shells out to
nothing but the SDK. Three arguments, not one, but all three are load-bearing:

1. The csproj edit must preserve BOM and CRLF. The engine already knows how; the extension host
   does not.
2. The existing test tier reaches the engine directly over stdio. A new command is testable in
   `verify-generator.sh` today. A host-side command is only testable through
   `test/run-integration.js`, which needs a display.
3. Adding a type to `TypeTable.cs` requires a canvas row too (`AGENTS.md`). This change adds no
   types and no schema fields, so it cannot desynchronise the two lists.

### Protocol

```ts
{ "id": 4, "cmd": "new", "name": "MyDialog", "parent": "/abs/dir",
  "template": "winforms", "language": "C#" }

{ "id": 4, "ok": true, "projectDir": "/abs/dir/MyDialog",
                   "solution": "/abs/dir/MyDialog.sln",
                   "designer": "/abs/dir/MyDialog/Form1.Designer.cs",
                   "windowsTargetingAdded": true }
{ "id": 4, "ok": false, "error": "…", "errorKind": "bad-name" | "exists" |
                                    "no-dotnet" | "no-template" | "sdk" }
```

`template` and `language` are validated by the engine against `dotnet new list`, so a bad value
returns `no-template` rather than a raw SDK error string. The three traps from ADR 0007
(`-f sln`, `--no-restore`, `EnableWindowsTargeting`) move into the engine unchanged, and
`new-project.sh` is **deleted** so there is one implementation.

### Host side

One command, `macforms.newProject`:

- `activationEvents` gains `onCommand:macforms.newProject`. Without it the command is not
  registered until a Designer file is opened, which is the bug this item exists to fix.
- Collects `name` (`showInputBox`, default `Form1`, validated as a C# identifier) and `parent`
  (`showOpenDialog`, default the active workspace folder, or `~`).
- Sends `new` to the engine. The engine is spawned lazily today; this command must spawn it on
  demand even with no Designer file open.
- On success, opens the generated `Form1.Designer.cs` in the canvas — the loop closes: generate,
  then immediately edit what was generated.
- On `no-dotnet`, offer a link to the SDK download. That is the single most likely failure and
  it is not the user's fault.

### Acceptance

1. `WinForms: New Project…` from the palette with **no file open** creates a project and opens
   it in the canvas. (This is the assertion that fails today.)
2. The generated `Form1.Designer.cs` parses as the `templated` dialect: `800x450`,
   `Text = "Form1"`, `coveragePercent == 100`, `controls == []`.
3. The solution is classic text, not `.slnx`, and contains `Build.0`.
4. The csproj retains the SDK's BOM and CRLF — asserted as bytes, not as a property.
5. A control added to the generated form still compiles, and the insert is purely additive.
6. `new-project.sh` no longer exists; `verify-generator.sh` exercises the engine command.

Assertions 2–5 already exist and pass against the script. They move with it.

---

## 3. Item 2 — declared dialects

### What this actually fixes

`.editorconfig` is not a better heuristic. It is **evidence the file does not contain**, and the
gap is narrow and specific: the `templated` dialect has no control instantiations, so
`UsesThisPrefix` there is inferred from absence. A user who adds their first control to a fresh
`dotnet new winforms` project gets `this.` or bare based on nothing.

Visual Studio decides this from `dotnet_style_qualification_for_field` and
`..._for_property`. Reading those makes our first insertion match what VS would write.

### Decision

`.editorconfig` is **advisory input that fills gaps. It never overrides observation.** If a
file's own content says `this.x = new Button()`, the file wins, even if `.editorconfig` says
otherwise. This preserves ADR 0005 — we write in the file's dialect — and is the reason this is
safe to add.

Resolution order for each signal:

1. Observed in the file (as today).
2. `.editorconfig`, walking up from the Designer file to the nearest `.editorconfig` or to the
   directory containing a `.git`/`.sln`, whichever comes first.
3. Existing default.

Only exact `true` and `false` are honoured. `true:warning`, `false:suggestion` and
`true:severity` style values are IDE-enforcement severities, not the user's stylistic intent,
and are treated as "not declared".

Also read `<ImplicitUsings>` from the sibling csproj. It determines whether a qualified type
name is required — with implicit usings `new Size(1, 2)` compiles, without it
`new System.Drawing.Size(1, 2)` does. This is advisory in the same way, and only consulted for
a form with no controls yet.

### Acceptance

- A fixture with `.editorconfig` containing
  `dotnet_style_qualification_for_field = false` and no control instantiations produces bare
  output on first insertion.
- The same fixture with the property set to `true` produces `this.`-qualified output.
- A fixture **with** instantiations and a contradicting `.editorconfig` writes the file's
  dialect, not the config's. This is the assertion that pins "advisory".
- A malformed `.editorconfig` (unparseable value, `=` with no key) is ignored, not fatal.

---

## 4. Item 3 — rename

### Why this needs an ADR before code

Every other operation is confined to the Designer File. `AGENTS.md` invariant 1 and ADR 0001
rest on that. A rename cannot be: the reference lives in `Form1.cs`, in
`btnCalculate.Click += btnCalculate_Click;`, which is hand-written code, not generated.

A rename that updates only the Designer File produces `CS1061: 'Form1' does not contain a
definition for 'btnCalculateOld'` at build time — in the user's project, after they saved. It
does not fail in our harness, because our harness never compiles `Form1.cs` with handlers
attached. That is precisely the failure mode the compile tier exists to prevent, and it needs a
compile fixture with real handler wiring to be caught.

### Decision

Rename is admitted, with a precondition scan over the code-behind:

- The Designer File is always updated: declaration, instantiation, and every use.
- `Form1.cs` is updated **only** for occurrences where the identifier is the receiver of a
  member access — `id.Click`, `id.Scroll +=`, `id.ValueChanged +=`, `id.Text = …`. These are
  unambiguous references to the control and the rewrite preserves semantics exactly.
- If the identifier appears anywhere else in the code-behind — a local, a parameter, a member of
  a different class, inside a string or comment — the rename is **refused**, with the file and
  line named. The user renames in their IDE instead.
- Refused forms and locked controls cannot be renamed. A locked control has no field we own.

Refusing rather than guessing is the same stance as ADR 0003, for the same reason: a wrong
rename is a compile error in the user's project, and a missing rename costs one keystroke in
the IDE they already have open.

This needs an ADR amendment stating the boundary explicitly: *the Designer File is the source
of truth for geometry and control declarations; a rename is the sole operation that reaches the
code-behind, and it does so only as an identifier-preserving rewrite of qualified member
accesses, or not at all.*

### Acceptance

- Rename a control whose only external reference is `Click +=` → Designer File and `Form1.cs`
  both update; the result compiles; the diff is confined to the identifier.
- Rename a control referenced as a local elsewhere in `Form1.cs` → refused, reason names the
  file and line, **no file is written**.
- Rename a locked control → refused.
- Rename on a refused form → refused.
- Rename preserves BOM, CRLF and indentation in **both** files.
- The `mf_debug` span list shows the rename's `TextChange`s, and no non-identifier byte moves.

---

## 5. `example/` — a conflict in the existing draft spec

`docs/spec-example-compatibility.md` Part A asks to retarget `example/` to `net10.0-windows`
and add `EnableWindowsTargeting`. You later asked for `example/` to stay byte-identical to
Visual Studio's output. Those conflict.

**Recommendation: drop the retarget.** It is not needed. `EnableWindowsTargeting` is only
required when targeting Windows *from* another OS; on `windows-latest` the `layout` CI job
builds the example's own `net7.0-windows` project unchanged. Retargeting would only make the
fixture less faithful to buy nothing.

That leaves one destructive item from Part A: `example/.git/` (plus `.DS_Store`, and
`bin/`/`obj/` which `example/.gitignore` already hides from a parent repo only if the parent
sees through — it does not, so they need the root `.gitignore` entries Part A also specifies).

**Still needs your call.** Deleting `example/.git/` destroys the upstream history and is not
reversible from this repo. Options: (a) delete it, accepting that upstream history is gone and
recording the clone URL in the README; (b) keep it and never commit `example/`, treating it as
a scratch checkout; (c) convert to a real submodule. **(a) recommended** — a submodule means
every contributor and every CI run needs network access before the tests can pass, which is a
bad trade for a demo fixture.

---

## 6. Test plans

| Item | Tier | Notes |
|---|---|---|
| 1 | `test/verify-generator.sh` (extended) | Reaches the engine over stdio, no VS Code needed. The 17 existing assertions carry over. |
| 1 | `test/run-integration.js` | One case: command invoked with no Designer file open. |
| 2 | `test/verify-dialects.sh` (extended) | Four fixtures, two with `.editorconfig`. `.editorconfig` files must be hand-authored per `fixtures/README.md` — the corpus is GPL-3.0 or unlicensed. |
| 3 | `test/verify.sh` (extended) | Needs a **new** fixture with real handler wiring in `Form1.cs`, compiled by the compile tier. Without it the dangling-reference bug cannot be caught. |
| 3 | `extension/test/hostHarness.js` | Rename field in the inspector; assert the refusal path renders its reason. |

No change to the `layout` tier, which stays Windows-only and keeps asserting the Designer File
verbatim.

## 7. Open decisions

Defaults are what the sections above assume. Override any of them and I will revise before
writing code.

1. **Generator lives in the engine, not the extension host** (recommended). Cost: the engine
   grows a command that creates files. Benefit: byte-faithful editing, testable today without a
   display. Alternative: host-side, which means a second csproj editor and a second CRLF bug.
2. **`new-project.sh` is deleted**, not kept as a wrapper (recommended). One implementation.
3. **Rename refuses rather than guesses** when the code-behind holds an ambiguous reference
   (recommended). Cost: the user renames in their IDE for those cases.
4. **`.editorconfig` is advisory and never overrides the file** (recommended). Alternative:
   treat the config as authoritative, which would be more "correct" but contradicts ADR 0005.
5. **`example/.git/` is deleted** (recommended in §5). Destructive; your call.