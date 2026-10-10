#!/usr/bin/env bash
# Drives the Windows layout tier from a macOS/Linux agent session via GitHub Actions.
#
# WHY THIS EXISTS
#   scripts/run-windows-layout.sh instantiates real WinForms controls, which needs the
#   Windows Desktop runtime: it SKIPs on macOS/Linux by design, and Wine cannot
#   substitute (modern WinForms fails at `new Form()` with a missing USER32 DPI entry
#   point — probed, not guessed). So the agent path to a layout verdict is CI: dispatch
#   the workflow, watch it, and report the `layout` job's conclusion loudly.
#
# WHAT IT REPORTS
#   Only the `layout` job gates the exit code — the jobs are independent (no `needs:`
#   edges), so a red engine/canvas/package job must neither mask a layout pass nor be
#   masked by it. Other jobs print as context.
#
# Usage:
#   ./scripts/layout-ci.sh [--ref BRANCH] [--watch | --no-watch] [--dry-run]
#
#   --ref BRANCH   dispatch against BRANCH (default: current git branch)
#   --watch        wait for completion and report the verdict (default)
#   --no-watch     dispatch only; print the run URL and exit 0
#   --dry-run      print the gh commands without running them
#
# Needs: gh (authenticated — see docs/agents/issue-tracker.md), jq (bundled with gh).

set -euo pipefail

REF="$(git branch --show-current 2>/dev/null || true)"
WATCH=1
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a branch}"; shift 2 ;;
    --watch) WATCH=1; shift ;;
    --no-watch) WATCH=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 1 ;;
  esac
done

[ -n "$REF" ] || { echo "ERROR: no branch (detached HEAD?). Pass --ref BRANCH." >&2; exit 1; }

if [ "$DRY" -eq 1 ]; then
  echo "# dry-run: no runs dispatched"
  echo "gh workflow run ci --ref \"$REF\""
  echo "gh run list --workflow=ci --branch=\"$REF\" --limit 5 --json databaseId,url,createdAt"
  echo "gh run watch <id> --exit-status"
  echo "gh run view <id> --json jobs"
  exit 0
fi

command -v gh >/dev/null || { echo "ERROR: 'gh' not on PATH." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh is not authenticated. Run: gh auth login" >&2; exit 1; }

START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "dispatching workflow 'ci' on ref '$REF' (after $START)…"
gh workflow run ci --ref "$REF"

# The new run takes a few seconds to appear; disambiguate from older runs by creation time.
ID=""
for _ in $(seq 1 12); do
  ID="$(gh run list --workflow=ci --branch="$REF" --limit 5 \
    --json databaseId,url,createdAt \
    --jq "map(select(.createdAt > \"$START\")) | sort_by(.createdAt) | last | .databaseId // empty")"
  [ -n "$ID" ] && break
  sleep 5
done
[ -n "$ID" ] || { echo "ERROR: no new run appeared within 60s (is CI enabled for '$REF'?)." >&2; exit 1; }

URL="$(gh run view "$ID" --json url --jq .url)"
echo "run: $URL"

if [ "$WATCH" -eq 0 ]; then
  exit 0
fi

# --exit-status fails on ANY red job; swallow it here and judge below — only the
# layout job's conclusion decides this script's exit code.
gh run watch "$ID" --exit-status >/dev/null 2>&1 || true

echo "job conclusions:"
gh run view "$ID" --json jobs --jq '.jobs[] | {name, conclusion}'

LAYOUT="$(gh run view "$ID" --json jobs --jq '[.jobs[] | select(.name=="layout") | .conclusion] | first // "unknown"' | tr -d '"')"
if [ "$LAYOUT" = "success" ]; then
  echo "layout verification passed ($URL)"
  exit 0
fi
echo "layout verification FAILED: layout job concluded '$LAYOUT' ($URL)" >&2
exit 1
