#!/usr/bin/env bash
# MacForms: full verification.
#
#   1. build the engine
#   2. Roslyn tier  — parse/refuse/surgical-patch invariants
#   3. compile tier — the generated C# builds as a real WinForms project
#   4. canvas       — DOM harness for the webview canvas
#   5. e2e          — canvas -> engine -> file, the real message contract
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
step() { echo; echo "########## $1"; }

step "build engine"
dotnet build engine -v q --nologo 2>&1 | grep -E "error|Build succ|Build FAIL" | sort -u || true
dotnet build engine -v q --nologo >/dev/null 2>&1 || { echo "engine build FAILED"; exit 1; }

step "build extension (typescript)"
(cd extension && npm run --silent compile) && echo "tsc OK" || { echo "tsc FAILED"; FAIL=1; }

step "roslyn + compile tiers"
./test/verify.sh || FAIL=1

step "Designer dialects (templated, bare, this-style)"
./test/verify-dialects.sh || FAIL=1

step "project generator"
./test/verify-generator.sh || FAIL=1

step "canvas harness"
node extension/test/hostHarness.js || FAIL=1

step "end-to-end"
node test/e2e.js || FAIL=1

# Real VS Code. Needs a display and the bundled engine, so it is opt-out via
# MACFORMS_SKIP_INTEGRATION=1 and skips cleanly on a headless machine.
step "integration (real VS Code)"
if [ "${MACFORMS_SKIP_INTEGRATION:-0}" = "1" ]; then
  echo "  SKIP  MACFORMS_SKIP_INTEGRATION=1"
elif ! ls extension/bin/*/macforms-engine* >/dev/null 2>&1; then
  echo "  SKIP  no bundled engine — run: node scripts/publish-engine.js"
else
  # Capture the summary line rather than grep-piping: VS Code's own logging interleaves with
  # the suite's output, and grep's exit status says nothing about whether tests passed.
  INT_LOG=$(mktemp)
  if node test/run-integration.js > "$INT_LOG" 2>&1; then
    grep -E "PASS|FAIL|rivals|integration:" "$INT_LOG"
  else
    grep -E "PASS|FAIL|rivals|integration:" "$INT_LOG"
    echo "  (integration suite failed; full log kept)"
    FAIL=1
  fi
  rm -f "$INT_LOG"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "############ ALL GREEN"; else echo "############ FAILURES PRESENT"; fi
exit "$FAIL"