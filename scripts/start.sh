#!/bin/sh
# Start the dashboard in the background (if it isn't running) and open it in the browser.
PORT="${PORT:-4777}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${AGENTS_DASHBOARD_HOME:-$HOME/.agents-dashboard}"
mkdir -p "$STATE"
if ! command -v node >/dev/null 2>&1; then echo "Node.js 22.5+ is needed: https://nodejs.org"; exit 1; fi
if curl -fs "http://localhost:$PORT/api/alerts" >/dev/null 2>&1; then
  echo "Dashboard already running: http://localhost:$PORT"
else
  PORT="$PORT" nohup node --no-warnings "$ROOT/server.js" >"$STATE/server.log" 2>&1 &
  echo $! >"$STATE/server.pid"
  i=0; until curl -fs "http://localhost:$PORT/api/alerts" >/dev/null 2>&1 || [ $i -ge 20 ]; do sleep 0.5; i=$((i+1)); done
  if curl -fs "http://localhost:$PORT/api/alerts" >/dev/null 2>&1; then echo "Dashboard started: http://localhost:$PORT"
  else echo "The dashboard didn't start. Log: $STATE/server.log"; tail -5 "$STATE/server.log"; exit 1; fi
fi
[ "$1" = "--no-open" ] || open "http://localhost:$PORT"
