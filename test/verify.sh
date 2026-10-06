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

# ---------------------------------------------------------------------------
# Properties that are ALREADY in the schema. docs/spec-features.md §3: these were parsed and
# declared, and the patcher wrote only two of them. Wiring the rest is the cheapest real
# capability in the project — no schema change, no ADR.
# ---------------------------------------------------------------------------
sect "[roslyn] Enabled and Visible"
work simple SimpleDialog
python_tweak "
for c in s['controls']:
    if c['id']=='btnSubmit':
        c['properties']['enabled']=False
        c['properties']['visible']=False" >/dev/null
grep -q "this.btnSubmit.Enabled = false;" "$FILE" \
  && ok "Enabled writes a bare boolean literal" || bad "Enabled not written"
grep -q "this.btnSubmit.Visible = false;" "$FILE" \
  && ok "Visible writes a bare boolean literal" || bad "Visible not written"

sect "[roslyn] BackColor round-trips through the file's own spelling"
# The trap: System.Drawing.Color has many spellings — Color.Red, Color.FromArgb(255, 0, 0),
# System.Drawing.Color.FromArgb(255,0,0). ADR 0005 says do not rewrite a type name the file
# already wrote, so the patcher must replace only the ARGUMENT LIST. Getting this wrong is
# silent churn on every edit.
cp "$FILE" /tmp/mf-bc.cs
grep -q "BackColor" "$FILE" && ok "the fixture already carries a BackColor to preserve" \
  || bad "fixture has no BackColor, so the preservation check proves nothing"
python_tweak "
for c in s['controls']:
    if c['id']=='btnSubmit': c['properties']['backColor']='#00FF00'" >/dev/null
# ADR 0005: the TYPE NAME must survive. Only the argument values change. Rewriting
# `System.Drawing.Color.FromArgb(...)` to a bare `Color.FromArgb(...)` or to `Color.Lime` would
# compile and be pure churn — the single most likely silent regression in this feature.
grep -q "this.btnSubmit.BackColor = System.Drawing.Color.FromArgb(0, 255, 0);" "$FILE" \
  && ok "BackColor values changed; the fully qualified type name was preserved" \
  || { bad "BackColor rewritten the type name or mis-spelled the call"; grep -n "btnSubmit.BackColor" "$FILE"; }
CHANGED=$(diff /tmp/mf-bc.cs "$FILE" | grep -c '^<')
[ "$CHANGED" -eq 1 ] && ok "BackColor changed exactly one line" || bad "BackColor changed $CHANGED lines"

sect "[roslyn] BackColor and Font are INSERTED when the control has neither"
# Found by driving a real `dotnet new winforms` project end to end, not by any tier. The patcher
# only ever REPLACED these two, so setting a colour on a control that had none was accepted by
# the canvas and silently discarded by the engine — the "the control looks editable and nothing
# happens" failure AGENTS.md's two-list rule warns about, one level down.
work simple SimpleDialog
grep -q "this.chkAgree.BackColor" "$FILE" && bad "fixture assumption broken: chkAgree has a BackColor" \
  || ok "the fixture has a control with no BackColor, so the insert path is what runs"
cp "$FILE" /tmp/mf-nobc.cs
python_tweak "
for c in s['controls']:
    if c['id']=='chkAgree':
        c['properties']['backColor']='#C6E6C9'
        c['properties']['font']={'size':11.0,'bold':True,'italic':False}" >/dev/null
grep -q "this.chkAgree.BackColor = System.Drawing.Color.FromArgb(198, 230, 201);" "$FILE" \
  && ok "BackColor INSERTED for a control that had none" || { bad "BackColor not inserted"; grep -n "chkAgree.BackColor" "$FILE" || true; }
# The comma before the FontStyle argument is easy to drop and only the compile gate sees it.
grep -q 'this.chkAgree.Font = new System.Drawing.Font("Microsoft Sans Serif", 11F, System.Drawing.FontStyle.Bold);' "$FILE" \
  && ok "Font INSERTED with a comma before the FontStyle argument" || { bad "Font insert malformed"; grep -n "chkAgree.Font" "$FILE" || true; }
# Count ADDED lines, not removed ones: these are pure inserts, so `^<` would be 0 by design
# and the assertion would pass vacuously.
REMOVED=$(diff /tmp/mf-nobc.cs "$FILE" | grep -c '^<')
ADDED=$(diff /tmp/mf-nobc.cs "$FILE" | grep -c '^>')
# InsertLineAfter emits the property plus a trailing newline, and two inserts at the SAME
# anchor each contribute a blank separator line — hence four added lines for two properties.
[ "$ADDED" -eq 4 ] && ok "adding both inserted two properties (plus their blank separators)" \
  || bad "expected 4 added lines, got $ADDED"
[ "$REMOVED" -eq 0 ] && ok "and removed nothing — the insert is purely additive" \
  || bad "the insert also removed $REMOVED line(s)"

sect "[roslyn] Font is re-constructed without churning the dialect"
cp "$FILE" /tmp/mf-font.cs
python_tweak "
for c in s['controls']:
    if c['id']=='btnSubmit':
        c['properties']['font']={'size':14.0,'bold':True,'italic':False,'family':'Segoe UI'}" >/dev/null
grep -qE "this\.btnSubmit\.Font = new System\.Drawing\.Font\(\"Segoe UI\", 14F, System\.Drawing\.FontStyle\.Bold\);" "$FILE" \
  && ok "Font written as a construction, fully qualified, in the classic dialect" \
  || { bad "Font not written correctly"; grep -n "btnSubmit.Font" "$FILE" | head -3; }
CHANGED=$(diff /tmp/mf-font.cs "$FILE" | grep -c '^<')
[ "$CHANGED" -eq 1 ] && ok "Font changed exactly one line" || bad "Font changed $CHANGED lines"

# ---------------------------------------------------------------------------
# Leaf widgets — docs/spec-leaf-widgets.md. Four types, and the risk is not the engine: it is
# the TWO-LIST RULE. A type in TypeTable but not in the canvas HANDLED list renders as a locked
# box with no stated reason; a type in the canvas but not the engine accepts input that the
# patcher then silently discards. Both failures look like "it half works", which is the worst
# shape a bug can have.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# THE TWO-LIST RULE, enforced across files.
#
# AGENTS.md requires a type in `TypeTable.Handled` AND in the canvas `HANDLED` list. The
# failure is silent in both directions:
#   engine knows, canvas does not  -> renders as a locked box with no stated reason
#   canvas knows, engine does not  -> accepts input the patcher then discards (worse)
#
# A harness assertion can only compare the canvas against a LITERAL copy of the engine's list,
# which proves canvas ⊆ literal and lets the literal drift. So this compares the two REAL
# files. It is the only assertion here that can fail without anything else failing first.
# ---------------------------------------------------------------------------
sect "[roslyn] the engine type table and the canvas toolbox are the same set"
python3 - <<'PYEOF'
import re, sys

engine = open('engine/src/TypeTable.cs', encoding='utf-8').read()
canvas = open('extension/media/canvas.js', encoding='utf-8').read()

handled = re.search(r'private static readonly Dictionary<string, string> Handled.*?\{(.*?)\n    \};',
                    engine, re.S).group(1)
e_types = set(re.findall(r'\["System\.Windows\.Forms\.(\w+)"\]', handled))

palette = re.search(r'const HANDLED = \[(.*?)\n    \];', canvas, re.S).group(1)
c_types = set(re.findall(r"\['(\w+)',\s*'t-", palette))

missing = sorted(e_types - c_types)
orphan = sorted(c_types - e_types)
if missing:
    print('  engine handles these but the canvas has no tool — they will render LOCKED:')
    print('   ', ', '.join(missing))
if orphan:
    print('  the canvas offers tools the engine does NOT handle — edits will be discarded:')
    print('   ', ', '.join(orphan))
sys.exit(1 if (missing or orphan) else 0)
PYEOF
[ $? -eq 0 ] && ok "engine and canvas agree on all $(grep -c '\["System.Windows.Forms' engine/src/TypeTable.cs) handled types" \
  || bad "the two type lists disagree"

# And the prefixes must match too, or every generated control of that type is named ctl1, ctl2.
python3 - <<'PYEOF'
import re, sys
engine = open('engine/src/TypeTable.cs', encoding='utf-8').read()
canvas = open('extension/media/canvas.js', encoding='utf-8').read()

e_prefix = dict(re.findall(r'"(\w+)" => "(\w+)"',
    re.search(r'public static string Prefix.*?switch\s*(.*?);', engine, re.S).group(1)))
c_prefix = dict((m[0], m[1]) for m in re.findall(r"(\w+):\s*'(\w+)'",
    re.search(r'const PREFIX = \{(.*?)\n    \};', canvas, re.S).group(1)))

palette = set(re.findall(r"\['(\w+)'", re.search(r'const HANDLED = \[(.*?)\n    \];', canvas, re.S).group(1)))
bad = []
for t in sorted(palette):
    if e_prefix.get(t) != c_prefix.get(t):
        bad.append(f"{t}: engine={e_prefix.get(t)} canvas={c_prefix.get(t)}")
for b in bad: print('  ', b)
sys.exit(1 if bad else 0)
PYEOF
[ $? -eq 0 ] && ok "every type allocates the same prefix in the engine and the canvas" \
  || bad "prefixes disagree between the engine and the canvas"

sect "[roslyn] leaf widgets read as modelled, not locked"
work leafwidgets LeafForm
# Re-parse: `work` stages a new file, so $OUT is stale from the previous section otherwise.
send "{\"id\":1,\"cmd\":\"parse\",\"path\":\"$FILE\"}" | python3 -c "
import json,sys
s=json.load(sys.stdin)['schema']
ids={c['id'] for c in s['controls']}
for want in ['trackVolume','progressLoad','numQuantity','dtpDue']:
    assert want in ids, (want, sorted(ids))
locked=[c['id'] for c in s['controls'] if c['locked']]
assert not locked, 'a SUPPORTED type is rendering as LOCKED: ' + str(locked)
assert s['analysis']['coveragePercent']==100.0, s['analysis']
" && ok "all four parse as modelled at 100% coverage" || bad "leaf widgets not modelled"

sect "[roslyn] adding each leaf widget emits the right lines and prefix"
for spec in "System.Windows.Forms.TrackBar:trk:120:56" \
            "System.Windows.Forms.ProgressBar:prg:140:20" \
            "System.Windows.Forms.NumericUpDown:num:100:22" \
            "System.Windows.Forms.DateTimePicker:dtp:120:23"; do
  IFS=':' read -r type prefix w h <<< "$spec"
  simple="${type##*.}"
  work leafwidgets LeafForm
  python_tweak "
s['controls'].append({'id':'new$prefix','type':'$type','children':[],
 'properties':{'x':400,'y':300,'width':$w,'height':$h,'tabIndex':9},'locked':False})
s['analysis']['modelledCount']+=1" >/dev/null
  MISSING=""
  for part in "private $type new$prefix;" \
              "new$prefix = new $type();" \
              "new$prefix.Location = new System.Drawing.Point(400, 300);" \
              "new$prefix.Name = \"new$prefix\";" \
              "new$prefix.Size = new System.Drawing.Size($w, $h);" \
              "Controls.Add(this.new$prefix);"; do
    grep -qF "$part" "$FILE" || MISSING="$MISSING"$'\n'"        - $part"
  done
  [ -z "$MISSING" ] && ok "$simple added with prefix $prefix" || bad "$simple add is missing parts:$MISSING"
done

sect "[roslyn] the leaf widget fixture compiles as a real WinForms project"
# The compile gate is the only check that catches a wrong emitted property or an illegal
# default size — both of which produce a diff that looks entirely reasonable.
LEAF_SRC=$(mktemp -d)/leaf/src
mkdir -p "$LEAF_SRC"
cp fixtures/leafwidgets/LeafForm.Designer.cs "$LEAF_SRC/"
{ echo "using System;"; echo "using System.Windows.Forms;"; echo "namespace FixtureLeafWidgets {"
  echo "  public partial class LeafForm : Form {"
  echo "    public LeafForm() { InitializeComponent(); }"
  echo "  }"; echo "}"; } > "$LEAF_SRC/Form.cs"
cat > "$LEAF_SRC/L.csproj" <<'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <OutputType>Library</OutputType>
    <Nullable>disable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
CSPROJ
LEAF_BUILD=$(cd "$LEAF_SRC" && dotnet build -v q --nologo 2>&1)
if echo "$LEAF_BUILD" | grep -q "Build succeeded"; then
  ok "the four leaf widgets compile as real WinForms controls"
else
  bad "leaf widget fixture FAILED to compile"
  echo "$LEAF_BUILD" | grep -E "error" | head -4 | sed 's/^/        /'
fi

sect "[roslyn] an unmodelled property of a leaf widget is left alone"
# DateTimePicker.Value and .CustomFormat are NOT in the schema. Moving the control must not
# disturb them — they survive because we never touch what we do not model (ADR 0001).
work leafwidgets LeafForm
cp "$FILE" /tmp/mf-leaf.cs
python_tweak "
for c in s['controls']:
    if c['id']=='dtpDue': c['properties'].update(x=60,y=90)" >/dev/null
grep -q 'this.dtpDue.Value = new DateTime(2026, 10, 6);' "$FILE" \
  && ok "DateTimePicker.Value survives a move untouched" || bad "Value was disturbed"
grep -q 'this.dtpDue.CustomFormat = "yyyy-MM-dd";' "$FILE" \
  && ok "DateTimePicker.CustomFormat survives a move untouched" || bad "CustomFormat was disturbed"
CHANGED=$(diff /tmp/mf-leaf.cs "$FILE" | grep -c '^<')
# Exactly one: the Location line. Anything more means we touched a property we do not model.
[ "$CHANGED" -eq 1 ] && ok "moving dtpDue changed exactly one line — its Location" \
  || bad "move changed $CHANGED lines, expected 1"
grep -q 'this.dtpDue.Location = new System.Drawing.Point(60, 90);' "$FILE" \
  && ok "and that line is the new Location" || bad "the changed line is not the Location"

echo
# ---------------------------------------------------------------------------
# Items — docs/spec-items.md. ComboBox/ListBox Items.AddRange / Items.Add.
# ---------------------------------------------------------------------------
sect "[roslyn] items: parse reads Items.AddRange and Items.Add in order"
work items ItemsForm
OUT=$(send "{\"id\":1,\"cmd\":\"parse\",\"path\":\"$FILE\"}")
echo "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)['schema']
a=d['analysis']
assert a['coveragePercent']==100, a
assert len(d['controls'])==4, len(d['controls'])
byid={c['id']:c for c in d['controls']}
assert byid['cboRole']['properties']['items']==['Admin','User','Guest'], byid['cboRole']['properties']
assert byid['lstTags']['properties']['items']==['urgent','important','normal'], byid['lstTags']['properties']
assert byid['cboEmpty']['properties']['items']==[], byid['cboEmpty']['properties']
assert 'items' not in byid['btnGo']['properties'], byid['btnGo']['properties']
" && ok "items parsed correctly for ComboBox and ListBox" || bad "items not parsed"

sect "[roslyn] items: replace rewrites the AddRange argument"
work items ItemsForm
python_tweak "
for c in s['controls']:
    if c['id']=='cboRole':
        c['properties']['items']=['Manager','Staff']" >/dev/null
grep -qF 'this.cboRole.Items.AddRange(new object[] { "Manager", "Staff" });' "$FILE" \
  && ok "AddRange argument replaced" || bad "AddRange not replaced"
# Check only the Items line for old items, not the Text property
grep 'this.cboRole.Items.AddRange' "$FILE" | grep -qF '"Admin"' && bad "old item Admin still present in Items" || ok "old items removed from Items"

sect "[roslyn] items: insert adds an AddRange to a control with none"
work items ItemsForm
python_tweak "
for c in s['controls']:
    if c['id']=='cboEmpty':
        c['properties']['items']=['Red','Green','Blue']" >/dev/null
grep -qF 'this.cboEmpty.Items.AddRange(new object[] { "Red", "Green", "Blue" });' "$FILE" \
  && ok "AddRange inserted for control with no items" || bad "AddRange not inserted"

sect "[roslyn] items: delete removes the items statements"
work items ItemsForm
python_tweak "
for c in s['controls']:
    if c['id']=='lstTags':
        c['properties']['items']=[]" >/dev/null
grep -qF 'lstTags.Items.Add' "$FILE" && bad "Items.Add still present after delete" \
  || ok "items statements removed"

sect "[roslyn] items: fixture compiles as a real WinForms project"
ITEMS_SRC=$(mktemp -d)/items/src
mkdir -p "$ITEMS_SRC"
cp fixtures/items/ItemsForm.Designer.cs "$ITEMS_SRC/"
{ echo "using System;"; echo "using System.Windows.Forms;"; echo "namespace FixtureItems {"
  echo "  public partial class ItemsForm : Form {"
  echo "    public ItemsForm() { InitializeComponent(); }"
  echo "  }"; echo "}"; } > "$ITEMS_SRC/Form.cs"
cat > "$ITEMS_SRC/I.csproj" <<'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <OutputType>Library</OutputType>
    <Nullable>disable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
CSPROJ
ITEMS_BUILD=$(cd "$ITEMS_SRC" && dotnet build -v q --nologo 2>&1)
if echo "$ITEMS_BUILD" | grep -q "Build succeeded"; then
  ok "the items fixture compiles as real WinForms controls"
else
  bad "items fixture FAILED to compile"
  echo "$ITEMS_BUILD" | grep -E "error" | head -4 | sed 's/^/        /'
fi

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
