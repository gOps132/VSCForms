#!/usr/bin/env bash
# The differential-matrix tier.
#
# WHAT IT IS
#   The engine is driven over a DETERMINISTIC PERMUTATION MATRIX — every handled
#   control type x every property the canvas offers x every Designer dialect x every
#   container hierarchy — and every generated file is checked for four things:
#
#     structure   it parses, refuses nothing, models 100% of its controls, nests its
#                 children where the file says, and round-trips byte-identically
#     properties  every property has BOTH an insert path (the control does not have
#                 the property yet) and a replace path, in the file's own dialect,
#                 touching nothing else
#     form        the form-level properties, in all four dialects including templated
#     compile     the patched files build as a real WinForms project
#
# WHY IT IS A SEPARATE TIER
#   Every other tier tests the fixtures someone thought to write. This one tests the
#   CROSS-PRODUCT. A property the fixtures forgot is still measured — which is how
#   `BackColor` and `Font` shipped without an insert path, and how the TextBox
#   `TextAlign` bug survived every other tier: nothing set a TextBox's TextAlign.
#
# WHY IT RUNS EVERYWHERE
#   The engine half needs no Windows. Only the runtime-comparison half (the layout tier
#   in scripts/run-windows-layout.sh) does. So this tier runs on every platform and in
#   every CI job, and the Windows-only oracle runs beside it.
#
# THE FIXTURE-FIRST GATE
#   A divergence is not fixed here. It is reported with the exact expected-vs-actual
#   diff, the offending Designer file is copied to `fixtures/differential/`, and the
#   `gh issue create` command is printed. The gate does not commit and does not open
#   the issue: CI has no push authority, and a printed command a human can read beats
#   a bot-written issue.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
step() { echo; echo "########## $1"; }

ENGINE=./engine/bin/Debug/net10.0/vscforms-engine
if [ ! -x "$ENGINE" ]; then
  echo "ERROR engine not built; run: dotnet build engine" >&2
  exit 1
fi

# The matrix is generated, not committed. Several hundred generated Designer files in
# git would be noise; the repo's rule is that a fixture is committed only when it
# reproduces something.
WORK="${VSCFORMS_MATRIX_WORK:-out/matrix}"

step "differential matrix (structure, properties, form, compile)"
python3 test/verify-differential-matrix.py \
  --engine "$ENGINE" \
  --work "$WORK" \
  ${VSCFORMS_MATRIX_NO_COMPILE:+--no-compile} \
  || FAIL=1

echo
if [ "$FAIL" -eq 0 ]; then
  echo "############ differential matrix ALL GREEN"
else
  echo "############ differential matrix FAILURES PRESENT"
  echo "Every divergence above has a reproduction fixture in fixtures/differential/."
  echo "Commit the fixture FIRST, then fix the engine — that is the fixture-first gate."
fi
exit "$FAIL"
