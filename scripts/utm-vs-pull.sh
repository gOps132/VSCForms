#!/usr/bin/env bash
# Pull Form1.Designer.cs edited by Visual Studio in the UTM Windows guest,
# compare it against the original, and run the VSCForms engine parser/analysis on it.
#
# USAGE
#   scripts/utm-vs-pull.sh [project-name]
set -euo pipefail
cd "$(dirname "$0")/.."

PROJ_NAME="${1:-VSParitySandbox}"
SHARED_HOST_DIR="${SHARED_HOST_DIR:-$HOME/dev/shared/windows11}"
HOST_FILE="$SHARED_HOST_DIR/$PROJ_NAME/Form1.Designer.cs"
PULLED_FILE="/tmp/vs-$PROJ_NAME-Form1.Designer.cs"

echo "=== Pulling Form1.Designer.cs from UTM Guest ==="
./scripts/utm-guest.sh pull "$PROJ_NAME\\Form1.Designer.cs" "$PULLED_FILE"

echo "=== VSCForms Engine Analysis on Visual Studio Output ==="
printf '{"id":1,"cmd":"parse","path":"%s"}\n' "$PULLED_FILE" \
  | ./engine/bin/Debug/net10.0/vscforms-engine

echo "=== Diff vs Host Baseline (what Visual Studio changed/formatted) ==="
diff -u "$HOST_FILE" "$PULLED_FILE" || true
