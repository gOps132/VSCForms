#!/usr/bin/env bash
# Verifies the project generator, and closes the loop it exists to serve: that VSCForms can
# read a form the generator produced.
#
# The last part is the point. A generator whose output our own tool cannot parse would be a
# worse bug than no generator — it would ship projects that open as an empty form at 100%
# coverage. That exact failure happened once, on `dotnet new winforms` output, and this test
# exists so it cannot happen again.
#
# The generator is the ENGINE's `new` command, not a shell script (docs/adr/0007). That matters
# here for two reasons: the csproj edit has to preserve the SDK's BOM and CRLF, and the engine
# is the only component that already does byte-faithful file editing.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sect(){ echo; echo "== $1"; }

ENGINE=./engine/bin/Debug/net10.0/vscforms-engine

command -v dotnet >/dev/null || { echo "SKIP  dotnet not on PATH"; exit 0; }
[ -x "$ENGINE" ] || { echo "SKIP  engine not built"; exit 0; }

WORK=$(mktemp -d)/gen
mkdir -p "$WORK"
trap 'rm -rf "$(dirname "$WORK")"' EXIT

# gen <name> [extra-json-field value ...] -> response on stdout, one engine process per call so
# a crash mid-generation cannot take the harness down with it. Extras are emitted as
# "key":value pairs, so `gen Foo template winformslib language VB`.
gen() {
  local name="$1"; shift
  local extra="" pair
  while [ $# -gt 0 ]; do
    pair="$1"; shift
    extra="$extra, \"$pair\": \"$1\""
    shift
  done
  printf '{"id":1,"cmd":"new","name":"%s","parent":"%s"%s}\n' \
    "$name" "$WORK" "$extra" \
    | "$ENGINE" 2>/dev/null
}

# errkind <response> — the errorKind, or empty when the call succeeded.
errkind() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('errorKind','') if not d.get('ok') else '')"; }

# --------------------------------------------------------------- rejection
sect "generator rejects bad input before writing anything"

K=$(gen "9Bad Name" | errkind)
[ "$K" = "bad-name" ] && ok "rejects an invalid identifier ($K)" || bad "accepted '9Bad Name' (got '$K')"
[ -e "$WORK/9Bad Name" ] && bad "wrote a directory despite failing" || ok "wrote nothing"

# A C# keyword is a legal-looking identifier that produces a project which cannot compile.
K=$(gen "class" | errkind)
[ "$K" = "bad-name" ] && ok "rejects a C# keyword ($K)" || bad "accepted 'class' (got '$K')"

K=$(gen "Nope" language 'F#' | errkind)
[ "$K" = "bad-language" ] && ok "rejects an unsupported language ($K)" || bad "accepted F# (got '$K')"

K=$(gen "Nope" template 'no-such-template' | errkind)
[ "$K" = "no-template" ] && ok "rejects a template this SDK lacks ($K)" || bad "accepted a bogus template (got '$K')"

# 'exists' must be checked BEFORE anything is written, so a second call is a clean refusal
# rather than a half-overwritten project.
gen "Existing" >/dev/null
K=$(gen "Existing" | errkind)
[ "$K" = "exists" ] && ok "refuses to overwrite an existing project ($K)" || bad "overwrote silently (got '$K')"

# --------------------------------------------------------------- generation
sect "generator creates a project Visual Studio can open"
RESP=$(gen "CustomerForm")
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d.get('ok'), d
for k in ('projectDir','solution','designer'): assert d.get(k), (k, d)
assert d['windowsTargetingAdded'] is True
" && ok "returns projectDir, solution and designer" || bad "malformed response: $RESP"

DIR="$WORK/CustomerForm"
SLN="$WORK/CustomerForm.sln"

[ -f "$SLN" ] && ok "created a classic .sln" || bad "no .sln created"
[ -f "$DIR/CustomerForm.csproj" ] && ok "created the project" || bad "no .csproj"

# Trap 1: the SDK defaults to .slnx, which VS 17.0-17.9 cannot open. If we ever lose --format
# sln this file would be XML and every assertion below would still "pass" on a broken file.
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

# The property is injected after <OutputType>, which is where a human would write it.
if python3 -c "
import sys,re
t=open('$DIR/CustomerForm.csproj',encoding='utf-8-sig').read()
o=t.index('<OutputType>'); e=t.index('<EnableWindowsTargeting>')
sys.exit(0 if o < e else 1)"; then
  ok "property sits next to <OutputType>, where a human would put it"
else bad "property injected in a surprising place"; fi

# BOM and CRLF are part of 'identical to Visual Studio'. This is the assertion that caught the
# shell script rewriting the SDK's CRLF as LF: reading with a StreamReader normalises newlines
# on the way in, so a text-mode edit silently rewrites every line ending in the file.
python3 - "$DIR/CustomerForm.csproj" <<'PY' && ok "csproj keeps the SDK's BOM and CRLF, byte for byte" || bad "csproj encoding changed"
import sys
d = open(sys.argv[1], 'rb').read()
assert d[:3] == b'\xef\xbb\xbf', 'BOM lost'
assert b'\r\n' in d, 'CRLF lost'
assert d.count(b'\n') == d.count(b'\r\n'), 'some line endings became LF'
PY

sect "the generated project builds"
if (cd "$DIR" && dotnet build -v q --nologo 2>&1 | grep -q "Build succeeded"); then
  ok "generated project builds as a real WinForms project"
else
  bad "generated project FAILED to build"
  (cd "$DIR" && dotnet build -v q --nologo 2>&1 | grep -E "error" | head -4 | sed 's/^/        /')
fi

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
cp "$DIR/Form1.Designer.cs" "$WORK/gen-before.cs"
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

CH=$(diff "$WORK/gen-before.cs" "$DIR/Form1.Designer.cs" | grep -c '^<')
[ "$CH" -eq 0 ] && ok "the insert is purely additive" || bad "insert removed $CH line(s)"

if (cd "$DIR" && dotnet build -v q --nologo 2>&1 | grep -q "Build succeeded"); then
  ok "a form VSCForms edited still builds as a real WinForms project"
else
  bad "edited generated form FAILED to build"
  (cd "$DIR" && dotnet build -v q --nologo 2>&1 | grep -E "error" | head -4 | sed 's/^/        /')
fi

# --------------------------------------------------- protocol hygiene
# stdout is a protocol channel (invariant 6). Generation shells out to dotnet four times; if any
# of those children inherits our stdout, its output lands between request and response and the
# host sees a JSON parse error with no cause. The bug this catches was real: `dotnet --version`
# leaked "10.0.400" onto the channel.
sect "stdout stays a clean protocol channel"
LINES=$(gen "ChannelForm" | wc -l | tr -d ' ')
[ "$LINES" = "1" ] && ok "generation emits exactly one JSON line on stdout" \
                    || bad "generation emitted $LINES lines — a child process is writing to stdout"

if gen "ChannelForm2" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  ok "the response is parseable as a single JSON object"
else bad "stdout is not valid single-line JSON"; fi

echo
echo "generator tier: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1