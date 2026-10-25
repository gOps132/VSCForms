#!/usr/bin/env bash
# Stage a WinForms project from the host shared folder into the UTM Windows guest,
# verify that it builds on local NTFS (avoiding the WebDAV recursive globbing trap),
# and open it in Visual Studio.
#
# USAGE
#   scripts/utm-vs-open.sh [project-name]
#   scripts/utm-vs-open.sh VSParitySandbox
#
# ENVIRONMENT
#   SHARED_HOST_DIR   Path to shared folder on macOS. Default: ~/dev/shared/windows11
#   VSCFORMS_UTM_VM   UTM VM name. Default: Windows
set -euo pipefail
cd "$(dirname "$0")/.."

VM="${VSCFORMS_UTM_VM:-Windows}"
SHARED_HOST_DIR="${SHARED_HOST_DIR:-$HOME/dev/shared/windows11}"
PROJ_NAME="${1:-VSParitySandbox}"

if [ ! -d "$SHARED_HOST_DIR/$PROJ_NAME" ]; then
  echo "ERROR project '$PROJ_NAME' not found in $SHARED_HOST_DIR" >&2
  exit 1
fi

echo "=== UTM Visual Studio Sync ==="
echo "Host project:   $SHARED_HOST_DIR/$PROJ_NAME"
echo "Target guest:   C:\\Users\\Public\\$PROJ_NAME"

IP=$(./scripts/utm-guest.sh ip)
echo "Guest IP:       $IP"

# Generate guest stage script
TMP_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/utm-stage-XXXXXX.ps1")
cat <<'EOF' > "$TMP_SCRIPT"
param([string]$ProjName)
$ErrorActionPreference = "Stop"
$ProjName = $ProjName.Trim('"').Trim("'")

$src = "Z:\$ProjName"
$dst = "C:\Users\Public\$ProjName"

if (-not (Test-Path $src)) {
    Write-Error "Source path $src not found on Z: drive"
}

Write-Host "Syncing from Z:\$ProjName to $dst..."
if (-not (Test-Path $dst)) {
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
}
Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force

# Also sync .sln if it sits in root of share
$slnSrc = "Z:\$ProjName.sln"
if (Test-Path $slnSrc) {
    Copy-Item -Path $slnSrc -Destination "C:\Users\Public\$ProjName.sln" -Force
}

Write-Host "Verifying dotnet build on native NTFS..."
$csproj = Get-ChildItem -Path $dst -Filter "*.csproj" | Select-Object -First 1 -ExpandProperty FullName
dotnet build $csproj

$slnDst = "C:\Users\Public\$ProjName.sln"
if (-not (Test-Path $slnDst)) {
    $slnDst = (Get-ChildItem -Path $dst -Filter "*.sln" | Select-Object -First 1 -ExpandProperty FullName)
}

$vsPath = "${env:ProgramFiles}\Microsoft Visual Studio\18\Community\Common7\IDE\devenv.exe"
if (-not (Test-Path $vsPath)) {
    $vsPath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsPath) {
        $vsPath = (& $vsPath -latest -property productPath)
    }
}

if (Test-Path $vsPath) {
    Write-Host "Launching Visual Studio with $slnDst..."
    Start-Process $vsPath -ArgumentList "`"$slnDst`""
    Start-Sleep -Seconds 3
    Get-Process devenv | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize
} else {
    Write-Warning "Visual Studio executable not found at $vsPath"
}
Write-Host "Stage and launch complete."
EOF

chmod +x "$TMP_SCRIPT"
echo "Pushing and executing staging script in guest..."
./scripts/utm-guest.sh run "$TMP_SCRIPT" "$PROJ_NAME"
rm -f "$TMP_SCRIPT"

echo "=== Visual Studio WinForms Designer Ready in UTM ==="
