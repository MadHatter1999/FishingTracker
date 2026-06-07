#!/usr/bin/env bash
# Runs the guild backend (Node + SQLite) and the frontend (Vite) together in ONE
# terminal, and guarantees both shut down when this script stops by ANY method:
#   - Ctrl+C / SIGINT / SIGTERM  -> trap kills the child tree
#   - either process dies         -> the other is torn down too
#   - terminal closed (SIGHUP)    -> trap kills the child tree
#
# Usage:  ./dev.sh        (chmod +x dev.sh once, first)

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- install dependencies on first run ---
[ -d node_modules ] || { echo "Installing frontend deps..."; npm install; }
[ -d server/node_modules ] || { echo "Installing server deps..."; ( cd server && npm install ); }

PIDS=()
cleaning=0

kill_tree() {
  local pid="$1"
  # kill descendants first (vite -> esbuild, etc.), then the process itself
  if command -v pkill >/dev/null 2>&1; then
    pkill -TERM -P "$pid" 2>/dev/null || true
  fi
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  [ "$cleaning" -eq 1 ] && return
  cleaning=1
  trap - INT TERM HUP EXIT
  echo ""
  echo "Stopping frontend + backend..."
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  wait 2>/dev/null || true
  echo "Stopped."
  exit 0
}
trap cleanup INT TERM HUP EXIT

echo "Starting backend  -> http://localhost:8787"
node --no-warnings=ExperimentalWarning server/index.js &
PIDS+=("$!")

echo "Starting frontend -> http://localhost:5180"
node node_modules/vite/bin/vite.js &
PIDS+=("$!")

echo ""
echo "Both running. Press Ctrl+C to stop BOTH."
echo ""

# If EITHER process exits, tear everything down.
while :; do
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null || cleanup
  done
  sleep 1
done
