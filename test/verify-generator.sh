#!/usr/bin/env bash
# Verifies the project generator, and closes the loop it exists to serve: that VSCForms can
# read a form the generator produced.
#
# The last part is the point. A generator whose output our own tool cannot parse would be a
# worse bug than no generator — it would ship projects that open as an empty form at 100%
# coverage. That exact failure happened once, on `dotnet new winforms` output, and this test
# exists so it cannot happen again.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sect(){ echo; echo "== $1"; }

ENGINE=./engine/bin/Debug/net10.0/vscforms-engine
GEN=./scripts/new-project.sh

command -v dotnet >/dev/null || { echo "SKIP  dotnet not on PATH"; exit 0; }
if ! dotnet new list 2>/dev/null | awk '$0 ~ /(^|[^[:alnum:]._-])winforms([[:space:]]|$)/{f=1} END{exit !f}'; then
  echo "SKIP  the winforms template is not available in this SDK"; exit 0
fi
[ -x "$ENGINE" ] || { echo "SKIP  engine not built"; exit 0; }

WORK=$(mktemp -d)/gen
mkdir -p "$WORK"
trap 'rm -rf "$(dirname "$WORK")"' EXIT

# --------------------------------------------------------------- rejection
sect "generator rejects bad input before writing anything"
"$GEN" --name "9Bad Name" --out "$WORK" >/dev/null 2>&1
[ $? -ne 0 ] && ok "rejects an invalid identifier" || bad "accepted '9Bad Name'"
[ -e "$WORK/9Bad Name" ] && bad "wrote a directory despite failing" || ok "wrote nothing"

"$GEN" --name "" --out "$WORK" >/dev/null 2>&1
[ $? -ne 0 ] && ok "rejects a missing --name" || bad "accepted an empty name"

"$GEN" --name Nope --out "$WORK" --language F# >/dev/null 2>&1
[ $? -ne 0 ] && ok "rejects an unsupported language" || bad "accepted F#"

# --------------------------------------------------------------- generation
sect "generator creates a project Visual Studio can open"
OUT=$("$GEN" --name CustomerForm --out "$WORK" 2>&1)
RC=$?
[ $RC -eq 0 ] || { bad "generator exited $RC"; echo "$OUT" | sed 's/^/        /'; }
SLN="$WORK/CustomerForm.sln"
DIR="$WORK/CustomerForm"

[ -f "$SLN" ] && ok "created a classic .sln" || bad "no .sln created"
[ -f "$DIR/CustomerForm.csproj" ] && ok "created the project" || bad "no .csproj"

# Trap 1: the SDK defaults to .slnx, which VS 17.0-17.9 cannot open. If we ever lose -f sln
# this file would be XML and every assertion below would still "pass" on a broken file.
if head -2 "$SLN" | grep -q "Microsoft Visual Studio Solution File"; then
  ok "solution is the classic text format, not .slnx"
else bad "solution is not a classic .sln (SDK default is .slnx)"; fi

# Trap 3: without .Build.0 a solution builds nothing and still exits 0.
if grep -q "Build.0" "$SLN"; then ok "solution has Build.0 entries so it actually builds"
else bad "solution lacks Build.0 — it would build nothing and still exit 0"; fi

if grep -q 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}")' "$SLN"; then
  ok "project entry uses the C# type GUID Visual Studio accepts"
else bad "no project entry with the expected type GUID"; fi

# Trap 2: EnableWindowsTargeting, injected only on non-Windows hosts.
if grep -q "EnableWindowsTargeting" "$DIR/CustomerForm.csproj"; then
  ok "csproj can restore/build on this host"
else bad "no EnableWindowsTargeting — will fail with NETSDK1100 here"; fi

# The template emits this and it is load-bearing on Windows: it is what makes VS show the
# WinForms designer for Form1.cs. It must be generated even though it stays uncommitted.
[ -f "$DIR/CustomerForm.csproj.user" ] && ok "generated .csproj.user (VS needs it for the designer)" \
                                         || bad "no .csproj.user"

# BOM/CRLF are part of "identical to Visual Studio", and our engine now preserves them.
python3 - "$DIR/CustomerForm.csproj" <<'PY' && ok "csproj keeps the SDK's BOM and CRLF" || bad "csproj encoding changed"
import sys
d = open(sys.argv[1], 'rb').read()
sys.exit(0 if d[:3] == b'\xef\xbb\xbf' and b'\r\n' in d else 1)
PY

sect "generated project builds"
if grep -q "project builds" <<<"$OUT"; then ok "generator's own build check passed"
else bad "the generated project did not build"; fi

# --------------------------------------------------- THE LOOP WE CARE ABOUT
sect "VSCForms can read the form the generator produced"
SCHEMA=$(printf '{"id":1,"cmd":"parse","path":"%s"}\n' "$DIR/Form1.Designer.cs" | "$ENGINE" 2>/dev/null)
if [ -z "$SCHEMA" ]; then bad "engine produced no output"; else
  echo "$SCHEMA" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d.get('ok'), d
s=d['schema']
f=s['form']
# A fresh template writes 800x450 and Text='Form1'. Reading these at all is the fix for the
# bare-identifier bug; reporting 0x0 here means the templated dialect regressed.
assert f['clientSize']=={'width':800,'height':450}, ('clientSize', f['clientSize'])
assert f['text']=='Form1', ('text', f['text'])
assert s['controls']==[], s['controls']
assert s['analysis']['coveragePercent']==100.0
" && ok "reads the templated dialect (text + clientSize, not an empty form)" \
  || bad "VSCForms cannot read its own generated output"
fi

sect "a control added to a generated form still compiles"
cp "$DIR/Form1.Designer.cs" /tmp/gen-before.cs
printf '{"id":1,"cmd":"parse","path":"%s"}\n' "$DIR/Form1.Designer.cs" | "$ENGINE" 2>/dev/null \
| python3 -c "
import json,sys
s=json.load(sys.stdin)['schema']
s['controls'].append({'id':'btnGo','type':'System.Windows.Forms.Button','children':[],
 'properties':{'x':300,'y':300,'width':90,'height':30,'text':'Go','tabIndex':0},'locked':False})
s['analysis']['modelledCount']+=1
print(json.dumps({'id':2,'cmd':'generate','path':'$DIR/Form1.Designer.cs','schema':s}))" \
| "$ENGINE" >/dev/null 2>&1

for part in "private System.Windows.Forms.Button btnGo;" "btnGo = new System.Windows.Forms.Button();" \
            "Controls.Add(btnGo);"; do
  grep -qF "$part" "$DIR/Form1.Designer.cs" || bad "missing from generated output: $part"
done
ok "inserted a control into the generated form"

CH=$(diff /tmp/gen-before.cs "$DIR/Form1.Designer.cs" | grep -c '^<')
[ "$CH" -eq 0 ] && ok "the insert is purely additive" || bad "insert removed $CH line(s)"

if (cd "$DIR" && dotnet build -v q --nologo 2>&1 | grep -q "Build succeeded"); then
  ok "a form VSCForms edited still builds as a real WinForms project"
else
  bad "edited generated form FAILED to build"
  (cd "$DIR" && dotnet build -v q --nologo 2>&1 | grep -E "error" | head -4 | sed 's/^/        /')
fi

echo
echo "generator tier: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1