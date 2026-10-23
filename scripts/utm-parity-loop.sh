#!/usr/bin/env bash
# Continuous Parity Loop Agent for UTM Windows Guest & Visual Studio WinForms Designer.
#
# Watches for saves in Visual Studio, captures screen snapshots, pulls the modified
# .Designer.cs, runs the VSCForms Roslyn engine, and diffs AST & properties.
#
# USAGE
#   scripts/utm-parity-loop.sh [--once] [project-name]
#
# OPTIONS
#   --once        Run a single comparison cycle and exit immediately.
#   --watch       Continuously monitor for changes (default).
#   project-name  Target project in C:\Users\Public. Default: VSParitySandbox
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="watch"
if [ "${1:-}" = "--once" ]; then
  MODE="once"
  shift
elif [ "${1:-}" = "--watch" ]; then
  MODE="watch"
  shift
fi

PROJ_NAME="${1:-VSParitySandbox}"
OUT_DIR="out/parity-loop/$PROJ_NAME"
mkdir -p "$OUT_DIR"

echo "=== Visual Studio Parity Loop Agent ==="
echo "Project: $PROJ_NAME"
echo "Output:  $OUT_DIR"

# Verify guest reachability
IP=$(./scripts/utm-guest.sh ip)
echo "Guest IP: $IP"

get_utm_window_id() {
  swift -e '
import Cocoa
if let infoList = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] {
    for info in infoList {
        let owner = info[kCGWindowOwnerName as String] as? String ?? ""
        let name = info[kCGWindowName as String] as? String ?? ""
        let wid = info[kCGWindowNumber as String] as? Int ?? 0
        if owner.contains("UTM") && name.contains("Windows") {
            print(wid)
            exit(0)
        }
    }
}
exit(1)
' 2>/dev/null || echo "62203"
}

get_guest_mtime() {
  local check_script="/tmp/vscforms-check-mtime-$$.ps1"
  cat <<'EOF' > "$check_script"
param([string]$Proj)
$Proj = $Proj.Trim('"').Trim("'")
$path = "C:\Users\Public\$Proj\Form1.Designer.cs"
if (Test-Path $path) {
    (Get-Item $path).LastWriteTimeUtc.ToString("o")
} else {
    Write-Output "NOT_FOUND"
}
EOF
  ./scripts/utm-guest.sh run "$check_script" "$PROJ_NAME" | tr -d '\r\n'
  rm -f "$check_script"
}

capture_cycle() {
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)
  local snap_img="$OUT_DIR/snapshot-$timestamp.png"
  local snap_cs="$OUT_DIR/Form1-$timestamp.Designer.cs"
  local snap_json="$OUT_DIR/analysis-$timestamp.json"

  echo ""
  echo ">>> [CYCLE $timestamp] Capturing Visual Studio parity state..."

  # 1. Capture screen
  local wid
  wid=$(get_utm_window_id)
  if [ -n "$wid" ]; then
    screencapture -l"$wid" "$snap_img" 2>/dev/null || true
    if [ -f "$snap_img" ]; then
      echo "  [+] Captured UTM screen: $snap_img"
    fi
  fi

  # 2. Pull .Designer.cs
  ./scripts/utm-guest.sh pull "$PROJ_NAME\\Form1.Designer.cs" "$snap_cs" >/dev/null
  echo "  [+] Pulled .Designer.cs: $snap_cs"

  # 3. Parse with engine
  echo "  [+] Running VSCForms engine analysis..."
  local engine_res
  engine_res=$(printf '{"id":1,"cmd":"parse","path":"%s"}\n' "$snap_cs" | ./engine/bin/Debug/net10.0/vscforms-engine)
  echo "$engine_res" > "$snap_json"

  # 4. Extract coverage and analysis
  python3 - <<EOF
import json, sys

try:
    with open("$snap_json", "r") as f:
        data = json.load(f)
    if data.get("ok"):
        analysis = data["schema"]["analysis"]
        controls = data["schema"]["controls"]
        form = data["schema"]["form"]
        print(f"  [+] Engine parse: OK | Form: '{form.get('text', '')}' ({form['clientSize']['width']}x{form['clientSize']['height']})")
        print(f"  [+] Coverage: {analysis.get('coveragePercent', 0)}% ({analysis.get('modelledCount', 0)} modelled, {analysis.get('unmodelledCount', 0)} unmodelled)")
        if analysis.get("refuses"):
            print(f"  [!] REFUSALS DETECTED: {analysis['refuses']}")
        if analysis.get("warnings"):
            print(f"  [*] Warnings: {analysis['warnings']}")
    else:
        print(f"  [!] Engine parse FAILED: {data.get('error', 'unknown error')}")
except Exception as e:
    print(f"  [!] Analysis error: {e}")
EOF

  # 5. Diff against baseline
  local host_base="$HOME/dev/shared/windows11/$PROJ_NAME/Form1.Designer.cs"
  if [ -f "$host_base" ]; then
    echo "  [+] Diff vs host baseline:"
    diff -u "$host_base" "$snap_cs" | head -30 || true
  fi
}

echo "Recording initial baseline..."
LAST_MTIME=$(get_guest_mtime)
echo "Current guest file mtime: $LAST_MTIME"
capture_cycle

if [ "$MODE" = "once" ]; then
  echo "Single cycle complete."
  exit 0
fi

echo ""
echo "=== Monitoring for Visual Studio saves in UTM guest (Press Ctrl+C to stop) ==="
while true; do
  sleep 3
  CURRENT_MTIME=$(get_guest_mtime)
  if [ "$CURRENT_MTIME" != "$LAST_MTIME" ] && [ "$CURRENT_MTIME" != "NOT_FOUND" ]; then
    echo ""
    echo ">>> Change detected in Visual Studio! (Mtime: $CURRENT_MTIME vs $LAST_MTIME)"
    LAST_MTIME="$CURRENT_MTIME"
    capture_cycle
  fi
done
