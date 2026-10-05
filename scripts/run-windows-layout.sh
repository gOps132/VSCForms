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
WORK="${TMPDIR:-/tmp}/vscforms-layout"
ENGINE=./engine/bin/Debug/net10.0/vscforms-engine

command -v dotnet >/dev/null || { echo "SKIP  dotnet not on PATH"; exit 0; }

# Windows-only, and cleanly so: instantiating System.Windows.Forms needs the Windows Desktop
# runtime. A developer running this on macOS should see a skip, not a build failure.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
  *) echo "SKIP  layout verification needs Windows (this is $(uname -s))"; exit 0 ;;
esac
if [ ! -d "$PROJECT" ]; then echo "SKIP  no project at $PROJECT"; exit 0; fi

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
// Minimal host for the copied Designer file. Mirrors what test/verify.sh does locally.
public partial class $CLASS : System.Windows.Forms.Form
{
    public $CLASS() { InitializeComponent(); }
}
EOF

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

echo "building harness…"
dotnet build "$WORK/src/Check.csproj" -c Release -v q --nologo

echo "parsing the Designer file with the VSCForms engine…"
DESIGNER_OUT="$WORK/schema.json"
printf '{"id":1,"cmd":"parse","path":"%s"}\n' "$WORK/src/$(basename "$DESIGNER")" \
  | "$ENGINE" 2>/dev/null > "$DESIGNER_OUT"

if ! python3 -c "
import json,sys
d=json.load(open('$DESIGNER_OUT'))
assert d.get('ok'), d
" 2>/dev/null; then
  echo "FAIL  the engine could not parse the file (is the engine built?)"
  exit 1
fi

python3 -c "
import json
d=json.load(open('$DESIGNER_OUT'))['schema']
a=d['analysis']
print(f\"  coverage {a['coveragePercent']}%  modelled {a['modelledCount']}  unmodelled {a['unmodelledCount']}  refuses {a['refuses']}\")
if a['refuses']:
    print('  note: this form refuses; geometry is not editable, so only presence is checked')
"

echo "running the runtime comparison…"
set +e
"$WORK/src/bin/Release/net10.0-windows/Check.exe" "$DESIGNER_OUT"
RESULT=$?
set -e

if [ $RESULT -ne 0 ]; then
  echo "layout verification FAILED (exit $RESULT)"
  exit $RESULT
fi
echo "layout verification passed"