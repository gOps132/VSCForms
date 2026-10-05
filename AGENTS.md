# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

A VS Code extension that opens a WinForms `Form.Designer.cs` as a visual canvas and edits it,
running natively on macOS, Linux and Windows with no Wine.

Three components, one authoritative contract:

| Component | Path | Language |
|---|---|---|
| Roslyn engine (parse + surgical patch) | `engine/` | C# / .NET 10 |
| Extension host + engine client | `extension/src/` | TypeScript |
| Design canvas | `extension/media/` | vanilla JS/CSS |

Read `SCHEMA.md` before changing anything that crosses a process boundary. It is the contract;
if a component disagrees with it, the component is wrong.

## Invariants — do not break these

These are load-bearing. Each has caused or prevented a real bug.

1. **The `.Designer.cs` file is the source of truth.** Never regenerate
   `InitializeComponent()` from the schema. Emit `TextChange`s over the original `SourceText`
   only. Rewriting the method destroys the ~42% of statements the schema cannot model
   (ADR 0001). When patching, replace only the argument list of a creation expression — never
   the type name (ADR 0005).
2. **Write back in the file's own dialect.** Designer files come in four shapes (classic,
   templated, bare, this-style). Inserting `this.x = ...` into a bare file, or rewriting
   `new Point(...)` as `new System.Drawing.Point(...)`, is churn the user did not ask for.
   `UsesThisPrefix` and `ControlsCollectionIsQualified` are tracked separately because the
   this-style dialect is genuinely mixed. See `SCHEMA.md`.
3. **Preserve byte-level identity outside the edit**: line ending (CRLF vs LF), UTF-8 BOM, and
   body indentation. Read files as bytes — `File.ReadAllText` consumes the BOM and would alter
   line 1 of every file on every edit.
4. **Never write a `locked` control.** No property edits, no deletion, no rename. If the diff
   logic is uncertain, emit nothing.
5. **Never write a refused form.** If `analysis.refuses` is non-empty, `generate` returns
   `ok: false` and the file is untouched (ADR 0003).
6. **stdout is a protocol channel.** The engine speaks newline-delimited JSON on stdout.
   Diagnostics go to stderr, always. One stray `Console.WriteLine` corrupts the stream.
7. **`vsce`'s `--ignore-other-target-folders` is a documented no-op in 4.x.** Prune
   `extension/bin/` yourself before packaging, or every platform's binary ships in every
   `.vsix` (ADR 0002).
8. **Do not add a local undo stack to the canvas.** Undo is delegated to VS Code via
   `CustomDocumentEditEvent`. A private stack plus the document events applies one Ctrl+Z
   twice and diverges from the file (ADR 0004).
9. **`saveCustomDocumentAs` refuses on purpose.** Writing `doc.text` to a new path would copy
   a snapshot while the canvas stayed keyed to the original. Don't "fix" it.
10. **There is no automatic fallback to the text editor** when a custom editor fails to open.
   VS Code shows its Error Editor with a bare OK. The only escape hatch is the message thrown
   from `openCustomDocument`, which must name the `Open as Text` command.

## Verifying

```bash
./test/run-all.sh                      # everything; skip integration with VSCFORMS_SKIP_INTEGRATION=1
node test/verify.sh                    # Roslyn invariants + real WinForms compile
./test/verify-rename.sh                # rename, incl. the code-behind and a real compile
node test/e2e.js                       # canvas -> host -> engine -> file
node extension/test/hostHarness.js     # DOM harness over the canvas code
node test/run-integration.js           # real VS Code; needs a display
./scripts/run-windows-layout.sh example   # schema vs real WinForms runtime; Windows only
```

Integration tests reach internals through the hidden `vscforms._testSeam` command, because the
webview is unreachable from the extension host API. Each case runs the real production path,
not a simulation.

One thing that tier cannot drive: VS Code routes Ctrl+Z to custom editors via a keybinding
implementation the extension host API cannot dispatch, so `executeCommand('undo')` does not
reach it. The suite therefore asserts that *our* undo continuation restores the file
byte-for-byte. Don't replace that assertion with a command-based one — it will silently pass
without testing anything.

Two tiers carry the most weight, and they are not the same kind of test:

- The **compile tier** builds the generated C# as a real `net*-windows` WinForms project.
  Diff inspection does not prove the product claim.
- The **layout tier** (`scripts/run-windows-layout.sh`, Windows CI only) compares our schema
  against the runtime `Bounds` of the real controls. Everything else proves the patch is
  *valid*; only this proves it is *semantically* right. A control at the wrong coordinates
  still compiles.

`MF_DEBUG=1` prints every span the patcher emits, to stderr.

## Working here

- **The generator shells out to `dotnet new`; do not add project templates of our own.** The
  output is identical to Visual Studio by construction. It lives in the **engine**
  (`ProjectGenerator.cs`, exposed as the `new` command), not the extension host and not a shell
  script — the csproj edit must preserve the SDK's BOM and CRLF, and the engine is the only
  component that already does byte-faithful editing. Three traps are handled there and must not
  be "simplified" away: `--format sln` (the SDK 10 default is `.slnx`, which VS 17.0-17.9 cannot
  open), `--no-restore` (the implicit restore fails on macOS while still exiting 0), and
  `EnableWindowsTargeting` injection. Editing those files through a `StreamReader` rewrites the
  SDK's CRLF line endings — that bug shipped once and is why `test/verify-generator.sh` asserts
  the bytes rather than the property.
- **Every `dotnet` child process must have stdout redirected.** Our stdout is the protocol
  channel; an inherited stdout puts `10.0.400` in the middle of a JSON response. This shipped
  once, via `dotnet --version`.
- **A tier that cannot run must FAIL LOUDLY, never `SKIP` with exit 0.** In CI a skip is
  indistinguishable from a pass. `run-windows-layout.sh` exits 1 when the engine is missing and
  the layout job has a canary step that fails if its own output contains `SKIP`.
- **The generator and rename tiers run in CI** (`engine` job). They were local-only for one
  commit — which meant the two tiers guarding the riskiest operations were the two CI never ran.
- **Rename is the only operation that leaves the Designer File, and it refuses rather than
  guessing** (ADR 0008). The control's name also appears in the hand-written `Form1.cs`
  (`btnGo.Click += …`), and a rename that touched only the Designer File leaves `CS1061` in the
  user's project — which the compile tier CANNOT catch, because it builds against a generated
  shim with no event wiring. That is why `fixtures/wired/` exists. Code-behind is rewritten only
  where the identifier is the receiver of a member access; anything else is refused by file and
  line. `Name = "…"` IS rewritten (it is the control's runtime identity, not prose); comments
  and the handler method name are NOT.
- **A rename must never travel as a schema `commit`.** A schema carrying a new `id` reads to
  `generate` as *old deleted + new inserted*, which duplicates the control and drops its
  properties. It is a separate `rename` command for that reason.
- `fixtures/` is **hand-authored** on purpose — the measurement corpus is GPL-3.0 or
  unlicensed. See `fixtures/README.md`. Author fixtures so tests can assert exact diffs.
- Measured limits, not guesses: **47.9%** per-form coverage ceiling for the 10 handled types,
  **41.6%** of real forms use `ApplyResources`, **40.9%** use `Dock`/`Anchor`. Those drive the
  refusals. Re-measure before changing the type table.
- Type resolution is **purely syntactic** — we never load an assembly. A type we don't
  recognise is locked, not an error.
- Adding a type to `engine/src/TypeTable.cs` requires a row in the canvas `HANDLED` list too,
  or it renders as a locked box with no way to tell why.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI at `gOps132/VSCForms`. `gh auth login` is required on a fresh machine.
See `docs/agents/issue-tracker.md`.

### Triage labels

Defaults kept: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

Use the vocabulary in `CONTEXT.md` — in particular **Modelled Control** vs **Locked Control**,
**Coverage**, **Refusal**, and **Surgical Patch**. If a change contradicts an ADR, surface it
rather than silently overriding it.