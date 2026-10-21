#!/usr/bin/env bash
# Drive the UTM Windows guest through the QEMU guest agent.
#
# WHY THIS EXISTS
#   The guest has no SSH and no RDP (the image has neither), but UTM wires a QEMU guest
#   agent to the virtio-serial port. That gives three primitives:
#
#     file push   bytes into the guest
#     exec        run a command in the guest
#     file pull   bytes out of the guest
#
#   `exec` does not forward stdout to this terminal, which makes it useless on its own.
#   So the pattern here is: push a script, exec it with its output redirected to a file,
#   and pull that file back. The sentinel at the end of the output is how the host knows
#   the run finished rather than guessing with a sleep.
#
# USAGE
#   scripts/utm-guest.sh run <local-script> [args...]   push, exec, pull stdout
#   scripts/utm-guest.sh exec <command...>              run a command line
#   scripts/utm-guest.sh push <local> <guest-path>
#   scripts/utm-guest.sh pull <guest-path> [local]
#   scripts/utm-guest.sh ip                             print the guest's IPv4
#
# ENVIRONMENT
#   VSCFORMS_UTM_VM         the VM's name or UUID. Default: Windows
#   VSCFORMS_UTMCTL         the utmctl binary. Default: the one inside UTM.app
#   VSCFORMS_UTM_TIMEOUT    seconds to wait for the run to finish. Default: 900
set -uo pipefail
cd "$(dirname "$0")/.."

VM="${VSCFORMS_UTM_VM:-Windows}"
UTMCTL="${VSCFORMS_UTMCTL:-/Applications/UTM.app/Contents/MacOS/utmctl}"
TIMEOUT="${VSCFORMS_UTM_TIMEOUT:-900}"

GUEST_DIR='C:\Users\Public'
GUEST_SENTINEL='VSCFORMS-RUN-COMPLETE'
LOCAL_OUT="${TMPDIR:-/tmp}/vscforms-guest-out.txt"

# A UNIQUE output file per run. Two runs sharing one file interleave: the second
# truncates it while the first is still writing, and the result is a blend of both.
RUN_ID="vscforms-out-$$"
GUEST_OUT="$GUEST_DIR\\$RUN_ID.txt"

# The guest's working directory for pushed scripts.
guest_path() { printf '%s\\%s' "$GUEST_DIR" "$1"; }

require_utmctl() {
  if [ ! -x "$UTMCTL" ]; then
    echo "ERROR utmctl not found at $UTMCTL" >&2
    echo "  set VSCFORMS_UTMCTL, or install UTM (brew install --cask utm)" >&2
    exit 1
  fi
}

# The guest agent is the only channel in, so its absence is the only thing that can make
# every later step fail quietly. Check it first, and say so plainly.
require_guest() {
  if ! ip=$("$UTMCTL" ip-address "$VM" 2>/dev/null | head -1) || [ -z "$ip" ]; then
    echo "ERROR the guest agent is not answering for VM '$VM'." >&2
    echo "  Is the VM running?  $UTMCTL list" >&2
    echo "  Does the guest have the QEMU guest agent service?" >&2
    exit 1
  fi
  GUEST_IP="$ip"
}

# Wait for the run to finish by looking for the sentinel the runner appends.
wait_for_sentinel() {
  local waited=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    if "$UTMCTL" file pull "$VM" "$GUEST_OUT" 2>/dev/null | grep -q "$GUEST_SENTINEL"; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

cmd_run() {
  local script="$1"; shift
  require_utmctl; require_guest
  local base; base=$(basename "$script")
  local ext="${base##*.}"
  local guest; guest=$(guest_path "vscforms-run.$ext")
  local argline=""
  for a in "$@"; do argline="$argline \"$a\""; done

  echo "pushing $base to $guest" >&2
  "$UTMCTL" file push "$VM" "$guest" < "$script" || {
    echo "ERROR push failed" >&2; exit 1; }

  # Clear the output so a stale file cannot be mistaken for this run's result.
  "$UTMCTL" exec "$VM" --cmd cmd.exe /c "type nul > $GUEST_OUT" >/dev/null 2>&1

  if [ "$ext" = "ps1" ]; then
    "$UTMCTL" exec "$VM" --cmd cmd.exe /c \
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $guest$argline > $GUEST_OUT 2>&1 & echo $GUEST_SENTINEL >> $GUEST_OUT" \
      >/dev/null 2>&1
  else
    # The guest path has no spaces, so it needs no quoting — and quoting it here would
    # survive into the guest's command line as a literal backslash-quote, which cmd
    # rejects with "is not recognized as an internal or external command".
    "$UTMCTL" exec "$VM" --cmd cmd.exe /c \
      "call $guest$argline > $GUEST_OUT 2>&1 & echo $GUEST_SENTINEL >> $GUEST_OUT" \
      >/dev/null 2>&1
  fi

  echo "running... (up to ${TIMEOUT}s)" >&2
  if ! wait_for_sentinel; then
    echo "ERROR the guest run did not finish within ${TIMEOUT}s" >&2
    "$UTMCTL" file pull "$VM" "$GUEST_OUT" 2>/dev/null | tail -40
    exit 1
  fi
  "$UTMCTL" file pull "$VM" "$GUEST_OUT" 2>/dev/null | sed "s/$GUEST_SENTINEL//" | sed '/^[[:space:]]*$/d'
}

cmd_exec() {
  require_utmctl; require_guest
  local cmd="$*"
  "$UTMCTL" exec "$VM" --cmd cmd.exe /c "$cmd" >/dev/null 2>&1
  # exec does not forward stdout; pull the output file it wrote.
  "$UTMCTL" file pull "$VM" "$GUEST_OUT" 2>/dev/null
}

cmd_push() {
  require_utmctl; require_guest
  "$UTMCTL" file push "$VM" "$(guest_path "$(basename "$2")")" < "$1"
}

cmd_pull() {
  require_utmctl; require_guest
  local dest="${2:-$LOCAL_OUT}"
  "$UTMCTL" file pull "$VM" "$(guest_path "$1")" > "$dest"
  cat "$dest"
}

cmd_run_bash() {
  # Push a BASH script and run it with Git Bash.
  #
  # Bash is the right currency in the guest: cmd.exe has no `printf` (so a request written
  # with it is silently empty), and it has no `sed`/`grep` worth the name. Everything with
  # real logic in the guest should be a .sh, pushed and run through Git Bash.
  require_utmctl; require_guest
  local script="$1"; shift
  local base; base=$(basename "$script")
  local guest; guest=$(guest_path "$base")
  "$UTMCTL" file push "$VM" "$guest" < "$script" || {
    echo "ERROR push failed" >&2; exit 1; }
  local argline=""
  for a in "$@"; do argline="$argline \"$a\""; done
  "$UTMCTL" exec "$VM" --cmd cmd.exe /c \
    "C:\\Program Files\\Git\\bin\\bash.exe -lc \"bash $(cygpath -m "$guest" 2>/dev/null || echo "$guest")$argline > $(cygpath -m "$GUEST_OUT" 2>/dev/null || echo "$GUEST_OUT") 2>&1 & echo $GUEST_SENTINEL >> $(cygpath -m "$GUEST_OUT" 2>/dev/null || echo "$GUEST_OUT")\"" \
    >/dev/null 2>&1
  if ! wait_for_sentinel; then
    echo "ERROR the guest run did not finish within ${TIMEOUT}s" >&2
    "$UTMCTL" file pull "$VM" "$GUEST_OUT" 2>/dev/null | tail -40
    exit 1
  fi
  "$UTMCTL" file pull "$VM" "$GUEST_OUT" 2>/dev/null | sed "s/$GUEST_SENTINEL//" | sed '/^[[:space:]]*$/d'
}

case "${1:-}" in
  run)      shift; cmd_run "$@" ;;
  run-bash) shift; cmd_run_bash "$@" ;;
  exec)     shift; cmd_exec "$@" ;;
  push)     shift; cmd_push "$@" ;;
  pull)     shift; cmd_pull "$@" ;;
  ip)       require_utmctl; require_guest; echo "$GUEST_IP" ;;
  *)    echo "usage: $0 {run <script>|run-bash <script.sh>|exec <cmd>|push <local> <name>|pull <name>|ip}" >&2
        exit 2 ;;
esac
