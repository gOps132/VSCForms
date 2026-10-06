#!/usr/bin/env bash
# Verifies control rename — the ONE operation that leaves the Designer File.
#
# WHY THIS TIER EXISTS AT ALL
#   Every other tier builds the Designer file against a GENERATED Form1.cs shim with no handler
#   wiring. A rename that updated only the Designer File would leave `CS1061` in the user's
#   project, after they saved, and every one of those tiers would still pass. This tier compiles
#   against a fixture whose code-behind really does wire `Click +=`, which is the only way the
#   dangling-reference bug is detectable at all.
#
# THE RULE (docs/adr/0008-rename-boundary.md)
#   Designer File: every reference.
#   Code-behind:   only where the identifier is the receiver of a member access.
#   Anywhere else: REFUSE, naming file and line. Never a guess.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sect(){ echo; echo "== $1"; }

ENGINE=./engine/bin/Debug/net10.0/vscforms-engine
[ -x "$ENGINE" ] || { echo "SKIP  engine not built"; exit 0; }

WORK=$(mktemp -d)/rename
mkdir -p "$WORK"
trap 'rm -rf "$(dirname "$WORK")"' EXIT

# stage <name> — copy the wired fixture (Designer + code-behind) into a scratch dir
stage() {
  local d="$WORK/$1"
  mkdir -p "$d"
  cp fixtures/wired/WiredForm.Designer.cs "$d/"
  cp fixtures/wired/WiredForm.cs "$d/"
  echo "$d"
}
rename_cmd() { # $1 dir, $2 from, $3 to  -> response on stdout
  printf '{"id":1,"cmd":"rename","path":"%s/WiredForm.Designer.cs","from":"%s","to":"%s"}\n' \
    "$1" "$2" "$3" | "$ENGINE" 2>/dev/null
}
kind() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('errorKind','') if not d.get('ok') else 'ok')"; }
build_fails() { # $1 dir — compile the pair for real
  (cd "$1" && dotnet build -v q --nologo 2>&1)
}
compile() { # $1 dir -> writes a csproj next to the fixture
  cat > "$1/W.csproj" <<'CSPROJ'
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

sect "the fixture itself compiles — otherwise nothing below means anything"
D=$(stage base)
compile "$D"
if build_fails "$D" | grep -q "Build succeeded"; then
  ok "the wired fixture builds before any rename"
else
  bad "the fixture does not compile; every assertion below would be vacuous"
  build_fails "$D" | grep -E "error" | head -4 | sed 's/^/        /'
fi

sect "a rename updates BOTH files and the result still compiles"
D=$(stage happy)
compile "$D"
R=$(rename_cmd "$D" btnCalculate btnCompute)
[ "$(echo "$R" | kind)" = "ok" ] && ok "rename accepted" || bad "rename refused: $(echo "$R" | kind)"

if grep -qF "private System.Windows.Forms.Button btnCompute;" "$D/WiredForm.Designer.cs"; then
  ok "field declaration renamed in the Designer File"
else bad "field declaration not renamed"; fi

if grep -qF "this.btnCompute = new System.Windows.Forms.Button();" "$D/WiredForm.Designer.cs"; then
  ok "instantiation renamed"
else bad "instantiation not renamed"; fi

if grep -qF 'this.btnCompute.Name = "btnCompute";' "$D/WiredForm.Designer.cs"; then
  ok "property assignment renamed, and the Name literal with it"
else bad "property assignment or Name literal not renamed"; fi

if grep -qF "this.btnCompute.Click += new System.EventHandler(this.btnCalculate_Click);" "$D/WiredForm.Designer.cs"; then
  ok "event wiring inside the Designer File is renamed"
else bad "event wiring in the Designer File not renamed"; fi

# The whole point. `btnCalculate.Enabled` lives in the HAND-WRITTEN code-behind; without this
# rewrite the user gets CS1061 in their own project, after they saved.
if grep -qF "btnCompute.Enabled = false;" "$D/WiredForm.cs"; then
  ok "code-behind member-access receiver renamed"
else bad "code-behind receiver NOT renamed — this is the CS1061 bug"; fi

if grep -qF "private void btnCalculate_Click(" "$D/WiredForm.cs"; then
  ok "the HANDLER name is untouched — it is a method, not a control"
else bad "the handler method was renamed, which would break the build"; fi

if grep -oF "btnCalculate" "$D/WiredForm.Designer.cs" | wc -l | tr -d ' ' | grep -qx 0; then
  ok "no trace of the old name remains in the Designer File"
else
  # Exactly two survivors are correct, and both are deliberate:
  #   btnCalculate_Click  the HANDLER method — a method, not the control. Rewriting it breaks
  #                       the wiring, and it is the user's naming choice.
  #   btnCalculate        the `// btnCalculate` comment header Visual Studio writes above each
  #                       control. Comments are never rewritten — matching VS's own rename,
  #                       which leaves them stale too.
  # Anything else means the rename leaked somewhere it should not have.
  LEFT=$(grep -o "[A-Za-z_]*btnCalculate[A-Za-z_]*" "$D/WiredForm.Designer.cs" | sort -u | tr '\n' ' ')
  if [ "$LEFT" = "btnCalculate btnCalculate_Click " ]; then
    ok "only the handler method and the comment header keep the old name, both by design"
  else
    bad "the old name survives as: $LEFT"
  fi
fi

if build_fails "$D" | grep -q "Build succeeded"; then
  ok "the renamed pair still compiles as a real WinForms project"
else
  bad "the rename left a dangling reference"
  build_fails "$D" | grep -E "error" | head -4 | sed 's/^/        /'
fi

sect "the rename is surgical — only the identifier moves"
D=$(stage surgical)
cp "$D/WiredForm.Designer.cs" "$WORK/d-before.cs"
cp "$D/WiredForm.cs" "$WORK/c-before.cs"
rename_cmd "$D" btnCalculate btnCompute >/dev/null

# Every changed line must differ ONLY in the identifier, and the line count must not move.
python3 - "$WORK/d-before.cs" "$D/WiredForm.Designer.cs" "$WORK/c-before.cs" "$D/WiredForm.cs" <<'PY' \
  && ok "every changed line differs only by the identifier" || bad "rename moved more than the name"
import sys
a1, b1, a2, b2 = sys.argv[1:5]
bad = 0
changed_total = 0
for before, after in ((a1, b1), (a2, b2)):
    A = open(before).read().split('\n')
    B = open(after).read().split('\n')
    if len(A) != len(B):
        print(f'  line count changed: {len(A)} -> {len(B)}'); bad += 1
    for i, (x, y) in enumerate(zip(A, B)):
        if x == y: continue
        changed_total += 1
        # Two things embed the old name and are deliberately left alone: the handler method
        # name, and the `// btnCalculate` comment header VS writes above each control. Normalise
        # both away before asking "did anything move other than the identifier?".
        def norm(s):
            return s.replace('btnCalculate_Click', 'HANDLER').replace('// btnCalculate', '// CTRLCOMMENT')
        if norm(x).replace('btnCalculate', 'btnCompute') != norm(y):
            print(f'  line {i+1} changed beyond the identifier:\n    - {x}\n    + {y}'); bad += 1
# A diff check that finds nothing changed is vacuously true, so require that it saw work.
if changed_total < 5:
    print(f'  only {changed_total} line(s) changed — the check is not proving anything'); bad += 1
sys.exit(1 if bad else 0)
PY

sect "MF_DEBUG=1 lists the spans the rename emitted"
D=$(stage spans)
SPANS=$(MF_DEBUG=1 printf '{"id":1,"cmd":"rename","path":"%s/WiredForm.Designer.cs","from":"btnCalculate","to":"btnCompute"}\n' \
  "$D" | MF_DEBUG=1 "$ENGINE" 2>&1 >/dev/null | grep -c "^  change ")
if [ "$SPANS" -ge 5 ]; then
  ok "MF_DEBUG=1 printed $SPANS span(s) — 'what exactly did you change?' has an answer"
else bad "MF_DEBUG=1 printed $SPANS span(s); expected at least 5"; fi

sect "a verbatim identifier is refused, not silently skipped"
# `@btnCalculate` in the code-behind is a receiver we CANNOT rewrite — dropping the `@` would
# turn a legal identifier into a keyword. Accepting it would report success while leaving a
# dangling reference behind, which is the exact bug this whole operation exists to prevent.
D=$(stage verbatim)
python3 - "$D/WiredForm.cs" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8-sig').read()
s = s.replace('btnCalculate.Enabled = false;', 'this.@btnCalculate.Enabled = false;')
open(p, 'w', encoding='utf-8', newline='').write(s)
PY
K=$(rename_cmd "$D" btnCalculate btnCompute | kind)
[ "$K" = "ambiguous-reference" ] && ok "refuses a verbatim identifier ($K)" \
                               || bad "reported success while leaving a dangling reference (got '$K')"
if grep -qF "this.@btnCalculate" "$D/WiredForm.cs"; then
  ok "the code-behind is untouched"
else bad "a refused rename modified the code-behind"; fi

sect "the rename preserves encoding in BOTH files"
D=$(stage encoding)
python3 - "$D/WiredForm.Designer.cs" "$D/WiredForm.cs" <<'PY'
# Give the fixture a BOM and CRLF, as Visual Studio writes, so a text-mode rewrite would show.
import sys
for p in sys.argv[1:]:
    raw = open(p, 'rb').read()
    t = raw.decode('utf-8-sig').replace('\r\n', '\n').replace('\n', '\r\n')
    open(p, 'wb').write(b'\xef\xbb\xbf' + t.encode('utf-8'))
PY
rename_cmd "$D" btnCalculate btnCompute >/dev/null
python3 - "$D/WiredForm.Designer.cs" "$D/WiredForm.cs" <<'PY' \
  && ok "BOM and CRLF survive in the Designer File and the code-behind" || bad "encoding changed"
import sys
for p in sys.argv[1:]:
    d = open(p, 'rb').read()
    if d[:3] != b'\xef\xbb\xbf': print(f'  {p}: BOM lost'); sys.exit(1)
    if d.count(b'\n') != d.count(b'\r\n'): print(f'  {p}: some lines became LF'); sys.exit(1)
PY

sect "refusals leave BOTH files byte-identical"
D=$(stage refuse_ambiguous)
# A local variable of the same name. `btnCalculate.Click` still qualifies, but this does not,
# and rewriting it would change what the code means.
python3 - "$D/WiredForm.cs" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8-sig').read()
s = s.replace("""        lblResult.Text = level.ToString("F2");""",
              """        var btnCalculate = 42;   // a local, not the control
        lblResult.Text = (btnCalculate + level).ToString("F2");""")
open(p, 'w', encoding='utf-8', newline='').write(s)
PY
cp "$D/WiredForm.Designer.cs" "$WORK/r-d.cs"; cp "$D/WiredForm.cs" "$WORK/r-c.cs"
K=$(rename_cmd "$D" btnCalculate btnCompute | kind)
[ "$K" = "ambiguous-reference" ] && ok "refuses an ambiguous code-behind reference ($K)" \
                               || bad "accepted an ambiguous reference (got '$K')"
if diff -q "$WORK/r-d.cs" "$D/WiredForm.Designer.cs" >/dev/null \
   && diff -q "$WORK/r-c.cs" "$D/WiredForm.cs" >/dev/null; then
  ok "neither file was written"
else bad "a refused rename still modified a file"; fi

if rename_cmd "$D" btnCalculate btnCompute | python3 -c "import json,sys;print(json.load(sys.stdin).get('error',''))" \
   | grep -q "WiredForm.cs"; then
  ok "the refusal names the file so the user knows where to look"
else bad "the refusal does not name the file"; fi

sect "other refusals"
D=$(stage refuse_locked)
# `calDetails` is a MonthCalendar, which is genuinely unmodelled.
# This assertion is also a canary: if a future change adds MonthCalendar to the Handled Types, the
# fixture stops being locked and this case goes `not-found` instead of `locked` — which is a
# reminder that the fixture's subject needs rechoosing, not a bug in the renamer.
K=$(rename_cmd "$D" calDetails calMore | kind)
[ "$K" = "locked" ] && ok "refuses to rename a Locked Control ($K)" || bad "renamed a locked control (got '$K')"

K=$(rename_cmd "$D" lblResult btnCalculate | kind)
[ "$K" = "conflict" ] && ok "refuses a name that already exists ($K)" || bad "allowed a duplicate name (got '$K')"

K=$(rename_cmd "$D" btnCalculate "9Bad" | kind)
[ "$K" = "bad-rename" ] && ok "refuses an invalid identifier ($K)" || bad "accepted '9Bad' (got '$K')"

K=$(rename_cmd "$D" btnCalculate btnCalculate | kind)
[ "$K" = "bad-rename" ] && ok "refuses a no-op rename ($K)" || bad "accepted a no-op (got '$K')"

K=$(rename_cmd "$D" noSuchControl other | kind)
[ "$K" = "not-found" ] && ok "refuses a control that is not there ($K)" || bad "invented a control (got '$K')"

sect "a refused FORM cannot be renamed at all"
# ADR 0003: we decline to write these forms, so we decline to rename them too.
D=$(stage refuse_form)
cp fixtures/docked/DockedForm.Designer.cs "$D/Docked.Designer.cs"
cp "$D/WiredForm.Designer.cs" "$D/Docked.Designer.cs"
cat > "$D/Docked.cs" <<'EOF'
namespace FixtureDocked;
public partial class Docked : System.Windows.Forms.Form
{
    public Docked() { InitializeComponent(); }
}
EOF
cp "$D/WiredForm.Designer.cs" /dev/null 2>/dev/null
python3 - "$D/Docked.Designer.cs" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
# Add a Dock so the form refuses.
s = s.replace("this.btnCalculate.UseVisualStyleBackColor = true;",
              "this.btnCalculate.UseVisualStyleBackColor = true;\n        this.btnCalculate.Dock = System.Windows.Forms.DockStyle.Fill;")
open(p, 'w', encoding='utf-8', newline='').write(s)
PY
cp "$D/Docked.Designer.cs" "$WORK/docked-before.cs"
K=$(printf '{"id":1,"cmd":"rename","path":"%s/Docked.Designer.cs","from":"btnCalculate","to":"btnCompute"}\n' \
    "$D" | "$ENGINE" 2>/dev/null | kind)
[ "$K" = "refused" ] && ok "refuses a form that is itself refused ($K)" || bad "renamed a refused form (got '$K')"
diff -q "$WORK/docked-before.cs" "$D/Docked.Designer.cs" >/dev/null \
  && ok "the refused form is untouched" || bad "a refused rename modified the form"

sect "renaming every control in turn keeps the project compiling"
D=$(stage all)
compile "$D"
# btnCalculate -> wired from the code-behind; lblResult -> referenced in a handler body.
for pair in "btnCalculate btnCompute" "lblResult lblOutcome"; do
  set -- $pair
  rename_cmd "$D" "$1" "$2" >/dev/null
done
# lblResult is used as `lblResult.Text = ...` in a handler — a member-access receiver, so it is
# exactly the shape the rule permits. If this ever refuses, the rule is too strict.
if build_fails "$D" | grep -q "Build succeeded"; then
  ok "sequential renames of a wired and a read control both compile"
else
  bad "sequential renames broke the build"
  build_fails "$D" | grep -E "error" | head -4 | sed 's/^/        /'
fi

echo
echo "rename tier: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1