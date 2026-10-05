#!/usr/bin/env bash
# Verification for the two NON-classic Designer dialects.
#
# VSCForms reads three dialects, all of which occur in real projects:
#
#   classic   this.btn.Location = new System.Drawing.Point(1, 2);
#   templated this.btn.Location = new Point(1, 2);           implicit usings
#   bare      btn.Location = new Point(1, 2);                no `this.` anywhere
#
# `classic` is covered by test/verify.sh. This file covers the other two, which is where the
# parser previously failed silently — reporting a real form as empty at 100% coverage.
set -uo pipefail
cd "$(dirname "$0")/.."

ENGINE=./engine/bin/Debug/net10.0/vscforms-engine
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sect(){ echo; echo "== $1"; }

if [ ! -x "$ENGINE" ]; then echo "engine not built; run: dotnet build engine"; exit 1; fi

# ---------------------------------------------------------------- shared helpers
parse() { printf '{"id":1,"cmd":"parse","path":"%s"}\n' "$1" | "$ENGINE" 2>/dev/null; }
tweak() { # $1 = file, $2 = python body operating on schema `s`
  parse "$1" | python3 -c "
import json,sys
s=json.load(sys.stdin)['schema']
$2
print(json.dumps({'id':2,'cmd':'generate','path':'$1','schema':s}))" | "$ENGINE" 2>/dev/null
}
# No-op generate must never write.
assert_noop_identical() { # $1 label, $2 file
  cp "$2" /tmp/dial-orig.cs
  parse "$2" | python3 -c "
import json,sys
s=json.load(sys.stdin)['schema']
print(json.dumps({'id':2,'cmd':'generate','path':'$2','schema':s}))" | "$ENGINE" >/dev/null 2>&1
  if diff -q /tmp/dial-orig.cs "$2" >/dev/null; then ok "$1: untouched file is byte-identical"
  else bad "$1: no-op generate modified the file"; fi
}
# Inserted lines must match the file's indentation, and never mix line endings.
assert_formatting() { # $1 label, $2 file, $3 python regex prefix to check indent of
  OVER=$(python3 -c "
import re,sys
bad=0
for l in open('$2').read().split('\n'):
    l=l.rstrip('\r')
    m=re.match(r'^( +)($3)', l)
    if m and len(m.group(1))!=8: bad+=1
print(bad)")
  if [ "$OVER" -eq 0 ]; then ok "$1: inserted lines use the 8-space body indent"
  else bad "$1: $OVER inserted line(s) mis-indented"; fi

  if python3 -c "
import sys
def dom(p):
    d=open(p,'rb').read()
    c=d.count(b'\r\n'); f=d.count(b'\n')-c
    return ('crlf' if c>f else 'lf' if f else 'none'), f
a,mixed=dom('/tmp/dial-orig.cs'); b,_=dom('$2')
sys.exit(0 if a==b else 1)"; then ok "$1: line endings match the original file"
  else bad "$1: line endings changed"; fi
}
scaffold() { # $1 dir, $2 designer file, $3 form class, $4 namespace  — writes files, does NOT build
  cp "$2" "$1/"
  { echo "using System;"; echo "using System.Windows.Forms;"
    echo "namespace $4 {"; echo "  public partial class $3 : Form {"
    echo "    public $3() { InitializeComponent(); }"
    echo "  }"; echo "}"; } > "$1/Form.cs"
  cat > "$1/P.csproj" <<CSPROJ
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
}
assert_builds() { # $1 label, $2 dir
  OUT=$(cd "$2" && dotnet build -v q --nologo 2>&1)
  if echo "$OUT" | grep -q "Build succeeded"; then ok "$1: generated code compiles"
  else bad "$1: FAILED to compile"; echo "$OUT" | grep -E "error" | head -4 | sed 's/^/        /'; fi
}

# ================================================================ TEMPLATED
sect "[templated] bare-identifier form properties"
F=/tmp/mf-tpl/TemplatedForm.Designer.cs
rm -rf /tmp/mf-tpl && mkdir -p /tmp/mf-tpl && cp fixtures/templated/TemplatedForm.Designer.cs "$F"
parse "$F" | python3 -c "
import json,sys
d=json.load(sys.stdin)['schema']
assert d['form']['text']=='TemplatedForm', ('text', d['form']['text'])
assert d['form']['clientSize']=={'width':800,'height':450}, ('size', d['form'])
assert d['controls']==[], d['controls']
" && ok "reads Text and ClientSize with no this. qualifier" \
  || bad "templated form properties not parsed"
assert_noop_identical "templated" "$F"

sect "[templated] adding a control"
# A fresh template is genuinely ambiguous: it contains no `this.` at all, so the insert follows
# the BARE convention. Once the designer has touched it and written `this.`, inserts use `this.`
# — which the "this-style" case below covers.
tweak "$F" "
s['form']['text']='Renamed by VSCForms'
s['controls'].append({'id':'btnOk','type':'System.Windows.Forms.Button','children':[],
 'properties':{'x':300,'y':200,'width':90,'height':30,'text':'OK','tabIndex':0},'locked':False})
s['analysis']['modelledCount']+=1" >/dev/null
MISSING=""
for part in "private System.Windows.Forms.Button btnOk;" \
            "btnOk = new System.Windows.Forms.Button();" \
            "btnOk.Location = new System.Drawing.Point(300, 200);" \
            "btnOk.Name = \"btnOk\";" \
            "Controls.Add(btnOk);" \
            'Text = "Renamed by VSCForms";'; do
  grep -qF "$part" "$F" || MISSING="$MISSING\n        - $part"
done
[ -z "$MISSING" ] && ok "emits field, init, properties, Controls.Add and the renamed Text" \
                  || bad "templated add is missing parts:$MISSING"
assert_formatting "templated" "$F" 'this\.btnOk'
grep -q 'components = new System.ComponentModel.Container();' "$F" \
  && ok "templated: original statements survive" || bad "templated: insert damaged existing statements"

# ============================================= DECLARED STYLE (.editorconfig)
# The templated dialect is the one gap in dialect detection: it contains no control
# instantiations, so UsesThisPrefix is inferred from ABSENCE and is indistinguishable from a
# genuinely bare file. A user adding their first control to a fresh `dotnet new winforms` project
# therefore gets `this.` or bare based on nothing. Visual Studio decides this from
# dotnet_style_qualification_for_field, and so can we — as ADVISORY input that fills the gap
# and never overrides what the file demonstrates.
#
# Fixtures live in fixtures/declared/<case>/ and MUST be used in place: .editorconfig is
# discovered by walking up from the file, so copying the Designer file to /tmp would find
# nothing. That is not incidental — it is exactly what happens when a user opens a file.
declare_case() { # $1 case, $2 designer file
  rm -rf "/tmp/mf-decl-$1" && mkdir -p "/tmp/mf-decl-$1"
  cp "fixtures/declared/$1/.editorconfig" "/tmp/mf-decl-$1/"
  cp "$2" "/tmp/mf-decl-$1/"
}
add_button() { # add a control to $1 and write it
  tweak "$1" "
s['controls'].append({'id':'btnOk','type':'System.Windows.Forms.Button','children':[],
 'properties':{'x':300,'y':200,'width':90,'height':30,'text':'OK','tabIndex':0},'locked':False})
s['analysis']['modelledCount']+=1" >/dev/null
}
# The declared-style fixtures must be compiled in a real project too, not just diff-inspected.
scaffold_declared() { # $1 case dir, $2 form class, $3 namespace
  # scaffold copies the Designer file in; here it is already in place, so skip that step.
  local d="$1"
  { echo "using System;"; echo "using System.Windows.Forms;"
    echo "namespace $3 {"; echo "  public partial class $2 : Form {"
    echo "    public $2() { InitializeComponent(); }"
    echo "  }"; echo "}"; } > "$d/Form.cs"
  cat > "$d/P.csproj" <<CSPROJ
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
}

sect "[declared] config says qualify=true and the file has no evidence"
Q=/tmp/mf-decl-qualified/DeclaredForm.Designer.cs
declare_case qualified fixtures/declared/qualified/DeclaredForm.Designer.cs
add_button "$Q"
if grep -qF "this.btnOk = new System.Windows.Forms.Button();" "$Q"; then
  ok "insertion is this.-qualified, as declared"
else bad "declared qualify=true was ignored"; fi
if grep -qF "this.Controls.Add(this.btnOk);" "$Q"; then
  ok "Controls.Add is this.-qualified too"
else bad "declared qualify=true did not reach Controls.Add"; fi
scaffold_declared /tmp/mf-decl-qualified DeclaredForm FixtureDeclared
assert_builds "declared-qualified" /tmp/mf-decl-qualified

sect "[declared] config says qualify=false and the file has no evidence"
R=/tmp/mf-decl-bare/DeclaredForm.Designer.cs
declare_case bare fixtures/declared/bare/DeclaredForm.Designer.cs
add_button "$R"
if grep -qF "btnOk = new System.Windows.Forms.Button();" "$R" && ! grep -qF "this.btnOk" "$R"; then
  ok "insertion is bare, as declared"
else bad "declared qualify=false was ignored"; fi

sect "[declared] the FILE wins when it has evidence the config contradicts"
# This is the assertion that makes the whole feature safe. A file that demonstrates a
# convention must not be overridden by a config that disagrees with it — that would
# contradict ADR 0005, which commits us to writing in the file's own dialect.
C=/tmp/mf-decl-contradicts/DeclaredForm.Designer.cs
declare_case contradicts fixtures/declared/contradicts/DeclaredForm.Designer.cs
add_button "$C"
if grep -qF "btnOk = new System.Windows.Forms.Button();" "$C" && ! grep -qF "this.btnOk = new" "$C"; then
  ok "config says true but the bare file was preserved — the file wins"
else bad "a contradicting .editorconfig overrode the file's own dialect"; fi
if grep -qF "btnBare = new System.Windows.Forms.Button();" "$C"; then
  ok "the existing control's dialect is untouched"
else bad "the existing control was rewritten"; fi

sect "[declared] a malformed .editorconfig is ignored, not fatal"
M=/tmp/mf-decl-malformed/DeclaredForm.Designer.cs
declare_case malformed fixtures/declared/malformed/DeclaredForm.Designer.cs
if parse "$M" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d.get('ok'), d
assert d['schema']['form']['clientSize']=={'width':800,'height':450}
"; then ok "parses fine with a broken config beside it" || bad "a malformed .editorconfig broke parsing"; fi
add_button "$M"
# Nothing valid is declared: `true:warning` is an IDE severity, and the empty value is not an
# answer. So the insert falls back to the bare default, as it did before this feature existed.
if grep -qF "btnOk = new System.Windows.Forms.Button();" "$M"; then
  ok "severity forms are not read as intent — falls back to the default"
else bad "malformed config changed the insert shape"; fi

sect "[declared] discovery stops at the project root"
# A .editorconfig in a PARENT directory must not apply. Otherwise a machine-wide or
# organisation-wide config silently rewrites the dialect of every project on the machine.
N=/tmp/mf-decl-root
rm -rf "$N" && mkdir -p "$N/proj"
echo "root = true" > "$N/.editorconfig"
printf '[*.cs]\ndotnet_style_qualification_for_field = true\n' >> "$N/.editorconfig"
cp fixtures/declared/qualified/DeclaredForm.Designer.cs "$N/proj/"
# .git marks the boundary the same way a real checkout would.
mkdir -p "$N/proj/.git"
if parse "$N/proj/DeclaredForm.Designer.cs" >/dev/null 2>&1; then
  ok "a parent-directory config is ignored below a .git boundary"
else bad "discovery walked past the project root"; fi

# ================================================================ BARE
sect "[bare] no this. qualifier anywhere"
B=/tmp/mf-bare/BareForm.Designer.cs
rm -rf /tmp/mf-bare && mkdir -p /tmp/mf-bare && cp fixtures/bare/BareForm.Designer.cs "$B"
parse "$B" | python3 -c "
import json,sys
d=json.load(sys.stdin)['schema']
def allc(ns):
    for c in ns:
        yield c
        yield from allc(c['children'])
a=d['analysis']
assert d['form']['text']=='Bare dialect', d['form']
assert d['form']['clientSize']=={'width':400,'height':300}, d['form']
cs={c['id']:c for c in allc(d['controls'])}
assert set(cs)=={'pnlHost','bareButton','bareLabel','bareGauge'}, sorted(cs)
b=cs['bareButton']
assert b['properties']['x']==12 and b['properties']['y']==40, b['properties']
assert b['properties']['width']==100 and b['properties']['height']==30, b['properties']
assert b['properties']['text']=='Bare', b['properties']
# nesting: the three widgets live inside the panel
assert {c['id'] for c in cs['pnlHost']['children']}=={'bareButton','bareLabel','bareGauge'}, cs['pnlHost']['children']
assert cs['bareGauge']['locked'] is True, cs['bareGauge']
assert a['coveragePercent']==75.0 and a['unmodelledCount']==1, a
" && ok "reads form, controls, nesting and the locked third-party control" \
  || bad "bare dialect not parsed"
assert_noop_identical "bare" "$B"

sect "[bare] surgical move preserves the unqualified type style"
cp "$B" /tmp/dial-orig.cs
tweak "$B" "
for c in s['controls']:
    for k in c['children']:
        if k['id']=='bareButton': k['properties'].update(x=111,y=222,width=150,height=40)
" >/dev/null
if grep -q 'bareButton.Location = new Point(111, 222);' "$B"; then
  ok "kept 'new Point(...)' instead of rewriting to System.Drawing.Point"
else
  bad "rewrote the type name: $(grep -n 'bareButton.Location' "$B" | head -1)"
fi
if grep -q 'bareButton.Size = new Size(150, 40);' "$B"; then ok "Size also kept unqualified"
else bad "Size type name rewritten"; fi
CH=$(diff /tmp/dial-orig.cs "$B" | grep -c '^[<>]')
[ "$CH" -eq 4 ] && ok "exactly 2 lines changed (Location + Size)" \
               || bad "changed $((CH/2)) line(s), expected 2"

sect "[bare] locked controls are never written"
cp "$B" /tmp/dial-orig.cs
tweak "$B" "
for c in s['controls']:
    for k in c['children']:
        if k['id']=='bareGauge': k['properties'].update(x=1,y=1,width=2,height=2)
" >/dev/null
diff -q /tmp/dial-orig.cs "$B" >/dev/null \
  && ok "moving the locked gauge writes nothing at all" || bad "locked control was modified"

sect "[bare] adding a control"
cp "$B" /tmp/dial-orig.cs
tweak "$B" "
s['controls'].append({'id':'extraBtn','type':'System.Windows.Forms.Button','children':[],
 'properties':{'x':10,'y':260,'width':80,'height':25,'text':'Extra','tabIndex':9},'locked':False})
s['analysis']['modelledCount']+=1" >/dev/null
MISSING=""
for part in "private System.Windows.Forms.Button extraBtn;" \
            "extraBtn = new System.Windows.Forms.Button();" \
            "extraBtn.Location = new System.Drawing.Point(10, 260);" \
            "Controls.Add(extraBtn);"; do
  grep -qF "$part" "$B" || MISSING="$MISSING\n        - $part"
done
[ -z "$MISSING" ] && ok "emits field, instantiation, properties and Controls.Add" \
                  || bad "bare add is missing parts:$MISSING"
assert_formatting "bare" "$B" 'extraBtn'

# ================================================================ this-style
# The state Visual Studio leaves a project in after the designer has rewritten a fresh template:
# `this.` on the controls, bare identifiers on inherited Form members.
sect "[this-style] mixed convention follows the CONTROL convention"
T=/tmp/mf-this/ThisStyleForm.Designer.cs
rm -rf /tmp/mf-this && mkdir -p /tmp/mf-this && cp fixtures/thisstyle/ThisStyleForm.Designer.cs "$T"
cp "$T" /tmp/dial-orig.cs
tweak "$T" "
s['controls'].append({'id':'newBtn','type':'System.Windows.Forms.Button','children':[],
 'properties':{'x':10,'y':200,'width':90,'height':30,'text':'New','tabIndex':1},'locked':False})
s['analysis']['modelledCount']+=1" >/dev/null
MISSING=""
for part in "private System.Windows.Forms.Button newBtn;" \
            "this.newBtn = new System.Windows.Forms.Button();" \
            "this.newBtn.Location = new System.Drawing.Point(10, 200);" \
            "Controls.Add(this.newBtn);"; do
  grep -qF "$part" "$T" || MISSING="$MISSING\n        - $part"
done
[ -z "$MISSING" ] && ok "new control uses this. (file uses this. on controls)" \
                  || bad "this-style add is missing parts:$MISSING"
if grep -qF 'AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;' "$T"; then
  ok "existing bare form-level lines are left exactly as they were"
else bad "this-style add disturbed a form-level line"; fi
# The Controls collection itself is bare in this dialect, so the new Add must match it.
if grep -qF 'Controls.Add(this.newBtn);' "$T"; then
  ok "new Controls.Add follows the file's bare Controls convention"
else bad "new Controls.Add used the wrong convention: $(grep -n 'Controls.Add(this.newBtn)' "$T" | head -1)"; fi
assert_formatting "this-style" "$T" 'this\.newBtn'

# ================================================================ compile
sect "[compile] non-classic dialects build as real WinForms projects"
rm -rf /tmp/mf-b1 && mkdir -p /tmp/mf-b1
scaffold /tmp/mf-b1 "$F" TemplatedForm FixtureTemplated
assert_builds "/tmp/mf-b1 (templated)" /tmp/mf-b1

rm -rf /tmp/mf-b2 && mkdir -p /tmp/mf-b2
scaffold /tmp/mf-b2 "$B" BareForm FixtureBare
# The bare fixture declares a third-party control type. A Locked Control is still a real type
# the compiler must resolve, so the compile project needs a stub for it.
cat >> /tmp/mf-b2/Form.cs <<'STUB'
namespace Acme.Widgets { public class GaugeControl : System.Windows.Forms.Control { } }
STUB
assert_builds "/tmp/mf-b2 (bare)" /tmp/mf-b2

rm -rf /tmp/mf-b3 && mkdir -p /tmp/mf-b3
scaffold /tmp/mf-b3 "$T" ThisStyleForm FixtureThisStyle
assert_builds "/tmp/mf-b3 (this-style)" /tmp/mf-b3

echo
echo "dialect tier: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1