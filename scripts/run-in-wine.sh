#!/usr/bin/env bash
# Builds a WinForms project for Windows (win-x64) and runs it via Wine on macOS or Linux.
#
# Usage:
#   ./scripts/run-in-wine.sh [project-or-csproj] [arguments...]
#   ./scripts/open-in-wine.sh [project-or-csproj] [arguments...]
#
# Examples:
#   ./scripts/run-in-wine.sh                                  # runs example/
#   ./scripts/run-in-wine.sh example                          # runs example/
#   ./scripts/run-in-wine.sh path/to/MyFormApp.csproj
#   WINE=/path/to/wine ./scripts/run-in-wine.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Locate Wine
WINE_BIN=""
if [ -n "${WINE:-}" ] && command -v "$WINE" >/dev/null 2>&1; then
  WINE_BIN="$WINE"
elif [ -n "${WINE:-}" ] && [ -x "$WINE" ]; then
  WINE_BIN="$WINE"
else
  CANDIDATES=(
    "wine64"
    "wine"
    "/opt/homebrew/bin/wine64"
    "/opt/homebrew/bin/wine"
    "/usr/local/bin/wine64"
    "/usr/local/bin/wine"
    "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine64"
    "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine"
    "/Applications/Wine Devel.app/Contents/Resources/wine/bin/wine64"
    "/Applications/Wine Devel.app/Contents/Resources/wine/bin/wine"
    "/Applications/Wine Crossover.app/Contents/Resources/wine/bin/wine64"
    "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64"
  )
  for c in "${CANDIDATES[@]}"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then
      WINE_BIN="$c"
      break
    fi
  done
fi

if [ -z "$WINE_BIN" ]; then
  echo "==> Error: Wine was not found on your system." >&2
  echo "" >&2
  echo "To run WinForms applications on macOS, you need Wine." >&2
  echo "Recommended options to install Wine on macOS:" >&2
  echo "  1. Homebrew (Wine Crossover — recommended for Apple Silicon):" >&2
  echo "     brew tap gcenx/wine" >&2
  echo "     brew install --cask wine-crossover" >&2
  echo "" >&2
  echo "  2. Homebrew (Wine Stable):" >&2
  echo "     brew install --cask --no-quarantine wine-stable" >&2
  echo "" >&2
  echo "  3. Whisky (Free GUI wrapper for Wine + Apple GPTK):" >&2
  echo "     brew install --cask whisky" >&2
  echo "" >&2
  echo "  4. CrossOver (Commercial Wine by CodeWeavers)" >&2
  echo "" >&2
  echo "Or set the path to your wine binary manually:" >&2
  echo "     WINE=/path/to/wine ./scripts/run-in-wine.sh" >&2
  exit 1
fi

echo "==> Using Wine: $WINE_BIN"

# 2. Locate the project / csproj
TARGET="example"
if [ $# -gt 0 ] && [ -e "$1" ]; then
  TARGET="$1"
  shift
fi

CSPROJ=""
if [ -f "$TARGET" ] && [[ "$TARGET" == *.csproj ]]; then
  CSPROJ="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
elif [ -d "$TARGET" ]; then
  FOUND=$(find "$TARGET" -maxdepth 2 -name '*.csproj' | head -1)
  if [ -n "$FOUND" ]; then
    CSPROJ="$(cd "$(dirname "$FOUND")" && pwd)/$(basename "$FOUND")"
  fi
fi

if [ -z "$CSPROJ" ] || [ ! -f "$CSPROJ" ]; then
  echo "==> Error: Could not find a .csproj at '$TARGET'." >&2
  exit 1
fi

PROJ_NAME="$(basename "$CSPROJ" .csproj)"
echo "==> Target project: $CSPROJ"

# 3. Check dotnet SDK
if ! command -v dotnet >/dev/null 2>&1; then
  echo "==> Error: 'dotnet' command not found on PATH." >&2
  exit 1
fi

# 4. Publish self-contained Windows (win-x64) executable
OUT_DIR="${TMPDIR:-/tmp}/vscforms-wine/$PROJ_NAME"
echo "==> Publishing self-contained Windows application into $OUT_DIR..."
mkdir -p "$OUT_DIR"

dotnet publish "$CSPROJ" \
  -r win-x64 \
  -c Release \
  -p:EnableWindowsTargeting=true \
  --self-contained true \
  -o "$OUT_DIR" \
  --nologo \
  -v q

# Locate the output executable
EXE="$OUT_DIR/$PROJ_NAME.exe"
if [ ! -f "$EXE" ]; then
  EXE="$(find "$OUT_DIR" -maxdepth 1 -name '*.exe' ! -name 'createdump.exe' | head -1)"
fi

if [ -z "$EXE" ] || [ ! -f "$EXE" ]; then
  echo "==> Error: Built executable not found in $OUT_DIR." >&2
  exit 1
fi

echo "==> Ready: $EXE"

# 5. Execute with Wine
# macOS Apple Silicon W^X / JIT protection compatibility for CoreCLR under Rosetta/Wine
export DOTNET_EnableWriteXorExecute=0

# Suppress harmless Wine debug spam unless WINE_DEBUG is set
if [ -z "${WINE_DEBUG:-}" ]; then
  export WINEDEBUG="-all"
fi

echo "==> Launching in Wine..."
"$WINE_BIN" "$EXE" "$@"
