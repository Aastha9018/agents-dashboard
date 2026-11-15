'use strict';
/** Bring an agent session to the front (or reopen it) on macOS. */
const { execFileSync } = require('node:child_process');

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

function osa(script) {
  return sh('osascript', ['-e', script]);
}

function asStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Walk up the process tree to find the GUI app (.app bundle) hosting a pid. */
function hostApp(pid) {
  let cur = pid;
  for (let i = 0; i < 20 && cur > 1; i++) {
    const line = sh('ps', ['-o', 'ppid=,comm=', '-p', String(cur)]);
    if (!line) return null;
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) return null;
    const app = m[2].match(/^(.*?\.app)\//); // outermost bundle (VS Code's "Code Helper.app" → "Visual Studio Code.app")
    if (app && !/Claude Helper|disclaimer|claude-code/.test(m[2])) return app[1];
    cur = Number(m[1]);
  }
  return null;
}

function ttyOf(pid) {
  const t = sh('ps', ['-o', 'tty=', '-p', String(pid)]);
  return t && t !== '??' ? `/dev/${t}` : null;
}

function cwdOf(pid) {
  const out = sh('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

function focusTty(app, tty) {
  if (/iTerm/.test(app)) {
    return osa(`tell application "iTerm"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is ${asStr(tty)} then
          select w
          select t
          select s
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell`) === 'ok';
  }
  if (/Terminal\.app/.test(app)) {
    return osa(`tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${asStr(tty)} then
        set selected of t to true
        set index of w to 1
        return "ok"
      end if
    end repeat
  end repeat
end tell`) === 'ok';
  }
  return false;
}

function openInNewTerminal(command) {
  osa(`tell application "Terminal"
  activate
  do script ${asStr(command)}
end tell`);
}

// ---- Claude app sessions: map the CLI session id to the app's own id (local_…) ----
const fs = require('node:fs');
const path = require('node:path');
const APP_SESSIONS = path.join(require('node:os').homedir(), 'Library/Application Support/Claude/claude-code-sessions');
let appIndex = { at: 0, byCli: new Map(), byLocal: new Map() };

function walk(dir, out, depth = 0) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth < 3) walk(p, out, depth + 1);
    else if (d.isFile() && /^local_.*\.json$/.test(d.name)) out.push(p);
  }
  return out;
}

/** cliSessionId -> { localId, cliId, lastFocusedAt, parentLocalId }. Re-read at most every 3s. */
function appSessions() {
  return appIndexNow().byCli;
}

/** The app session (by local_… id) that started another one ("spawnedFrom"). */
function appSessionByLocal(localId) {
  return appIndexNow().byLocal.get(localId) || null;
}

function appIndexNow() {
  if (Date.now() - appIndex.at < 3000) return appIndex;
  const byCli = new Map();
  const byLocal = new Map();
  for (const f of walk(APP_SESSIONS, [])) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!j || !j.sessionId || j.isArchived) continue;
    const v = { localId: j.sessionId, cliId: j.lastAssistantCliSessionId || j.cliSessionId || null, lastFocusedAt: j.lastFocusedAt || 0, parentLocalId: (j.spawnedFrom && j.spawnedFrom.sessionId) || null, title: j.title || null };
    for (const id of [j.cliSessionId, j.lastAssistantCliSessionId]) if (id) byCli.set(id, v);
    byLocal.set(j.sessionId, v);
  }
  appIndex = { at: Date.now(), byCli, byLocal };
  return appIndex;
}

/** Returns a short human message describing what happened. */
function focusSession(s) {
  if (s.agent === 'claude' && s.surface === 'desktop') {
    const app = appSessions().get(s.id);
    if (app && /^local_[A-Za-z0-9-]{1,64}$/.test(app.localId)) {
      sh('open', [`claude://code/continue?session=${app.localId}`]);
      return `Opened "${s.title}" in the Claude app.`;
    }
    sh('open', ['-a', 'Claude']);
    return `Brought the Claude app to the front, but couldn't open "${s.title}" directly. Find it in the sidebar.`;
  }
  let pid = s.pid;
  if (!pid && s.agent === 'codex' && s.running) {
    const pids = sh('pgrep', ['-x', 'codex']).split('\n').filter(Boolean).map(Number);
    pid = pids.find((p) => cwdOf(p) === s.cwd) || null;
  }
  if (pid) {
    const app = hostApp(pid);
    if (app) {
      const tty = ttyOf(pid);
      const exact = tty ? focusTty(app, tty) : false;
      if (!exact) sh('open', ['-a', app]);
      const name = app.split('/').pop().replace(/\.app$/, '');
      return exact ? `Switched to the ${name} tab running this session.` : `Brought ${name} to the front.`;
    }
  }
  if (s.agent === 'codex' && s.running && require('node:fs').existsSync('/Applications/Codex.app')) {
    sh('open', ['-a', 'Codex']);
    return 'Brought Codex to the front.';
  }
  if (s.resume) {
    openInNewTerminal(s.resume);
    return 'Opened a new Terminal window and resumed the session.';
  }
  return 'Could not find a window for this session.';
}

function notify(title, subtitle, message, sound = true) {
  osa(`display notification ${asStr(message)} with title ${asStr(title)} subtitle ${asStr(subtitle)}${sound ? ' sound name "Glass"' : ''}`);
}

/** Bundle path of the frontmost app, e.g. "/Applications/iTerm.app". */
function frontApp() {
  const out = sh('lsappinfo', ['info', '-only', 'bundlepath', sh('lsappinfo', ['front'])]);
  return (out.match(/"([^"]+\.app)"/) || [])[1] || '';
}

function frontTty(app) {
  if (/iTerm/.test(app)) return osa('tell application "iTerm" to tty of current session of current window');
  if (/Terminal\.app/.test(app)) return osa('tell application "Terminal" to tty of selected tab of front window');
  return '';
}

/**
 * Keys of the sessions you're looking at right now, so we don't alert about them.
 * Claude app in front → the desktop session you typed into last (the app doesn't say which one is open).
 * iTerm/Terminal in front → the session in the selected tab. Other host apps (VS Code…) → sessions running inside it.
 */
function focusedKeys(sessions) {
  const app = frontApp();
  if (!app) return new Set();
  if (/\/Claude\.app$/.test(app)) {
    // The app records when each session was last focused; the newest is the one on screen.
    const idx = appSessions();
    const desk = sessions.filter((s) => s.agent === 'claude' && s.surface === 'desktop' && s.state !== 'ended');
    const focusedAt = (s) => (idx.get(s.id) || {}).lastFocusedAt || 0;
    desk.sort((a, b) => focusedAt(b) - focusedAt(a) || (b.lastUserAt || 0) - (a.lastUserAt || 0));
    return new Set(desk.length ? [desk[0].key] : []);
  }
  if (/\/Codex\.app$/.test(app)) return new Set(sessions.filter((s) => s.agent === 'codex' && s.running).map((s) => s.key));
  const tty = frontTty(app);
  const keys = new Set();
  for (const s of sessions) {
    if (!s.pid || !s.running) continue;
    const host = hostApp(s.pid);
    if (host !== app) continue;
    if (!tty || ttyOf(s.pid) === tty) keys.add(s.key);
  }
  return keys;
}

module.exports = { focusSession, notify, focusedKeys, appSessions, appSessionByLocal };
