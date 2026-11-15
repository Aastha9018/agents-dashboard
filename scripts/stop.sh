#!/bin/sh
# Stop the dashboard started by start.sh.
STATE="${AGENTS_DASHBOARD_HOME:-$HOME/.agents-dashboard}"
if [ -f "$STATE/server.pid" ] && kill "$(cat "$STATE/server.pid")" 2>/dev/null; then rm -f "$STATE/server.pid"; echo "Dashboard stopped."
else echo "The dashboard isn't running (or wasn't started by /dashboard)."; fi
