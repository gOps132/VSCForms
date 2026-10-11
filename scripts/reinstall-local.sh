#!/usr/bin/env bash
# Rebuild the engine + extension, package the VSIX, and reinstall it into VS Code.
#
# Usage:
#   ./scripts/reinstall-local.sh [--skip-engine] [--no-install]
#
#   --skip-engine  reuse the existing extension/bin/ engine (TS-only changes)
#   --no-install   build + package only, do not call `code --install-extension`

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

SKIP_ENGINE=0
NO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-engine) SKIP_ENGINE=1 ;;
    --no-install) NO_INSTALL=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

if [ "$SKIP_ENGINE" -eq 0 ]; then
  echo "==> Building engine…"
  node ./scripts/publish-engine.js
else
  echo "==> Skipping engine build (--skip-engine)"
fi

echo "==> Packaging VSIX (compiles TypeScript)…"
node scripts/package-all.js

if [ "$NO_INSTALL" -eq 1 ]; then
  echo "==> Skipping install (--no-install)"
  exit 0
fi

VSIX="$(ls -t dist/vscforms-*.vsix 2>/dev/null | head -n 1 || true)"
if [ -z "${VSIX:-}" ] || [ ! -f "$VSIX" ]; then
  echo "==> Error: no VSIX found in dist/ after packaging." >&2
  exit 1
fi

if ! command -v code >/dev/null 2>&1; then
  echo "==> Error: 'code' CLI not found on PATH." >&2
  echo "    Install it via VS Code: Cmd+Shift+P -> 'Shell Command: Install code command in PATH'." >&2
  echo "    Built VSIX kept at: $VSIX" >&2
  exit 1
fi

echo "==> Installing $VSIX …"
code --install-extension "$VSIX" --force

echo "==> Done. Reload VS Code windows to pick up the new build."
