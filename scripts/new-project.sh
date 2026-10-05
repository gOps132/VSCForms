#!/usr/bin/env bash
# Creates a WinForms project with a classic .sln, byte-identical to what `dotnet new` emits.
#
# WHY THE CLI DOES THE WORK RATHER THAN A TEMPLATE ENGINE
#   "Identical to Visual Studio" is then true by construction rather than by our diligence:
#   nobody has to keep our templates in sync as the SDK moves. The .NET prerequisite is
#   already true for anyone building WinForms.
#
# THREE TRAPS THIS SCRIPT EXISTS TO AVOID (see docs/adr/0007)
#   1. `dotnet new sln` DEFAULTS TO .slnx in SDK 10 — an XML file that VS 17.0-17.9 cannot
#      open at all. `-f sln` is mandatory.
#   2. `dotnet new winforms` runs an implicit restore that FAILS on macOS/Linux
#      (NETSDK1100) while still exiting 0, so the project looks created but is broken.
#      `--no-restore` avoids it.
#   3. The generated project needs <EnableWindowsTargeting> on non-Windows hosts or it
#      cannot restore or build there.
set -euo pipefail

NAME=""
OUT=""
LANGUAGE="C#"
TEMPLATE="winforms"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
usage: new-project.sh --name <Name> [--out <dir>] [--language C#|VB] [--type <template>]

  --name      project and solution name (required). A valid C# identifier.
  --out       parent directory to create it in (default: current directory)
  --language  C# (default) or VB
  --type      dotnet new template (default: winforms; also: winformslib, winformscontrollib)

Examples:
  ./scripts/new-project.sh --name CustomerForm
  ./scripts/new-project.sh --name Dialog --out ~/src --language C#
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name|-n)     NAME="${2:-}"; shift 2 ;;
    --out|-o)      OUT="${2:-}"; shift 2 ;;
    --language|-l) LANGUAGE="${2:-}"; shift 2 ;;
    --type|-t)     TEMPLATE="${2:-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown argument: $1 (try --help)" ;;
  esac
done

[ -n "$NAME" ] || { usage; exit 2; }
OUT="${OUT:-$PWD}"
command -v dotnet >/dev/null || die "the .NET SDK is required (https://dotnet.microsoft.com/download)"

# A bad identifier produces a project that cannot compile, so fail before writing anything.
if ! printf '%s' "$NAME" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
  die "'$NAME' is not a valid identifier — start with a letter or underscore, no spaces or punctuation"
fi

case "$LANGUAGE" in
  "C#"|C#|csharp) LANG_SHORT="C#"; DOTNET_LANG="C#" ;;
  VB|vb|visualbasic) LANG_SHORT="VB"; DOTNET_LANG="VB" ;;
  *) die "--language must be C# or VB (got '$LANGUAGE')" ;;
esac

command -v dotnet >/dev/null
# The short name is a COLUMN in `dotnet new list`, not at line start, and it is padded with
# spaces, so match it as a whole word anywhere on the line.
if ! dotnet new list 2>/dev/null | awk -v t="$TEMPLATE" \
     '$0 ~ ("(^|[^[:alnum:]._-])" t "([[:space:]]|$)") { found=1 } END { exit !found }'; then
  die "the '$TEMPLATE' template is not available in this SDK ($(dotnet --version))"
fi

if [ -e "$OUT/$NAME" ]; then
  die "'$OUT/$NAME' already exists"
fi

mkdir -p "$OUT"

echo "==> creating $NAME ($LANGUAGE, $TEMPLATE) in $OUT"

# --no-restore: the template's post-action restore fails on non-Windows with NETSDK1100
# but still exits 0, producing a project that reports success and cannot build.
dotnet new "$TEMPLATE" \
  --name "$NAME" \
  --output "$OUT/$NAME" \
  --language "$DOTNET_LANG" \
  --no-restore >/dev/null

# Trap 1: -f sln is required. The SDK 10 default is .slnx, which VS 17.0-17.9 cannot open.
dotnet new sln --name "$NAME" --format sln --output "$OUT" >/dev/null

SLN="$OUT/$NAME.sln"
[ -f "$SLN" ] || die "expected a .sln at $SLN but none was produced"

# `dotnet sln add` writes the ProjectConfigurationPlatforms matrix (Any CPU/x64/x86 across
# Debug/Release). Without those .Build.0 entries a solution builds NOTHING and exits 0 — a
# silent no-op with no error surface, so we let the CLI do it.
PROJ="$OUT/$NAME/$NAME.csproj"
[ -f "$PROJ" ] || PROJ="$OUT/$NAME/$NAME.vbproj"
[ -f "$PROJ" ] || die "no project file found under $OUT/$NAME"

dotnet sln "$SLN" add "$PROJ" >/dev/null

# Trap 3: without this the project cannot restore or build on macOS/Linux.
if [ "$(uname -s)" != "MINGW"* ] && [ "$(uname -s)" != "CYGWIN"* ]; then
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) ;;
  esac
  if [ "$(uname -s)" = "Darwin" ] || [ "$(uname -s)" = "Linux" ]; then
    python3 - "$PROJ" <<'PY'
import re, sys

path = sys.argv[1]
# newline='' disables universal-newline translation. Without it, reading CRLF yields '\n'
# and writing emits os.linesep — silently rewriting the whole file's line endings, which is
# exactly the churn this injection is supposed to avoid.
with open(path, encoding='utf-8-sig', newline='') as f:
    text = f.read()

if 'EnableWindowsTargeting' in text:
    sys.exit(0)

# Insert after <OutputType> so the property order reads naturally; else after
# <TargetFramework>; else at the end of the first PropertyGroup.
def after(pattern, text):
    m = re.search(pattern, text, re.M)
    return m.end() if m else None

ins = after(r'^[ \t]*<OutputType>.*?</OutputType>[ \t]*\r?\n', text) \
   or after(r'^[ \t]*<TargetFramework>.*?</TargetFramework>[ \t]*\r?\n', text)

eol = '\r\n' if '\r\n' in text else '\n'
prop = '    <EnableWindowsTargeting>true</EnableWindowsTargeting>'

if ins is None:
    m = re.search(r'([ \t]*)</PropertyGroup>', text)
    if not m:
        sys.exit('could not locate a PropertyGroup to edit')
    text = text[:m.start()] + m.group(1) + prop + eol + text[m.start():]
else:
    text = text[:ins] + prop + eol + text[ins:]

with open(path, 'w', encoding='utf-8-sig', newline='') as f:
    f.write(text)
PY
    echo "    added <EnableWindowsTargeting> (required to build on this host)"
  fi
fi

# Verify the solution is not decorative. A .sln whose projects lack .Build.0 entries builds
# nothing and still exits 0, so we assert the matrix is present rather than trusting it.
if ! grep -q "Build.0" "$SLN"; then
  die "the generated .sln has no Build.0 entries — it would build nothing and still exit 0"
fi

echo "==> verifying"
BUILD_LOG="$(mktemp)"
if (cd "$OUT/$NAME" && dotnet build -v q --nologo >"$BUILD_LOG" 2>&1); then
  echo "    project builds"
elif grep -q "NETSDK1100" "$BUILD_LOG"; then
  echo "    note: could not build here (NETSDK1100) — the csproj should have"
  echo "          EnableWindowsTargeting; report this as a bug."
else
  echo "    WARNING: build failed:"
  grep -E "error" "$BUILD_LOG" | head -5 | sed 's/^/      /'
fi
rm -f "$BUILD_LOG"

cat <<EOF

Created:
  $SLN
  $OUT/$NAME/

Next:
  code "$OUT/$NAME/$NAME.sln"
EOF