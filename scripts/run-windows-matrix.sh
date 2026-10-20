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
# RUNS ON: windows-latest CI only. Never in test/run-all.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

ARG="${1:-matrix}"
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vscforms-matrix"
if [ -n "${RUNNER_TEMP:-}" ] && command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -u "$RUNNER_TEMP")/vscforms-matrix"
fi
ENGINE_WORK="$WORK"

# --- engine discovery -------------------------------------------------------
# Same discovery as run-windows-layout.sh, and for the same reason: a missing engine
# must FAIL LOUDLY. A silent skip here is indistinguishable from having verified
# everything, which is the failure mode the layout job's canary step exists to catch.
ENGINE_DLL=""
for dll in vscforms-engine.dll; do
  for p in \
    "./engine/bin/Release/net10.0/win-x64/publish/$dll" \
    "./engine/bin/Release/net10.0/win-x64/$dll" \
    "./engine/bin/Release/net10.0/$dll" \
    "./engine/bin/Debug/net10.0/$dll"; do
    [ -f "$p" ] && ENGINE_DLL="$p"
  done
done
if [ -z "$ENGINE_DLL" ]; then
  echo "ERROR engine not built. Run: dotnet publish engine -c Release -r win-x64 --self-contained true" >&2
  exit 1
fi
ENGINE=(dotnet "$ENGINE_DLL")

command -v dotnet >/dev/null || { echo "ERROR dotnet not on PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR python3 not on PATH" >&2; exit 1; }

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
  *) echo "ERROR the matrix runtime tier needs Windows (this is $(uname -s))" >&2; exit 1 ;;
esac

rm -rf "$WORK" && mkdir -p "$WORK/src"

# --- generate the matrix -----------------------------------------------------
echo "generating the differential matrix…"
python3 scripts/gen-differential-matrix.py --out "$WORK/matrix" --families control

# --- parse every case with the engine ---------------------------------------
# The schema is what the canvas would show, and what the runtime is compared against.
echo "parsing every matrix case with the engine…"
python3 - "$WORK" "$ENGINE_WORK" "$ENGINE_DLL" <<'PYEOF'
import json, os, subprocess, sys

work, engine_work, engine_dll = sys.argv[1], sys.argv[2], sys.argv[3]
matrix = json.load(open(os.path.join(work, "matrix", "matrix.json")))

cases = []
for case in matrix["cases"]:
    path = os.path.join(work, "matrix", case["file"])
    req = json.dumps({"id": 1, "cmd": "parse", "path": path.replace("/", os.sep)})
    proc = subprocess.run(
        ["dotnet", engine_dll], input=req + "\n",
        capture_output=True, text=True,
    )
    try:
        res = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        print(f"  ERROR the engine did not answer for {case['id']}")
        print(proc.stderr[:2000])
        sys.exit(1)
    if not res.get("ok"):
        print(f"  ERROR the engine refused {case['id']}: {res.get('error')}")
        sys.exit(1)
    schema_path = os.path.join(work, "schemas", case["id"] + ".json")
    os.makedirs(os.path.dirname(schema_path), exist_ok=True)
    with open(schema_path, "w", encoding="utf-8") as fh:
        json.dump(res, fh)
    cases.append({
        "id": case["id"],
        "namespace": case["namespace"],
        "className": case["className"],
        "schema": schema_path.replace("/", os.sep),
        "file": os.path.join(work, "matrix", case["file"]),
    })

with open(os.path.join(work, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump({"cases": cases}, fh, indent=1)
print(f"  parsed {len(cases)} case(s)")
PYEOF

# --- one assembly for the whole matrix ---------------------------------------
echo "assembling the matrix into one project…"
python3 - "$WORK" <<'PYEOF'
import json, os, shutil, sys

work = sys.argv[1]
manifest = json.load(open(os.path.join(work, "manifest.json")))
src = os.path.join(work, "src")
os.makedirs(src, exist_ok=True)

shim = []
for case in manifest["cases"]:
    dest = os.path.join(src, os.path.basename(case["file"]))
    shutil.copy(case["file"], dest)
    shim.append(
        f"namespace {case['namespace']} {{ public partial class {case['className']} "
        f": System.Windows.Forms.Form {{ public {case['className']}() "
        f"{{ InitializeComponent(); }} }} }}"
    )

# The single-form mode of the harness calls this factory. The matrix mode uses
# reflection instead, but the type must still exist for the harness to compile.
shim.append(
    "static class VscformsLayoutHost { public static System.Windows.Forms.Form "
    "CreateForm() => throw new System.NotSupportedException(\"matrix mode\"); }"
)
with open(os.path.join(src, "Shim.cs"), "w", encoding="utf-8") as fh:
    fh.write("\n".join(shim) + "\n")

with open(os.path.join(src, "Matrix.csproj"), "w", encoding="utf-8") as fh:
    fh.write(
        '<Project Sdk="Microsoft.NET.Sdk">\n'
        "  <PropertyGroup>\n"
        "    <TargetFramework>net10.0-windows</TargetFramework>\n"
        "    <UseWindowsForms>true</UseWindowsForms>\n"
        "    <OutputType>WinExe</OutputType>\n"
        "    <EnableWindowsTargeting>true</EnableWindowsTargeting>\n"
        "    <Nullable>disable</Nullable>\n"
        "    <ImplicitUsings>enable</ImplicitUsings>\n"
        "    <StartupObject>Program</StartupObject>\n"
        "  </PropertyGroup>\n"
        "</Project>\n"
    )
print(f"  staged {len(manifest['cases'])} form(s)")
PYEOF

cp verify/windows-layout/Program.cs "$WORK/src/Program.cs"

echo "building the matrix assembly…"
dotnet build "$WORK/src/Matrix.csproj" -c Release -v q --nologo

echo "running the matrix against the real WinForms runtime…"
set +e
"$WORK/src/bin/Release/net10.0-windows/Matrix.exe" --matrix "$ENGINE_WORK/manifest.json"
RESULT=$?
set -e

if [ $RESULT -ne 0 ]; then
  echo "MATRIX DIVERGENCE (exit $RESULT) — the generated output disagrees with the runtime."
  echo "Each divergence is a real semantic difference: VSCForms' schema says one thing,"
  echo "the WinForms runtime does another. The reproduction is the matrix case above."
  exit $RESULT
fi
echo "matrix runtime verification passed"
