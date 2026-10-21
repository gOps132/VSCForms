# Running the differential oracle in a UTM Windows guest

The **runtime half** of the Headless Differential Oracle (`docs/agents/workflow.md` §3) runs
on `windows-latest` CI. It also runs in a local UTM Windows VM, and the two agree exactly.

This is the procedure, with the traps that cost the most time.

## The short version

```bash
# 1. the guest has to be running and the macOS session UNLOCKED (see trap 1)
scripts/utm-guest.sh ip

# 2. generate the matrix ON THE HOST, and push it as one tarball
python3 scripts/gen-differential-matrix.py --out out/matrix --families control
tar -cf out/matrix.tar -C out/matrix cases cases.txt
utmctl file push <vm> 'C:\Users\Public\matrix.tar' < out/matrix.tar

# 3. run the matrix in the guest
scripts/utm-guest.sh run-bash <script.sh>
```

The guest needs only **`dotnet` and `bash`** to run the matrix. It does not need python, git
or jq — see "the guest's toolchain" below.

## The result

```
matrix: 438 form(s), 876 control(s) checked, 0 case(s) with failures, 0 failure(s) total
PASS — every matrix form matches the real runtime
wrote 438 render file(s) to out/matrix-renders/
```

And the renders are **byte-identical** to the ones `windows-latest` produces: the same 438
JSON files, compared field by field, with zero differences. An x64 CI runner and an ARM64
Windows guest on Apple Silicon, two different .NET builds, the same answer — which is what
makes a no-tolerance geometry comparison safe to run in both places.

## The traps

### 1. A locked macOS session kills the guest AND the tooling

Two separate failures, one cause.

- **Apple Events stop working entirely.** `osascript` against *any* app times out, not just
  UTM. The whole `mcp-utm` tool set dies with it, because every one of its tools is an
  AppleScript call. A pending TCC prompt ("cmux wants access to control Finder") can cause
  this too, and the prompt is invisible on a locked screen.
- **The guest wedges mid-boot.** The first boot reached "Getting devices ready" and then
  stopped: QEMU at 257% CPU with the guest disk untouched for 21 minutes, starting exactly
  when the screen locked. The SPICE display client disconnecting mid-frame hangs the guest.

So: unlock the screen before touching the VM, and keep it unlocked while it runs. If the
guest wedges, `kill -TERM` the QEMU process — the qcow2 is fine, and it reboots.

### 2. The guest's toolchain is not the CI's

| tool | in the guest | why it matters |
|---|---|---|
| `dotnet` | **10.0.401, RID `win-arm64`** | the engine must be published for THAT rid |
| `bash` | absent until you install Git for Windows | the matrix script is a shell script |
| `python3` | **cannot be installed** | the matrix tier must not need it |
| `git` | absent | fetch a zip of the repo instead |
| `winget` | absent | install from a direct URL |
| VS Code | absent | the portable zip, not the installer |
| Visual Studio 18 Community | **present**, but no .NET desktop workload | so no WinForms designer |

**The MSI problem.** Both the x64 and the ARM64 Python installers fail with
`0x80070003` (`ERROR_PATH_NOT_FOUND`) — Windows Installer does not work in this guest. That
also breaks the Visual Studio workload add, so **the WinForms designer cannot be installed
here**. The installers that DO work are the non-MSI ones: Git for Windows (NSIS) and the
VS Code portable archive.

**The RID problem.** `uname -m` inside Git Bash reports `x86_64` on the ARM64 guest,
because the shell runs under x64 emulation. So an engine published for `win-x64` is
unloadable by the guest's ARM64 runtime:

```
Failed to load hostpolicy.dll, HRESULT: 0x800700C1
- Ensure the library matches the current process architecture: arm64
```

The only authority on which engine build can be LOADED is the runtime, so ask it:
`dotnet --info` reports the RID. `scripts/run-windows-matrix.sh` now does that, with
`uname -m` as a fallback.

**The path problem.** The shell's paths are Git Bash POSIX paths (`/c/Users/...`), which
.NET on Windows cannot open. `cygpath -m` converts them, and it produces forward slashes,
so no JSON string ever has to escape a backslash.

## The guest's toolchain, in the order that works

1. **Git for Windows** (gives Git Bash):
   `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/Git-2.56.0.2-64-bit.exe`
   → `start /wait Git-2.56.0.2-64-bit.exe /VERYSILENT /NORESTART /NOCANCEL /SP-`
2. **VS Code** (portable, ARM64):
   `https://update.code.visualstudio.com/latest/win32-arm64-archive/stable`
   → the `-archive` suffix is the ZIP. Without it the URL serves a signed `.exe`, and
   `Expand-Archive` fails with "End of Central Directory record could not be found".
3. **The repository**: the repo is public, so the guest can fetch
   `https://github.com/gOps132/VSCForms/archive/refs/heads/main.zip` and unzip it. There is
   no git in the guest and none is needed for the matrix.
4. **The engine**: `dotnet publish engine -c Release -r $(dotnet --info | sed -n 's/^[[:space:]]*RID:[[:space:]]*//p') ...`
   The framework-dependent `vscforms-engine.dll` next to the publish output is what the tier
   actually runs; the single-file `.exe` in `publish/` is broken in this guest.
5. **The matrix**: generated on the host and pushed as one tarball. The tier reads
   `cases.txt` — a plain `id|namespace|className|file` index — so the guest needs no JSON
   parser at all.

## What the guest could NOT do

**The Visual Studio WinForms designer.** VS 18 Community is installed in the guest, but
without the .NET desktop development workload, so the VS tree has
`Microsoft.VisualStudio.DesignTools.*` (the WPF/XAML designer) and **no** WindowsForms
designer assembly. Adding the workload needs the MSI path, which is broken. The
`Microsoft.VisualStudio.Workload.ManagedDesktop` component is therefore unavailable here.

That is the one piece of the VS-parity story this guest cannot deliver, and it is worth
being precise about why: the oracle's runtime half does not need the designer (the runtime
IS the reference), and the designer's *rules* are MIT-readable in `dotnet/winforms`
(`src/System.Windows.Forms.Design/.../Serialization/`). Only the designer's own pixels and
its modern Roslyn code generator need Visual Studio itself.
