# Platform-targeted self-contained binaries, no runtime acquisition

The extension ships one self-contained .NET binary per platform inside platform-specific
`.vsix` packages, and does not depend on `ms-dotnettools.vscode-dotnet-runtime`.

## Context

The engine is a Roslyn-based console app, so it is genuinely cross-platform and needs no
Windows Desktop runtime. The question is how the runtime reaches the user's machine.

Measured on .NET SDK 10.0.400 with `Microsoft.CodeAnalysis.CSharp` 5.9.0:

| Approach | Bytes a user downloads |
|---|---|
| Universal `.vsix`, 5 self-contained binaries | 175.7 MB |
| Platform-targeted `.vsix`, one binary each | ~34 MB |

`vsce package --target` is first-class and uses VS Code triples rather than .NET RIDs
(`osx-arm64` becomes `darwin-arm64`). Total bytes published to the CDN are roughly a wash
(175.7 MB vs ~176 MB); the win is entirely in what each user downloads.

## Decision

Publish platform-targeted packages. Users install one ~34 MB `.vsix` containing exactly one
binary, with no runtime prerequisite and no install step.

Three consequences that are easy to get wrong:

- **We prune the target tree ourselves.** `vsce`'s `--ignore-other-target-folders` flag is
  documented but has no implementation in vsce 4.0.0; an A/B test produced byte-identical
  archives each containing all six RID folders. Each build stage must contain only its own
  binary.
- **We do not use `ms-dotnettools.vscode-dotnet-runtime`.** Its README calls the API private, and
  `DotnetInstallMode` has no `windowsdesktop` value — the exact runtime this tool's domain needs.
  It also costs a ~200 MB first-run download, which is worse than shipping 34 MB.
- **We do not package from Windows.** vsce loses the POSIX executable bit when packaging from
  Windows, so the `win32` legs of any build matrix must be built on a Linux runner or
  `chmod +x` at activation.

## Consequences

The price is a CI build matrix and per-target versioning discipline, in exchange for a 5×
reduction in what each user downloads. Framework-dependent publish would cut the binary to
~17 MB but would require a runtime users do not have — only .NET 10 is installed on a typical
dev machine, and the spec's original `net8.0` target has no runtime present at all.