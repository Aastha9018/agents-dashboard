---
name: dashboard
description: Start and open the Agents dashboard, a local page showing every Claude Code, Codex and Prime Agent session on this Mac, their sub agents, and which ones need you. Use when the user asks to open, start, stop or restart the agents dashboard, or to see which agent sessions need them.
---

# Agents dashboard

The dashboard is a small local web server (Node, no dependencies) at http://localhost:4777. It only reads session files on this Mac.

The plugin's SessionStart hook records where this plugin is installed in `~/.agents-dashboard/plugin-root`.

## Open it (default)

Run:

```bash
sh "$(cat ~/.agents-dashboard/plugin-root)/scripts/start.sh"
```

It starts the server in the background if it isn't running, then opens the page in the default browser. Tell the user the URL and that it keeps running in the background.

If `~/.agents-dashboard/plugin-root` doesn't exist yet, the hook hasn't run: ask the user to start a new Claude Code session (or restart this one) and try again.

## Stop it

```bash
sh "$(cat ~/.agents-dashboard/plugin-root)/scripts/stop.sh"
```

## Restart it (after a plugin update)

Run stop, then open.

## If it fails

- `Node.js 22.5+ is needed`: the user must install Node 22.5 or newer.
- Otherwise show the last lines of `~/.agents-dashboard/server.log`.
- Port in use: run start with `PORT=4778` in front.

## Notes for the user

- macOS only (it uses AppleScript and app links to jump to sessions).
- The PR / GitHub Actions section needs the `gh` CLI signed in.
- Browser alerts: click **Turn on alerts** on the page once.
