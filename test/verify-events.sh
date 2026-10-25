#!/usr/bin/env bash
# Verifies event scaffolding and unwiring (ADR 0011).
# Tests dual-file surgical patching across Form.Designer.cs and Form.cs,
# dialect matching, method reuse, byte preservation, and real dotnet build.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
sect(){ echo; echo "== $1"; }

ENGINE=./engine/bin/Debug/net10.0/vscforms-engine
[ -x "$ENGINE" ] || {
  dotnet build engine -v q --nologo >/dev/null 2>&1 || true
}
if [ ! -x "$ENGINE" ]; then echo "engine not built; run: dotnet build engine"; exit 1; fi

WORK=$(mktemp -d)/events
mkdir -p "$WORK"
trap 'rm -rf "$(dirname "$WORK")"' EXIT

# stage <name> — copy the wired fixture into a scratch dir
stage() {
  local d="$WORK/$1"
  mkdir -p "$d"
  cp fixtures/wired/WiredForm.Designer.cs "$d/"
  cp fixtures/wired/WiredForm.cs "$d/"
  echo "$d"
}

stage_events() {
  local d="$WORK/$1"
  mkdir -p "$d"
  cp fixtures/events/EventsForm.Designer.cs "$d/"
  cp fixtures/events/EventsForm.cs "$d/"
  echo "$d"
}

wire_cmd() { # $1 dir, $2 ctrl, $3 event, $4 handler
  if [ -z "${4:-}" ]; then
    printf '{"id":1,"cmd":"wireEvent","path":"%s/WiredForm.Designer.cs","controlId":"%s","eventName":"%s"}\n' \
      "$1" "$2" "$3" | "$ENGINE" 2>/dev/null
  else
    printf '{"id":1,"cmd":"wireEvent","path":"%s/WiredForm.Designer.cs","controlId":"%s","eventName":"%s","handlerName":"%s"}\n' \
      "$1" "$2" "$3" "$4" | "$ENGINE" 2>/dev/null
  fi
}

wire_custom_file() { # $1 path, $2 ctrl, $3 event, $4 handler
  if [ -z "${4:-}" ]; then
    printf '{"id":1,"cmd":"wireEvent","path":"%s","controlId":"%s","eventName":"%s"}\n' \
      "$1" "$2" "$3" | "$ENGINE" 2>/dev/null
  else
    printf '{"id":1,"cmd":"wireEvent","path":"%s","controlId":"%s","eventName":"%s","handlerName":"%s"}\n' \
      "$1" "$2" "$3" "$4" | "$ENGINE" 2>/dev/null
  fi
}

unwire_cmd() { # $1 dir, $2 ctrl, $3 event
  printf '{"id":1,"cmd":"unwireEvent","path":"%s/WiredForm.Designer.cs","controlId":"%s","eventName":"%s"}\n' \
    "$1" "$2" "$3" | "$ENGINE" 2>/dev/null
}

unwire_custom_file() { # $1 path, $2 ctrl, $3 event
  printf '{"id":1,"cmd":"unwireEvent","path":"%s","controlId":"%s","eventName":"%s"}\n' \
    "$1" "$2" "$3" | "$ENGINE" 2>/dev/null
}

kind() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('errorKind','') if not d.get('ok') else 'ok')"; }
get_field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('$1',''))"; }

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

build_fails() { # $1 dir
  (cd "$1" && dotnet build -v q --nologo 2>&1)
}

sect "1. Existing handler reuse (idempotency)"
DIR=$(stage existing)
RES=$(wire_cmd "$DIR" "btnCalculate" "Click" "btnCalculate_Click")
K=$(echo "$RES" | kind)
CREATED=$(echo "$RES" | get_field createdMethod)
if [ "$K" = "ok" ] && [ "$CREATED" = "False" ]; then
  ok "wires to existing method without creating duplicate"
else
  bad "expected existing method reuse, got: $RES"
fi

sect "2. New event scaffolding with EventArgs"
DIR=$(stage new_event)
compile "$DIR"
RES=$(wire_cmd "$DIR" "btnCalculate" "MouseEnter" "btnCalculate_MouseEnter")
K=$(echo "$RES" | kind)
CREATED=$(echo "$RES" | get_field createdMethod)
TLINE=$(echo "$RES" | get_field targetLine)
if [ "$K" = "ok" ] && [ "$CREATED" = "True" ] && [ -n "$TLINE" ] && [ "$TLINE" -gt 0 ]; then
  ok "scaffolds new method with targetLine ($TLINE)"
else
  bad "scaffold failed, got: $RES"
fi

# Verify Form.cs contains the stub
if grep -q "private void btnCalculate_MouseEnter(object sender, EventArgs e)" "$DIR/WiredForm.cs"; then
  ok "Form1.cs contains expected method stub"
else
  bad "Form1.cs missing method stub"
fi

# Verify Designer contains the += wiring
if grep -q "btnCalculate.MouseEnter +=" "$DIR/WiredForm.Designer.cs"; then
  ok "Designer contains += wiring"
else
  bad "Designer missing += wiring"
fi

# Real compile gate
OUT=$(build_fails "$DIR")
if [ $? -eq 0 ]; then
  ok "scaffolded project compiles cleanly with 0 errors"
else
  bad "build failed: $OUT"
fi

sect "3. Typed event argument (MouseEventArgs)"
DIR=$(stage mouse_event)
compile "$DIR"
RES=$(wire_cmd "$DIR" "btnCalculate" "MouseDown" "btnCalculate_MouseDown")
K=$(echo "$RES" | kind)
if [ "$K" = "ok" ] && grep -q "private void btnCalculate_MouseDown(object sender, MouseEventArgs e)" "$DIR/WiredForm.cs"; then
  ok "scaffolds MouseEventArgs signature"
else
  bad "MouseEventArgs signature missing, got: $RES"
fi
OUT=$(build_fails "$DIR")
if [ $? -eq 0 ]; then
  ok "typed MouseEventArgs compiles cleanly"
else
  bad "MouseEventArgs build failed: $OUT"
fi

sect "4. Event unwiring (Reset)"
DIR=$(stage unwire)
compile "$DIR"
# Wire it first
wire_cmd "$DIR" "btnCalculate" "MouseEnter" "btnCalculate_MouseEnter" >/dev/null
# Unwire it
URES=$(unwire_cmd "$DIR" "btnCalculate" "MouseEnter")
UK=$(echo "$URES" | kind)
if [ "$UK" = "ok" ]; then
  ok "unwire command succeeds"
else
  bad "unwire failed: $URES"
fi

# Designer wiring must be removed
if grep -q "btnCalculate.MouseEnter +=" "$DIR/WiredForm.Designer.cs"; then
  bad "Designer still contains += after unwire"
else
  ok "Designer has wiring removed"
fi

# Form1.cs stub must be PRESERVED
if grep -q "private void btnCalculate_MouseEnter(object sender, EventArgs e)" "$DIR/WiredForm.cs"; then
  ok "Form1.cs stub is preserved after unwire (no data loss)"
else
  bad "Form1.cs stub was deleted"
fi

OUT=$(build_fails "$DIR")
if [ $? -eq 0 ]; then
  ok "project compiles cleanly after unwire"
else
  bad "build failed after unwire: $OUT"
fi

sect "5. Refusals"
DIR=$(stage missing_cb)
rm "$DIR/WiredForm.cs"
RES=$(wire_cmd "$DIR" "btnCalculate" "Click" "btnCalculate_Click")
K=$(echo "$RES" | kind)
if [ "$K" = "no-code-behind" ]; then
  ok "refuses when code-behind is missing (no-code-behind)"
else
  bad "expected no-code-behind, got: $RES"
fi

DIR=$(stage locked_ctl)
# In fa78a64 MonthCalendar became handled; use PropertyGrid as the unmodelled control for this test
python3 -c "
p = '$DIR/WiredForm.Designer.cs'
s = open(p).read().replace('System.Windows.Forms.MonthCalendar', 'System.Windows.Forms.PropertyGrid').replace('calDetails.DateSelected +=', '// calDetails.DateSelected +=')
open(p, 'w').write(s)
"
RES=$(wire_cmd "$DIR" "calDetails" "DateChanged" "calDetails_DateChanged")
K=$(echo "$RES" | kind)
if [ "$K" = "locked" ]; then
  ok "refuses when control is locked (PropertyGrid is unmodelled)"
else
  bad "expected locked, got: $RES"
fi

sect "6. Custom handler binding"
DIR=$(stage custom_handler)
compile "$DIR"
RES=$(wire_cmd "$DIR" "btnCalculate" "Click" "OnCalculateRequested")
K=$(echo "$RES" | kind)
if [ "$K" = "ok" ] && grep -q "private void OnCalculateRequested(object sender, EventArgs e)" "$DIR/WiredForm.cs"; then
  ok "scaffolds custom handler name OnCalculateRequested"
else
  bad "failed to scaffold custom handler name, got: $RES"
fi

if grep -q "btnCalculate.Click +=.*OnCalculateRequested" "$DIR/WiredForm.Designer.cs"; then
  ok "Designer wires to custom handler name"
else
  bad "Designer did not wire to custom handler name"
fi

OUT=$(build_fails "$DIR")
if [ $? -eq 0 ]; then
  ok "custom handler project compiles cleanly"
else
  bad "custom handler build failed: $OUT"
fi

sect "7. Schema event parsing"
PARSE_RES=$(printf '{"id":1,"cmd":"parse","path":"%s/WiredForm.Designer.cs"}\n' "$DIR" | "$ENGINE" 2>/dev/null)
WIRED_IN_SCHEMA=$(python3 -c "import json,sys; d=json.load(sys.stdin); c=next(x for x in d['schema']['controls'] if x['id']=='btnCalculate'); print(c.get('events',{}).get('Click',''))" <<< "$PARSE_RES")
if [ "$WIRED_IN_SCHEMA" = "OnCalculateRequested" ]; then
  ok "schema parse surfaces wired event handler in events dictionary"
else
  bad "schema parse missing wired event, got: '$WIRED_IN_SCHEMA'"
fi

sect "8. Dedicated fixtures/events suite with Form, TextBox, CheckBox"
EDIR=$(stage_events events_suite)
compile "$EDIR"
RES_FORM=$(wire_custom_file "$EDIR/EventsForm.Designer.cs" "EventsForm" "Load")
if [ "$(echo "$RES_FORM" | kind)" = "ok" ] && grep -q "private void EventsForm_Load(object sender, EventArgs e)" "$EDIR/EventsForm.cs"; then
  ok "scaffolds Form.Load handler into EventsForm.cs"
else
  bad "failed to scaffold Form.Load, got: $RES_FORM"
fi

if grep -q "this\.Load += new System\.EventHandler(this\.EventsForm_Load);" "$EDIR/EventsForm.Designer.cs"; then
  ok "Designer wires Form.Load"
else
  bad "Designer missing Form.Load wiring"
fi

RES_TXT=$(wire_custom_file "$EDIR/EventsForm.Designer.cs" "txtInput" "TextChanged")
if [ "$(echo "$RES_TXT" | kind)" = "ok" ] && grep -q "private void txtInput_TextChanged(object sender, EventArgs e)" "$EDIR/EventsForm.cs"; then
  ok "scaffolds TextBox.TextChanged handler into EventsForm.cs"
else
  bad "failed to scaffold TextBox.TextChanged, got: $RES_TXT"
fi

RES_CHK=$(wire_custom_file "$EDIR/EventsForm.Designer.cs" "chkOption" "CheckedChanged")
if [ "$(echo "$RES_CHK" | kind)" = "ok" ] && grep -q "private void chkOption_CheckedChanged(object sender, EventArgs e)" "$EDIR/EventsForm.cs"; then
  ok "scaffolds CheckBox.CheckedChanged handler into EventsForm.cs"
else
  bad "failed to scaffold CheckBox.CheckedChanged, got: $RES_CHK"
fi

EOUT=$(build_fails "$EDIR")
if [ $? -eq 0 ]; then
  ok "EventsForm project with multi-control event wirings compiles cleanly"
else
  bad "EventsForm build failed: $EOUT"
fi

sect "9. Byte-level preservation (CRLF/LF, indentation, line endings)"
CRLF_DIR="$WORK/crlf_check"
mkdir -p "$CRLF_DIR"
python3 -c "
for f in ['EventsForm.Designer.cs', 'EventsForm.cs']:
    txt = open('fixtures/events/' + f, 'r', encoding='utf-8').read().replace('\r\n', '\n').replace('\n', '\r\n')
    open('$CRLF_DIR/' + f, 'wb').write(txt.encode('utf-8'))
"
compile "$CRLF_DIR"
wire_custom_file "$CRLF_DIR/EventsForm.Designer.cs" "txtInput" "TextChanged" >/dev/null
CRLF_CHECK=$(python3 -c "
def check_crlf(p):
    d = open(p, 'rb').read()
    if b'\r\n' not in d: return False
    return b'\n' not in d.replace(b'\r\n', b'')
d_ok = check_crlf('$CRLF_DIR/EventsForm.Designer.cs')
c_ok = check_crlf('$CRLF_DIR/EventsForm.cs')
print('ok' if (d_ok and c_ok) else 'fail')
")
if [ "$CRLF_CHECK" = "ok" ]; then
  ok "CRLF line endings preserved across both files"
else
  bad "CRLF line endings were not preserved"
fi

echo
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ] || exit 1
