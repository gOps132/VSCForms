#!/usr/bin/env bash
# The differential oracle's RUNTIME half: the generated permutation matrix, checked
# against the real WinForms runtime.
#
# WHY THIS EXISTS
#   The cross-platform matrix tier (test/verify-differential-matrix.sh) proves the
#   engine's patches are SURGICALLY correct and COMPILE. It cannot prove they are
#   SEMANTICALLY correct: only WinForms itself knows what a `Location = new Point(500,
#   250)` actually did. This script asks WinForms.
#
# WHY ONE BUILD FOR THE WHOLE MATRIX
#   The layout tier builds a project per fixture — 18 builds for 18 hand-authored
#   fixtures. The matrix has hundreds of cases, and a build each would take longer
#   than the rest of CI. So every matrix form goes into ONE assembly, and the harness
#   instantiates each by reflection.
#
# WHY IT NEEDS ONLY dotnet AND bash
#   The matrix can be generated ANYWHERE, and the guest that runs this may have
#   neither python3 nor jq — the UTM Windows guest has neither, and cannot install
#   python3 (the MSI fails under x64 emulation on ARM64). So:
#
#     * the generator writes `cases.txt`, a plain `id|namespace|className|file` index,
#       and this script reads THAT with `read` — no JSON parser needed;
#     * the parse loop and the manifest are built with plain shell;
#     * every path is written with FORWARD SLASHES, which .NET accepts on Windows, so
#       no JSON string ever has to escape a backslash.
#
#   Point VSCFORMS_MATRIX_DIR at a pre-generated matrix and the script needs nothing
#   but dotnet and bash. That is what makes it runnable in a guest whose toolchain we
#   do not control.
#
# RUNS ON: windows-latest CI, and on a UTM Windows guest. Never in test/run-all.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

# --- the RID ------------------------------------------------------------------
# The RID decides which engine build can actually be LOADED, and the only authority on
# that is the runtime itself: `dotnet --info` reports the RID of the runtime that will
# load the engine, and the engine's hostpolicy.dll must match it.
#
# `uname -m` is NOT that authority, and using it was a real bug. On the UTM guest
# (Windows 11 ARM64) the Git Bash shell runs under x64 emulation, so uname says x86_64
# and the engine was published for win-x64 — and the guest's ARM64 dotnet then refused
# it with "Failed to load hostpolicy.dll ... Ensure the library matches the current
# process architecture: arm64".
#
# So: ask dotnet. Fall back to uname only if dotnet cannot say.
command -v dotnet >/dev/null || { echo "ERROR dotnet not on PATH" >&2; exit 1; }
RID=$(dotnet --info 2>/dev/null | sed -n 's/^[[:space:]]*RID:[[:space:]]*//p' | head -1)
if [ -z "$RID" ]; then
  case "$(uname -m)" in
    aarch64|arm64) RID="win-arm64" ;;
    *)             RID="win-x64" ;;
  esac
  echo "dotnet did not report a RID; falling back to the architecture"
fi
export VSCFORMS_MATRIX_RID="$RID"
echo "dotnet RID: $RID  (uname says $(uname -m))"

# --- engine discovery -------------------------------------------------------
# Same discovery as run-windows-layout.sh, and for the same reason: a missing engine
# must FAIL LOUDLY. A silent skip here is indistinguishable from having verified
# everything, which is the failure mode the layout job's canary step exists to catch.
ENGINE_DLL=""
for dll in vscforms-engine.dll; do
  for p in \
    "./engine/bin/Release/net10.0/$RID/publish/$dll" \
    "./engine/bin/Release/net10.0/$RID/$dll" \
    "./engine/bin/Release/net10.0/$dll" \
    "./engine/bin/Debug/net10.0/$dll"; do
    [ -f "$p" ] && ENGINE_DLL="$p"
  done
done
if [ -z "$ENGINE_DLL" ]; then
  echo "ERROR engine not built for $RID. Run:" >&2
  echo "  dotnet publish engine -c Release -r $RID --self-contained true" >&2
  exit 1
fi
ENGINE=(dotnet "$ENGINE_DLL")

command -v dotnet >/dev/null || { echo "ERROR dotnet not on PATH" >&2; exit 1; }

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
  *) echo "ERROR the matrix runtime tier needs Windows (this is $(uname -s))" >&2; exit 1 ;;
esac

require() { # $1 = what, $2 = the path that must exist
  if [ ! -e "$2" ]; then
    echo "ERROR $1 is missing: $2" >&2
    echo "  the matrix tier did not run. This must never look like a pass." >&2
    exit 1
  fi
}

WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vscforms-matrix"
if [ -n "${RUNNER_TEMP:-}" ] && command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -u "$RUNNER_TEMP")/vscforms-matrix"
fi
ENGINE_WORK="$WORK"

rm -rf "$WORK" && mkdir -p "$WORK/src" "$WORK/schemas"

# --- the matrix --------------------------------------------------------------
# Either a pre-generated one (VSCFORMS_MATRIX_DIR) or one generated here.
MATRIX_DIR="${VSCFORMS_MATRIX_DIR:-}"
if [ -n "$MATRIX_DIR" ]; then
  echo "using the pre-generated matrix at $MATRIX_DIR"
  require "the matrix index" "$MATRIX_DIR/cases.txt"
  MATRIX_DIR="$(cd "$MATRIX_DIR" && pwd)"
else
  echo "generating the differential matrix…"
  command -v python3 >/dev/null || {
    echo "ERROR python3 not on PATH." >&2
    echo "  Generate the matrix elsewhere and point VSCFORMS_MATRIX_DIR at it." >&2
    exit 1; }
  python3 scripts/gen-differential-matrix.py --out "$WORK/matrix" --families control
  MATRIX_DIR="$WORK/matrix"
fi
require "the matrix index" "$MATRIX_DIR/cases.txt"

# --- parse every case with the engine ---------------------------------------
# The schema is what the canvas would show, and what the runtime is compared against.
echo "parsing every matrix case with the engine…"
MANIFEST="$WORK/manifest.json"
# A path the ENGINE can open. The shell's paths are Git Bash POSIX paths
# (/c/Users/...), which .NET on Windows cannot resolve — it needs C:/Users/...
# `cygpath -m` does that conversion, and it produces FORWARD SLASHES, so no JSON
# string ever has to escape a backslash.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1" 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}
{
  printf '{"cases":['
  first=1
  while IFS='|' read -r id ns cls rel; do
    [ -n "$id" ] || continue
    src="$MATRIX_DIR/$rel"
    schema="$WORK/schemas/$id.json"
    if ! printf '{"id":1,"cmd":"parse","path":"%s"}\n' "$(winpath "$src")" \
         | "${ENGINE[@]}" > "$schema" 2>/dev/null; then
      echo "  ERROR the engine failed on $id" >&2
      exit 1
    fi
    if ! grep -q '"ok":true' "$schema"; then
      echo "  ERROR the engine refused $id: $(head -c 300 "$schema")" >&2
      exit 1
    fi
    if [ $first -eq 1 ]; then first=0; else printf ','; fi
    printf '{"id":"%s","namespace":"%s","className":"%s","schema":"%s"}' \
      "$id" "$ns" "$cls" "$(winpath "$schema")"
  done < "$MATRIX_DIR/cases.txt"
  printf ']}\n'
} > "$MANIFEST"

CASES=$(grep -o '"id":"' "$MANIFEST" | wc -l | tr -d ' ')
if [ "$CASES" -lt 100 ]; then
  echo "ERROR the matrix has only $CASES case(s) — expected the full permutation matrix" >&2
  exit 1
fi
echo "  parsed $CASES case(s)"

# --- one assembly for the whole matrix ---------------------------------------
echo "assembling the matrix into one project…"
SRC="$WORK/src"
SHIM="$SRC/Shim.cs"
: > "$SHIM"
while IFS='|' read -r id ns cls rel; do
  [ -n "$id" ] || continue
  cp "$MATRIX_DIR/$rel" "$SRC/$(basename "$rel")"
  printf 'namespace %s { public partial class %s : System.Windows.Forms.Form { public %s() { InitializeComponent(); } } }\n' \
    "$ns" "$cls" "$cls" >> "$SHIM"
done < "$MATRIX_DIR/cases.txt"
# The single-form mode of the harness calls this factory. The matrix mode uses
# reflection instead, but the type must still exist for the harness to compile.
printf 'static class VscformsLayoutHost { public static System.Windows.Forms.Form CreateForm() => throw new System.NotSupportedException("matrix mode"); }\n' >> "$SHIM"

cat > "$SRC/Matrix.csproj" <<'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <OutputType>WinExe</OutputType>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <!-- `annotations`, not `disable`: the harness uses `string?` in its signatures, and a
         project with nullable annotations DISABLED warns about every one of them
         (CS8632). The build must be warning-free. -->
    <Nullable>annotations</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <StartupObject>Program</StartupObject>
  </PropertyGroup>
</Project>
CSPROJ
cp verify/windows-layout/Program.cs "$SRC/Program.cs"

echo "building the matrix assembly…"
dotnet build "$SRC/Matrix.csproj" -c Release -v q --nologo
require "the built matrix harness" "$SRC/bin/Release/net10.0-windows/Matrix.exe"

# --- the comparison ----------------------------------------------------------
echo "running the matrix against the real WinForms runtime…"
# The rectangles are always written: they are the half of the visual-parity check that
# CAN be automated — does the canvas put each control where, and how big, the runtime
# will put it? The PNGs are opt-in: they are the visual reference for a comparison
# against the Visual Studio designer (which paints the same real controls), and they are
# an artifact rather than an assertion.
RENDER_ARGS=(--render "$WORK/renders")
if [ "${VSCFORMS_MATRIX_RENDER:-0}" = "1" ]; then
  RENDER_ARGS+=(--png)
  echo "  rendering every matrix form to a PNG as well…"
fi
set +e
"$SRC/bin/Release/net10.0-windows/Matrix.exe" --matrix "$MANIFEST" "${RENDER_ARGS[@]}"
RESULT=$?
set -e

if [ $RESULT -ne 0 ]; then
  echo "MATRIX DIVERGENCE (exit $RESULT) — the generated output disagrees with the runtime."
  echo "Each divergence is a real semantic difference: VSCForms' schema says one thing,"
  echo "the WinForms runtime does another. The reproduction is the matrix case above."
  exit $RESULT
fi

# Keep the renders. They are the reference side of the visual-parity check: what the
# WinForms runtime paints, which is what the Visual Studio designer paints too (it hosts
# real controls). The canvas draws a stylised box per control, so the comparison that
# CAN be automated is geometric — and these rectangles are it.
if [ -d "$WORK/renders" ]; then
  mkdir -p out/matrix-renders
  cp -r "$WORK/renders/." out/matrix-renders/ 2>/dev/null || true
  echo "wrote $(ls -1 out/matrix-renders | wc -l | tr -d ' ') render file(s) to out/matrix-renders/"
fi
echo "matrix runtime verification passed"
