# The generator delegates to the SDK; it does not own the template

`vscforms new` creates projects by shelling out to `dotnet new`, not by emitting files from a
copy we maintain.

## Context

The requirement was a project "identical to one done in Visual Studio". Two ways to get there:

- **Hand-written templates.** We own the bytes. We must stay in sync as the SDK moves, and
  every divergence is invisible until someone notices.
- **Delegate to `dotnet new`.** Output is identical by construction.

The SDK ships the WinForms templates itself (`winforms`, `winformslib`,
`winformscontrollib`), so there is nothing to gain from copying them.

## Decision

Shell out. The `dotnet` prerequisite is already true for anyone building WinForms, and the
three traps below are handled explicitly rather than by maintaining our own file contents.

## Traps this exists to avoid

1. **`dotnet new sln` defaults to `.slnx` in SDK 10.** It emits a 23-byte XML file:
   `<Solution>\n</Solution>`. Visual Studio 17.0–17.9 cannot open `.slnx` at all — support
   requires 17.13+ for MSBuild and 17.14 for general availability. `dotnet new sln migrate` is
   **one-way**. `--format sln` is mandatory, and nothing local would catch the mistake because
   the file exists and looks like a solution.
2. **`dotnet new winforms` fails its implicit restore on macOS/Linux** with `NETSDK1100`, and
   the post-action has `continueOnError`, so creation **reports success and exits 0** while
   leaving a project that cannot restore. `--no-restore` avoids it, and
   `<EnableWindowsTargeting>true</EnableWindowsTargeting>` is injected afterwards.
3. **A `.sln` without `.Build.0` entries builds nothing and exits 0.** The
   `ProjectConfigurationPlatforms` section maps each configuration to a project *and* carries
   the participation flags; MSBuild's `.sln` metaproject only schedules projects with
   `.Build.0`. An `ActiveCfg` without it resolves to `build=false`. There is no error and no
   warning — just a green build and no output. `dotnet sln add` writes the matrix, and the
   script asserts it rather than trusting it.

## Consequences

- Generated solutions are **not byte-reproducible**: the project GUID inside a classic `.sln`
  is random per creation. Tests assert structure, never bytes.
- `<EnableWindowsTargeting>` is injected only on non-Windows hosts, so a project generated on
  Windows stays byte-identical to the template.
- The script builds the result and reports failure, so a broken generator is caught at the
  point of use rather than later.