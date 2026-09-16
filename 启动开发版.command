#!/bin/bash

finish_console() {
  local result=$?
  trap - EXIT
  [[ -n "${runtime_tail_pid:-}" ]] && kill "$runtime_tail_pid" 2>/dev/null
  [[ -n "${startup_tail_pid:-}" ]] && kill "$startup_tail_pid" 2>/dev/null
  if [[ "$result" -ne 0 ]]; then
    echo
    echo "Development launcher failed (exit code $result). See the output above."
    echo "Press Enter to close..."
    read -r _ || true
  fi
  exit "$result"
}
trap finish_console EXIT
trap 'exit 130' INT TERM
set -e
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"
LOG_DIR="$HOME/Library/Logs/Codex Quota Injector"
mkdir -p "$LOG_DIR"
STARTUP_LOG="$(mktemp "$LOG_DIR/dev-launch-XXXXXXXX")"
RUNTIME_LOG="$LOG_DIR/injector.log"
touch "$RUNTIME_LOG"
echo "Starting Codex Quota Injector development version..."
echo "Startup log: $STARTUP_LOG"
echo "Runtime log: $RUNTIME_LOG"
echo "This window stays open and follows logs. Closing it only stops log viewing."
echo "Recent runtime output (previous launches may appear here):"
tail -n 20 "$RUNTIME_LOG"
# Observe the existing runtime before spawning; the startup file is unique, so
# reading it from its beginning also retains output emitted before tail opens it.
tail -n 0 -F "$RUNTIME_LOG" &
runtime_tail_pid=$!
tail -n +1 -F "$STARTUP_LOG" &
startup_tail_pid=$!
nohup /bin/bash "$SCRIPT_DIR/scripts/start-injector-macos.sh" >>"$STARTUP_LOG" 2>&1 < /dev/null &
launcher_pid=$!
set +e
wait "$launcher_pid"
result=$?
set -e
if [[ "$result" -ne 0 ]]; then
  # Print the complete captured bootstrap output before pausing, even when the
  # follower has not consumed its final bytes yet.
  echo "Complete startup output:"
  cat "$STARTUP_LOG"
  exit "$result"
fi
echo "Launcher returned successfully. Continuing to follow the running injector's logs."
echo "Close this window to stop viewing logs; the background injector remains running."
wait "$runtime_tail_pid"
