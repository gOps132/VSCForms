# Rename: MacForms → VSCForms

**Status:** draft for review — no code changed.
**Scope:** rename the project, the extension, the engine binary, and every internal identifier.
Additive to [`spec-phase-2.md`](spec-phase-2.md); this must land **before** it, so phase 2 is
written against the final name.

## 0. Why now

The GitHub remote is already `git@github.com:gOps132/VSCForms.git`. Nothing has been pushed, so
the repository, the extension, and every artifact can still be named consistently at no cost.
After the first push and first `.vsix` install, the same rename becomes a breaking change for
installed users (§3).

## 1. What is named what

Four distinct namespaces, each with a different blast radius. Conflating them is how a rename
turns into an incident.

| Surface | Current | Proposed | Blast radius |
|---|---|---|---|
| Repo + remote | `gOps132/VSCForms` | already correct | none — done |
| npm package name | `macforms` | `vscforms` | `.vsix` basename, marketplace listing |
| Extension id | `macforms.macforms` | `gOps132.vscforms` | **installed users** — see §3 |
| `viewType` | `macforms.formDesigner` | `vscforms.formDesigner` | **breaks editor associations** — see §3 |
| Command ids | `macforms.*` (4, soon 5) | `vscforms.*` | keybindings, docs, integration suite |
| Config namespace | `macforms` | `vscforms` | `macforms.enginePath` in user settings |
| Engine assembly | `macforms-engine` | `vscforms-engine` | 4 path candidates, CI, 6 test scripts |
| Engine root namespace | `MacForms.Engine` | `VSCForms.Engine` | 5 C# files |
| Engine csproj file | `engine/MacFormsEngine.csproj` | `engine/VSCFormsEngine.csproj` | `dotnet build engine` still works |
| Temp dir | `macforms-layout` | `vscforms-layout` | nothing |
| Harness class | `MacFormsLayoutCheck` | `VSCFormsLayoutCheck` | nothing |

**124 tracked occurrences across 30 files.** `extension/out/` and `extension/node_modules/` also
contain them but are gitignored build output — regenerated, never edited. `package-lock.json`'s
root `name` field must change too or `npm ci` warns about a lockfile/project mismatch.

### Prose mentions are a separate category

`README.md` (5), `CONTEXT.md`, `SCHEMA.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/architecture.md`,
ADR 0006, ADR 0007, and the two spec files. These say "MacForms" when describing the product.
Mechanical, but each is a sentence a reader will see, so they get reviewed individually rather
than sed'd blind.

### `example/` is not touched

The example is upstream Visual Studio output (`Form1.Designer.cs` mentions `MacForms` only in a
`RootNamespace`-adjacent string, if at all). `example/` stays byte-identical, per §5 of
`spec-phase-2.md`. The rename does not reach it.

### `fixtures/` is not touched

Zero occurrences. The fixtures are hand-authored and dialect-committed by content; a rename
gives no reason to disturb them.

## 2. The decision that shapes everything else

**Renaming the extension id and the `viewType` is a breaking change for anyone who has already
installed the extension.** Three distinct breakages:

1. **VS Code identifies an installed extension by `publisher.name`.** Changing it produces a
   *second* extension alongside the first. Both register a custom editor for `*.Designer.cs`,
   so the user gets two "WinForms Designer" entries and whichever wins is arbitrary.
2. **Editor associations are keyed by `viewType`.** `workbench.editorAssociations` in a user's
   `settings.json` — or in any `.vscode/settings.json` they committed — reads
   `"*.Designer.cs": "macforms.formDesigner"`. After the rename that key matches nothing and
   silently stops associating. No error; the file just opens as text.
3. **Keybindings on `macforms.*` commands** stop resolving. VS Code shows the binding greyed out
   in the keyboard shortcuts editor, so this one is at least discoverable.

**Recommendation: do it anyway, and do it now.** Nothing is published. There is no user to
break, and the alternative is shipping the wrong name forever or spending the migration on
0.1.0. The honest framing: this rename is free today and expensive after the first release.

If we ever *do* need to preserve compatibility, the migration is: keep the old `viewType`
registered as a second `customEditors` entry that throws the same `openCustomDocument` error
naming `Open as Text` (invariant 10), so stale associations produce a clear error instead of
silently opening as text. That is ~20 lines. Recorded here so the option is not lost — **not
recommended now**.

## 3. Ordering

The order matters because the compile tier and the integration suite hardcode paths.

1. **`engine/`** — `RootNamespace`, `AssemblyName`, the csproj filename, 5 `namespace`
   declarations. `git mv` the csproj so history follows.
2. **Rebuild the engine**; confirm `engine/bin/Debug/net10.0/vscforms-engine` exists. Every test
   script references that path, so they break until this lands.
3. **`extension/src/`** — `EngineClient.resolveEnginePath` (4 candidate paths), the `viewType`
   constant, 4 command registrations, the error string at `engineClient.ts:40`.
4. **`extension/package.json`** — `name`, `publisher`, `viewType`, 4 command ids, plus the
   `configuration` block.
5. **`extension/media/canvas.js`** — the `macforms-control` drag payload and 2 user-facing
   strings. Must match the host's listener or drag-and-drop silently stops working; this is the
   one rename with no compile-time safety net.
6. **Tests** — `test/suite.js` (12 command ids, both engine paths), `verify*.sh` (7 engine paths
   and prose), `e2e.js`, `run-all.sh`.
7. **Scripts + CI** — `publish-engine.js`, `package-all.js`, `run-windows-layout.sh`,
   `.github/workflows/ci.yml` (2 binary paths, 2 `.vsix` names, 1 artifact name).
8. **`package-lock.json`** — root `name`. Or run `npm install` to regenerate.
9. **Prose** — the 10 documents, reviewed by hand.

## 4. Also worth fixing while the file is open

Two defects found while surveying, both one-liners, both in files this rename touches anyway:

- **`engineClient.ts:125` reads a setting that is never declared.** It calls
  `getConfiguration('macforms').get('enginePath')`, but `package.json` has no `contributes.configuration`
  block at all. The override is undocumented and undiscoverable, and an undeclared setting cannot
  be unset or reset from the Settings UI. Adding the block is part of the rename — the namespace
  must be right the first time or we do it twice.
- **`test/suite.js` contains `macforms.macforms`**, an assertion against the extension id.
  Correct today; it becomes the assertion that catches an incomplete rename.

## 5. Acceptance

Every one of these must hold, and `test/run-all.sh` is the gate — not a grep.

1. `./test/run-all.sh` is **ALL GREEN**, including the integration tier (needs a display).
2. `git grep -i macforms` returns **nothing** outside `example/`, `docs/adr/0001`–`0005` (written
   before the rename), and `CHANGELOG.md`'s history section. Historical records are not rewritten.
3. `dotnet build engine -c Release` produces `vscforms-engine` and **no** `macforms-engine`
   remains under `engine/bin/`.
4. `scripts/package-all.js` produces `dist/vscforms-<triple>.vsix`.
5. The `layout` CI job still resolves the engine path (it hardcodes the Release path).
6. Drag-and-drop from the palette still adds a control — this is assertion 5 from §3, and the
   only step with no automated safety net beyond the canvas harness.
7. `MacForms` appears in no user-visible string: command titles, the Coverage Banner, the
   Refusal notice, the error at `engineClient.ts:40`.

## 6. Open decisions

1. **`publisher` becomes `gOps132`** (recommended), giving extension id `gOps132.vscforms`. It
   matches the GitHub owner and the remote, so the marketplace listing and the repo URL agree.
   Alternative: keep a neutral publisher, which decouples the two but means the listing shows
   an owner that is not you.
2. **`displayName` becomes `VSCForms`** (recommended). Alternative: `WinForms Designer
   (cross-platform)` — accurate, and it is what the current listing shows. Preferring `VSCForms`
   means the name matches what people will type to find it.
3. **C# root namespace `VSCForms.Engine`** (recommended). All-caps namespaces are legal and
   conventional for acronyms; `VscForms.Engine` is the .NET naming-guideline form. Cosmetic, but
   it is the one thing that would need renaming twice if chosen wrong.
4. **Repo directory renamed** to `VSCForms` on disk (recommended, purely cosmetic).
   `opencode` sessions are keyed to the working directory, so this detaches the session —
   trivially recoverable with `session_move`.
5. **`.sln`/`.csproj` inside `example/`** stay as upstream named (already decided in
   `spec-phase-2.md` §5; restated so it is not relitigated).
6. **Prose in `docs/adr/0001`–`0005` is left as written** (recommended). An ADR records a
   decision at a point in time; editing its prose to match a later rename falsifies it. ADR 0006
   and 0007 postdate nothing relevant, so they are fair game.