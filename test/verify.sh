#!/usr/bin/env bash
# VSCForms verification suite.
#
# Two tiers, per docs: the fast hermetic loop and the real compile gate.
#   [roslyn]  parses clean; untouched file round-trips byte-identical; edits are surgical
#   [compile] the output still builds as a real WinForms project on this machine
set -uo pipefail
cd "$(dirname "$0")/.."

ENGINE=./engine/bin/Debug/net10.0/vscforms-engine
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sect() { echo; echo "== $1"; }

if [ ! -x "$ENGINE" ]; then echo "engine not built; run: dotnet build engine"; exit 1; fi

send() { printf '%s\n' "$1" | "$ENGINE" 2>/dev/null; }

work() { # $1 = fixture dir, $2 = form base name -> stages a copy in /tmp/mf-test
  rm -rf /tmp/mf-test && cp -r "fixtures/$1" /tmp/mf-test
  FILE="/tmp/mf-test/$2.Designer.cs"
}

python_tweak() { # $1 = python snippet operating on schema `s`
  send "{\"id\":1,\"cmd\":\"parse\",\"path\":\"$FILE\"}" \
  | python3 -c "
import json,sys
s=json.load(sys.stdin)['schema']
$1
print(json.dumps({'id':2,'cmd':'generate','path':'$FILE','schema':s}))
" | "$ENGINE" 2>/dev/null
}

# ---------------------------------------------------------------- parse tier
sect "[roslyn] parse: simple fixture"
work simple SimpleDialog
OUT=$(send "{\"id\":1,\"cmd\":\"parse\",\"path\":\"$FILE\"}")
echo "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)['schema']
a=d['analysis']
assert a['coveragePercent']==100, a
assert a['modelledCount']==5, a
assert len(d['controls'])==5, len(d['controls'])
assert d['form']['text']=='Add Person'
assert d['form']['clientSize']=={'width':292,'height':196}
b=[c for c in d['controls'] if c['id']=='btnSubmit'][0]
assert b['properties']['x']==96 and b['properties']['y']==154, b['properties']
assert b['properties']['width']==84 and b['properties']['height']==27
assert b['properties']['text']=='Submit'
assert b['locked'] is False
" && ok "simple parses with correct geometry" || bad "simple parse"

sect "[roslyn] refusals detected"
work docked DockedForm
send "{\"id\":1,\"cmd\":\"parse\",\"path\":\"$FILE\"}" | python3 -c "
import json,sys; a=json.load(sys.stdin)['schema']['analysis']
assert 'dock-anchor' in a['refuses'], a['refuses']" \
  && ok "dock/anchor form refuses" || bad "dock-anchor refusal"

work localizable LocalizableForm
send "{\"id\":1,\"cmd\":\"parse\",\"path\":\"$FILE\"}" | python3 -c "
import json,sys; d=json.load(sys.stdin)['schema']; a=d['analysis']
assert 'localizable' in a['refuses'], a['refuses']
# The gauge is a CHILD of pnlToolbar (it is added via pnlToolbar.Controls.Add), so it must
# be found by walking the tree rather than in the flat top-level list.
def all_controls(ns):
    for c in ns:
        yield c
        yield from all_controls(c['children'])
g=[c for c in all_controls(d['controls']) if c['id']=='ThirdPartyGauge'][0]
assert g['locked'] is True and 'GaugeControl' in g['type']
assert a['coveragePercent']==75.0, a" \
  && ok "ApplyResources refuses; third-party control locked" || bad "localizable refusal"

sect "[roslyn] byte-identical round trip (untouched)"
for fx in "simple SimpleDialog" "docked DockedForm" "localizable LocalizableForm"; do
  set -- $fx; work "$1" "$2"
  cp "$FILE" /tmp/mf-orig.cs
  python_tweak "pass" >/dev/null
  if diff -q /tmp/mf-orig.cs "$FILE" >/dev/null; then ok "$2 unchanged when nothing changed"
  else bad "$2 was modified by a no-op generate"; fi
done

sect "[roslyn] surgical move (only the touched lines change)"
work simple SimpleDialog
cp "$FILE" /tmp/mf-orig.cs
python_tweak "
for c in s['controls']:
    if c['id']=='btnSubmit': c['properties'].update(x=400,y=300)" >/dev/null
CHANGED=$(diff /tmp/mf-orig.cs "$FILE" | grep -c '^[<>]')
if [ "$CHANGED" -eq 2 ] && grep -q "Point(400, 300)" "$FILE"; then
  ok "move = exactly 2 changed lines"
else bad "move touched $CHANGED lines (expected 2)"; fi
for keep in "#region Windows Form Designer generated code" "SuspendLayout" "protected override void Dispose" "this.btnCancel.Text = \"Cancel\""; do
  grep -q "$keep" "$FILE" || bad "move destroyed: $keep"
done
ok "untouched structures survive the move"

sect "[roslyn] surgical add"
MISSING=""
work simple SimpleDialog
cp "$FILE" /tmp/mf-orig.cs
python_tweak "
s['controls'].append({'id':'btnExtra','type':'System.Windows.Forms.Button','children':[],
  'properties':{'x':10,'y':10,'width':75,'height':23,'text':'Extra','tabIndex':9},'locked':False})
s['analysis']['modelledCount']+=1; s['analysis']['coveragePercent']=100.0" >/dev/null
for part in "this.btnExtra = new System.Windows.Forms.Button();" \
            "private System.Windows.Forms.Button btnExtra;" \
            "this.Controls.Add(this.btnExtra);" \
            "// btnExtra"; do
  grep -qF "$part" "$FILE" || MISSING="$MISSING\n        - $part"
done
[ -z "$MISSING" ] && ok "add inserts declaration, init, block and Controls.Add" \
                  || bad "add did not produce all four parts:$MISSING"
REMOVED=$(diff /tmp/mf-orig.cs "$FILE" | grep -c '^<'); ADDED=$(diff /tmp/mf-orig.cs "$FILE" | grep -c '^>')
if [ "$REMOVED" -eq 0 ]; then ok "add is purely additive ($ADDED lines in, 0 out)"
else bad "add removed $REMOVED existing lines"; fi

sect "[roslyn] delete"
work simple SimpleDialog
cp "$FILE" /tmp/mf-orig.cs
python_tweak "
s['controls']=[c for c in s['controls'] if c['id']!='btnCancel']
s['analysis']['modelledCount']-=1" >/dev/null
if grep -q "btnCancel" "$FILE"; then bad "delete left btnCancel behind"
else ok "delete removes every trace of the control"; fi

sect "[roslyn] refused form is not written"
work localizable LocalizableForm
cp "$FILE" /tmp/mf-orig.cs
R=$(python_tweak "
for c in s['controls']:
    if c['id']=='btnGo': c['properties'].update(x=1,y=1)")
if echo "$R" | grep -q '"ok":false'; then ok "generate refuses with ok:false"
else bad "generate accepted a refused form"; fi
diff -q /tmp/mf-orig.cs "$FILE" >/dev/null && ok "refused form left untouched on disk" || bad "refused form was modified"

sect "[roslyn] locked controls are never written"
work localizable LocalizableForm
cp "$FILE" /tmp/mf-orig.cs
python_tweak "
for c in s['controls']:
    if c['id']=='ThirdPartyGauge': c['properties'].update(x=999,y=999,width=1,height=1)" >/dev/null
diff -q /tmp/mf-orig.cs "$FILE" >/dev/null \
  && ok "moving a locked control writes nothing at all" || bad "locked control was modified"

echo
echo "roslyn tier: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
# --------------------------------------------------------------- compile tier
# The real gate: does the generated C# still compile as a WinForms project?
# Requires the WindowsDesktop reference pack, downloadable from NuGet on first run.
sect "[compile] generated code builds as real WinForms"
if ! ls ~/.nuget/packages/microsoft.windowsdesktop.app.ref >/dev/null 2>&1; then
  if ! curl -sS --max-time 8 -o /dev/null https://api.nuget.org/v3/index.json; then
    echo "  SKIP  nuget unreachable and ref pack not cached (offline)"
    exit 0
  fi
fi

compile_scenario() { # $1 = label, $2 = python tweak
  rm -rf /tmp/mf-compile && mkdir -p /tmp/mf-compile
  cp fixtures/simple/SimpleDialog.Designer.cs /tmp/mf-compile/
  cat > /tmp/mf-compile/Form.cs <<'CSEOF'
using System;
using System.Windows.Forms;
namespace FixtureSimple {
  public partial class SimpleDialog : Form {
    public SimpleDialog() { InitializeComponent(); }
    private void btnSubmit_Click(object sender, EventArgs e) { }
    private void btnCancel_Click(object sender, EventArgs e) { }
  }
}
CSEOF
  cat > /tmp/mf-compile/P.csproj <<'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <OutputType>Library</OutputType>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>
CSPROJ
  printf '{"id":1,"cmd":"parse","path":"/tmp/mf-compile/SimpleDialog.Designer.cs"}\n' \
    | "$ENGINE" 2>/dev/null \
    | python3 -c "
import json,sys
s=json.load(sys.stdin)['schema']
$2
print(json.dumps({'id':2,'cmd':'generate','path':'/tmp/mf-compile/SimpleDialog.Designer.cs','schema':s}))" \
    | "$ENGINE" >/dev/null 2>&1
  OUT=$(cd /tmp/mf-compile && dotnet build -v q --nologo 2>&1)
  if echo "$OUT" | grep -q "Build succeeded"; then ok "$1 compiles"
  else bad "$1 FAILED to compile"; echo "$OUT" | grep -E "error" | head -4 | sed 's/^/        /'; fi
}

compile_scenario "baseline (unmodified fixture)"        "pass"
compile_scenario "after moving a control"              "
for c in s['controls']:
    if c['id']=='btnSubmit': c['properties'].update(x=250,y=220,width=140,height=45)"
compile_scenario "after adding a control"              "
s['controls'].append({'id':'btnExtra','type':'System.Windows.Forms.Button','children':[],
 'properties':{'x':12,'y':20,'width':75,'height':23,'text':'Extra','tabIndex':9},'locked':False})
s['analysis']['modelledCount']+=1"
compile_scenario "after deleting a control"            "
s['controls']=[c for c in s['controls'] if c['id']!='chkAgree']
s['analysis']['modelledCount']-=1"
compile_scenario "after editing several properties"    "
for c in s['controls']:
    if c['id']=='btnCancel':
        c['properties'].update(x=1,y=2,width=200,height=44,text='No thanks')
        c['properties']['tabIndex']=7"

echo
echo "compile tier: $PASS passed, $FAIL failed (cumulative)"
[ "$FAIL" -eq 0 ] || exit 1
