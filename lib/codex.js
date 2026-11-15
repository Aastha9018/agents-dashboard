'use strict';
/**
 * Codex sessions (CLI + desktop app).
 *  - Thread index: ~/.codex/state_*.sqlite  (table `threads`: id, rollout_path, cwd, title, updated_at, archived)
 *  - Rollouts:     ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl  ({timestamp, type, payload})
 * Running = a codex process is alive and the rollout changed recently.
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const u = require('./util');
const h = require('./humanize');

const CODEX = path.join(u.HOME, '.codex');
const ACTIVE_WINDOW_MS = 10 * 60_000;

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  /* older node: fall back to scanning rollout files */
}

function codexPids() {
  try {
    const out = execFileSync('pgrep', ['-x', 'codex'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function threadsFromDb(sinceSec) {
  if (!DatabaseSync) return null;
  const dbFile = u.listDir(CODEX).filter((f) => /^state_\d+\.sqlite$/.test(f)).sort().pop();
  if (!dbFile) return null;
  let db;
  try {
    db = new DatabaseSync(path.join(CODEX, dbFile), { readOnly: true });
    return db
      .prepare('SELECT id, rollout_path, cwd, title, name, first_user_message, git_branch, updated_at, approval_mode FROM threads WHERE archived = 0 AND updated_at >= ? ORDER BY updated_at DESC')
      .all(sinceSec);
  } catch {
    return null;
  } finally {
    try {
      db && db.close();
    } catch {
      /* ignore */
    }
  }
}

function threadsFromFiles(recentMs, now) {
  const root = path.join(CODEX, 'sessions');
  const out = [];
  const walk = (dir, depth) => {
    for (const f of u.listDir(dir)) {
      const p = path.join(dir, f);
      if (depth < 3) walk(p, depth + 1);
      else if (f.startsWith('rollout-') && f.endsWith('.jsonl')) {
        const st = u.statSafe(p);
        if (st && now - st.mtimeMs <= recentMs) out.push({ id: f.replace(/^rollout-|\.jsonl$/g, ''), rollout_path: p });
      }
    }
  };
  walk(root, 0);
  return out;
}

function analyse(file) {
  const recs = u.readJsonlTail(file);
  let meta = null;
  let lastAt = 0;
  let lastUser = null;
  let lastAgent = null;
  let approval = null;
  let taskOpen = false;
  let lastError = null;
  let plan = null;
  let toolCalls = 0;
  const actions = [];

  for (const r of recs) {
    const at = u.ts(r.timestamp);
    if (at) lastAt = Math.max(lastAt, at);
    const p = r.payload || {};
    if (r.type === 'session_meta') meta = p;
    if (r.type === 'event_msg') {
      switch (p.type) {
        case 'task_started':
          taskOpen = true;
          lastError = null;
          break;
        case 'task_complete':
        case 'turn_aborted':
          taskOpen = false;
          approval = null;
          if (p.last_agent_message) lastAgent = p.last_agent_message;
          break;
        case 'user_message':
          if (p.message) lastUser = { text: p.message, at };
          approval = null;
          break;
        case 'agent_message':
          if (p.message) lastAgent = p.message;
          break;
        case 'exec_approval_request':
          approval = { label: 'Command needs approval', detail: Array.isArray(p.command) ? p.command.join(' ') : String(p.command || p.reason || '') };
          break;
        case 'apply_patch_approval_request':
          approval = { label: 'File edit needs approval', detail: Object.keys(p.changes || {}).map(u.shortPath).join(', ') || p.reason || '' };
          break;
        case 'request_user_input':
        case 'elicitation_request':
          approval = { label: 'Asking you a question', detail: p.message || p.question || '' };
          break;
        case 'exec_command_begin':
        case 'patch_apply_begin':
        case 'exec_command_end':
        case 'patch_apply_end':
          approval = null;
          break;
        case 'error':
        case 'stream_error':
          lastError = p.message || 'Error';
          break;
        default:
          break;
      }
    }
    if (r.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
        toolCalls++;
        let text = h.codexTool(p).text;
        if (p.name === 'update_plan') {
          const args = u.safeJson(p.arguments) || {};
          if (Array.isArray(args.plan)) plan = args.plan.map((s) => ({ content: s.step, status: s.status }));
        }
        actions.push({ at, text });
      }
    }
  }
  if (!meta) meta = (u.readJsonlHead(file, 16 * 1024).find((r) => r.type === 'session_meta') || {}).payload || null;
  return { meta, lastAt, lastUser, lastAgent, approval, taskOpen, lastError, plan, toolCalls, actions: actions.slice(-6).reverse() };
}

function collect({ recentMs, now }) {
  const rows = threadsFromDb(Math.floor((now - recentMs) / 1000));
  const threads = rows && rows.length ? rows : threadsFromFiles(recentMs, now);
  const pids = codexPids();
  const anyRunning = pids.length > 0;
  const out = [];

  for (const th of threads) {
    const file = th.rollout_path;
    const st = file && u.statSafe(file);
    if (!st) continue;
    const t = analyse(file);
    const cwd = th.cwd || (t.meta && t.meta.cwd) || '';
    const lastActivity = Math.max(t.lastAt, st.mtimeMs);
    const running = anyRunning && now - lastActivity < ACTIVE_WINDOW_MS;

    let state;
    let needs = null;
    if (t.approval) {
      state = 'needs_you';
      needs = { kind: 'approval', certain: true, label: t.approval.label, detail: u.clip(t.approval.detail, 220) };
    } else if (!running) state = 'ended';
    else if (t.lastError && !t.taskOpen) {
      state = 'needs_you';
      needs = { kind: 'error', certain: true, label: 'Stopped with an error', detail: u.clip(t.lastError, 200) };
    } else if (t.taskOpen) state = 'working';
    else state = t.lastAgent ? 'your_turn' : 'idle';

    const plan = t.plan;
    out.push({
      key: `codex:${th.id}`,
      agent: 'codex',
      agentLabel: 'Codex',
      id: th.id,
      pid: null,
      running,
      surface: 'terminal',
      title: u.clip(th.name || th.title || th.first_user_message || (t.lastUser && t.lastUser.text), 90) || u.projectLabel(cwd),
      goal: u.clip(th.first_user_message, 400) || null,
      file,
      lastAgentAt: t.lastAt,
      cwd,
      cwdShort: u.shortPath(cwd),
      project: u.projectLabel(cwd),
      branch: th.git_branch || (t.meta && t.meta.git && t.meta.git.branch) || null,
      state,
      needs,
      lastActivity,
      plan,
      currentStep: plan ? (plan.find((i) => i.status === 'in_progress') || {}).content || null : null,
      toolCalls: t.toolCalls,
      actions: t.actions,
      lastUser: t.lastUser ? u.clip(t.lastUser.text, 200) : null,
      lastAgent: u.clipLines(h.plain(t.lastAgent), 900),
      resume: `cd ${JSON.stringify(cwd)} && codex resume ${th.id}`,
    });
  }
  return out;
}

module.exports = { collect };
