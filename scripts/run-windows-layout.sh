#!/usr/bin/env bash
# Verifies VSCForms' Form Schema against the real WinForms runtime.
#
# WHY THIS EXISTS
#   Every other tier proves the generated C# is valid: it parses, it compiles, the diff is
#   minimal, refused forms are untouched. None of them can tell you that
#   `Location = new Point(500, 250)` actually moved the control — only WinForms itself
#   knows. This harness asks WinForms.
#
# WHY IT NEEDS WINDOWS
#   Instantiating System.Windows.Forms requires the Windows Desktop runtime. Design-time
#   rendering calls the real control's OnPaint on a real HWND, which is why this cannot be
#   done in the webview either (see docs/adr/0006-serializer-not-renderer.md).
#
# RUNS ON: windows-latest CI only. Never in test/run-all.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${1:-example}"

# The engine must be published (self-contained) before this runs. The script checks the
# publish output directory first (win-x64 RID on Windows CI), then falls back to the
# framework-dependent build paths. Loud error on purpose: a missing engine used to
# print SKIP and exit 0, which in CI is indistinguishable from having verified everything.
ENGINE_DLL=""
# 1) Self-contained publish output (what CI layout job does) - includes publish/ subdir
for dll in vscforms-engine.dll; do
  p="./engine/bin/Release/net10.0/win-x64/publish/$dll"
  [ -f "$p" ] && ENGINE_DLL="$p"
done
# 2) Self-contained publish output (no publish/ subdir, legacy)
for dll in vscforms-engine.dll; do
  p="./engine/bin/Release/net10.0/win-x64/$dll"
  [ -f "$p" ] && ENGINE_DLL="$p"
done
# 3) Framework-dependent build output (local dev)
for cfg in Release Debug; do
  for dll in vscforms-engine.dll; do
    p="./engine/bin/$cfg/net10.0/$dll"
    [ -f "$p" ] && ENGINE_DLL="$p"
  done
done
if [ -z "$ENGINE_DLL" ]; then
  echo "ERROR engine not built. Run: dotnet publish engine -c Release -r win-x64 --self-contained true" >&2
  exit 1
fi

# Use 'dotnet <dll>' everywhere - works for self-contained and framework-dependent,
# and is reliable on Windows (self-contained .exe can be finicky).
# Array for proper argument handling in bash
ENGINE=(dotnet "$ENGINE_DLL")

# Determine temp directory: on Windows (Git Bash), use RUNNER_TEMP (Windows path)
# and convert to Unix path for bash operations. The engine runs on Windows and
# accepts Windows paths, but bash mkdir/cp need Unix paths.
if [ -n "${RUNNER_TEMP:-}" ]; then
  # Convert Windows path to Unix path for bash (e.g., D:\a\_temp -> /d/a/_temp)
  WORK="$(cygpath -u "$RUNNER_TEMP")/vscforms-layout"
  # Also keep Windows path for engine invocation
  ENGINE_WORK="$(cygpath -w "$WORK")"
elif [ -n "${TEMP:-}" ] && command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -u "$TEMP")/vscforms-layout"
  ENGINE_WORK="$(cygpath -w "$WORK")"
else
  WORK="${TMPDIR:-/tmp}/vscforms-layout"
  ENGINE_WORK="$WORK"
fi
echo "DEBUG: WORK=$WORK ENGINE_WORK=$ENGINE_WORK"

command -v dotnet >/dev/null || { echo "SKIP  dotnet not on PATH"; exit 0; }

# Windows-only, and cleanly so: instantiating System.Windows.Forms needs the Windows Desktop
# runtime. A developer running this on macOS should see a skip, not a build failure.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
  *) echo "SKIP  layout verification needs Windows (this is $(uname -s))"; exit 0 ;;
esac
if [ ! -d "$PROJECT" ]; then
  echo "ERROR no project at $PROJECT" >&2
  exit 1
fi

rm -rf "$WORK" && mkdir -p "$WORK/src"

# The Designer file is copied VERBATIM. Nothing here may rewrite it — the point is to
# check VSCForms against the file Visual Studio produced, not against a normalised copy.
DESIGNER=$(find "$PROJECT" -maxdepth 2 -name '*.Designer.cs' | head -1)
[ -n "$DESIGNER" ] || { echo "SKIP  no *.Designer.cs under $PROJECT"; exit 0; }
cp "$DESIGNER" "$WORK/src/$(basename "$DESIGNER")"
cp verify/windows-layout/Program.cs "$WORK/src/Program.cs"
echo "using $DESIGNER (verbatim)"

# Derive namespace / form class from the Designer file rather than assuming them.
NS=$(grep -m1 -oE '^namespace [A-Za-z0-9_.]+' "$WORK/src/$(basename "$DESIGNER")" | awk '{print $2}')
CLASS=$(grep -m1 -oE 'partial class [A-Za-z0-9_]+' "$WORK/src/$(basename "$DESIGNER")" | awk '{print $3}')
echo "namespace=$NS class=$CLASS"

cat > "$WORK/src/Shim.cs" <<EOF
// Generated host for the copied Designer file.
//
// The Designer file's half of the partial declares no base class and no
// constructor (those live in the hand-written Form1.cs, which is deliberately
// NOT copied — the point is to check VSCForms against the file Visual Studio
// produced). This half supplies both, in the file's own namespace so the two
// halves merge: a global-namespace shim is a different class and the build
// fails with CS0115. Same pattern as test/verify.sh's compile gate.
//
// The factory keeps verify/windows-layout/Program.cs form-agnostic: that file
// is static C# and never mentions NS/CLASS.
EOF
if [ -n "$NS" ]; then
  cat >> "$WORK/src/Shim.cs" <<EOF
namespace $NS
{
    public partial class $CLASS : System.Windows.Forms.Form
    {
        public $CLASS() { InitializeComponent(); }
    }
}
static class VscformsLayoutHost
{
    public static System.Windows.Forms.Form CreateForm() => new $NS.$CLASS();
}
EOF
else
  cat >> "$WORK/src/Shim.cs" <<EOF
public partial class $CLASS : System.Windows.Forms.Form
{
    public $CLASS() { InitializeComponent(); }
}
static class VscformsLayoutHost
{
    public static System.Windows.Forms.Form CreateForm() => new $CLASS();
}
EOF
fi

# net10.0-windows so the harness runs on the CI runner's installed SDK regardless of the
# project's own TFM. We deliberately do NOT modify the project under test.
cat > "$WORK/src/Check.csproj" <<'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <OutputType>WinExe</OutputType>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <Nullable>disable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <StartupObject>Program</StartupObject>
  </PropertyGroup>
</Project>
EOF

echo "parsing the Designer file with the VSCForms engine…"
DESIGNER_OUT="$WORK/schema.json"
# Capture engine stderr to a temp file for debugging
ENGINE_ERR="$WORK/engine.err"
# Pass Windows-style path to the engine (it runs on Windows).
# Use Python script file to avoid bash variable expansion issues with backslashes.
python3 -c "
import json, sys
path = sys.argv[1]
print(json.dumps({'id': 1, 'cmd': 'parse', 'path': path}))
" "$ENGINE_WORK/src/$(basename "$DESIGNER")" \
  | "${ENGINE[@]}" 2>"$ENGINE_ERR" > "$DESIGNER_OUT"
ENGINE_EXIT=$?
echo "DEBUG: ENGINE_EXIT=$ENGINE_EXIT"
if [ $ENGINE_EXIT -ne 0 ]; then
  echo "ENGINE CRASH (exit $ENGINE_EXIT):"
  cat "$ENGINE_ERR" >&2
fi

# Check if DESIGNER_OUT has content
if [ ! -s "$DESIGNER_OUT" ]; then
  echo "DEBUG: DESIGNER_OUT is empty"
  exit 1
fi

if ! python3 -c "
import json,sys
d=json.load(open('$DESIGNER_OUT'))
assert d.get('ok'), d
" 2>/dev/null; then
  echo "DEBUG: Python validation failed"
  cat "$DESIGNER_OUT"
  echo "FAIL  the engine could not parse the file (is the engine built?)"
  echo "Engine output:"
  cat "$DESIGNER_OUT"
  echo "Engine stderr:"
  cat "$ENGINE_ERR"
  exit 1
fi
echo "DEBUG: Parse validation passed"

python3 -c "
import json
d=json.load(open('$DESIGNER_OUT'))['schema']
a=d['analysis']
print(f\"  coverage {a['coveragePercent']}%  modelled {a['modelledCount']}  unmodelled {a['unmodelledCount']}  refuses {a['refuses']}\")
if a['refuses']:
    print('  note: this form refuses; geometry is not editable, so only presence is checked')
"

# Staging stubs for references outside the copied file (handlers in Form1.cs,
# third-party control types). The Designer copy stays verbatim; Stubs.cs supplies
# the missing halves the way Shim.cs supplies the Form base. Needs the schema,
# so this runs after parsing and before building. Anything unshaped is left out
# so the build fails loudly instead of testing a guess.
python3 scripts/gen-layout-stubs.py \
  "$WORK/src/$(basename "$DESIGNER")" "$DESIGNER_OUT" "$NS" "$CLASS" \
  "$WORK/src/Stubs.cs"

echo "building harness…"
dotnet build "$WORK/src/Check.csproj" -c Release -v q --nologo

echo "running the runtime comparison…"
set +e
# Check.exe is a Windows executable, needs Windows path.
# Pass as raw argument - Check.exe reads it directly, not as JSON.
"$ENGINE_WORK/src/bin/Release/net10.0-windows/Check.exe" "$ENGINE_WORK/schema.json"
RESULT=$?
set -e

if [ $RESULT -ne 0 ]; then
  echo "layout verification FAILED (exit $RESULT)"
  exit $RESULT
fi
echo "layout verification passed"