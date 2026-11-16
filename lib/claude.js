'use strict';
/**
 * Claude Code sessions (CLI + desktop app).
 *  - Live registry: ~/.claude/sessions/<pid>.json  ({pid, sessionId, cwd, name, status: busy|idle, entrypoint})
 *  - Transcripts:   ~/.claude/projects/<slug>/<sessionId>.jsonl
 *  - Optional exact "needs approval" signal from the Notification hook: ~/.agents-dashboard/claude-notify/<sessionId>.json
 */
const path = require('node:path');
const u = require('./util');
const h = require('./humanize');

const CLAUDE_DIR = path.join(u.HOME, '.claude');
const REGISTRY = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const { HOOK_DIR, HOOK_INSTALLED_FILE } = require('./paths');

// Tools that legitimately run for a long time, so a pending call is not a sign of a permission prompt.
const LONG_RUNNING = new Set([
  'Agent', 'Task', 'Workflow', 'Monitor', 'WebSearch', 'WebFetch', 'Skill',
  'mcp__ccd_session__start_session', 'AskUserQuestion', 'ExitPlanMode',
]);
const POSSIBLE_APPROVAL_AFTER_MS = 25_000;
const POSSIBLE_APPROVAL_BASH_MS = 120_000; // commands (tests, builds) often run for minutes

/** Sessions started after the Notification hook was installed report permission prompts exactly: no guessing. */
function hookCovers(startedAt) {
  const st = u.statSafe(HOOK_INSTALLED_FILE);
  return !!(st && startedAt && startedAt > st.mtimeMs);
}

function toolSummary(name, input = {}, cwd = '') {
  return h.claudeTool(name, input, cwd).text;
}

function isHumanUserText(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message && rec.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((x) => x.type === 'tool_result')) return null;
    text = u.textOf(c);
  }
  text = h.cleanPrompt(text);
  if (!text) return null;
  if (/^<(command-|local-command|task-notification|side-sessions-event|ci-monitor-event)/.test(text)) return null;
  if (text.startsWith('[Request interrupted')) return null;
  return text;
}

/** Apply a ccd update_plan call to the current plan list. */
function applyPlanUpdate(plan, input) {
  if (Array.isArray(input.items)) return input.items.map((i) => ({ content: i.content, status: i.status }));
  if (!plan) return plan;
  plan = plan.map((i) => ({ ...i }));
  if (input.advance) {
    const cur = plan.findIndex((i) => i.status === 'in_progress');
    if (cur >= 0) plan[cur].status = 'completed';
    const next = plan.findIndex((i, idx) => idx > cur && i.status === 'pending');
    if (next >= 0) plan[next].status = 'in_progress';
  }
  for (const n of input.done || []) if (plan[n - 1]) plan[n - 1].status = 'completed';
  if (input.start && plan[input.start - 1]) plan[input.start - 1].status = 'in_progress';
  return plan;
}

function analyseTranscript(file) {
  const recs = u.readJsonlTail(file);
  const pending = new Map(); // tool_use id -> {name, input, at}
  const actions = [];
  let plan = null;
  let lastUser = null;
  let lastAssistantText = null;
  let lastAssistantAt = 0;
  let lastAt = 0;
  let wrapAsk = null;
  let wrapRecap = null;
  let wrapAt = 0;
  let toolCalls = 0;
  let branch = null;
  let cwd = null;
  let apiError = null;
  let lastTypedAt = 0;
  let lastStop = null; // stop_reason of the latest assistant message: end_turn = the turn really ended
  let prLink = null; // last GitHub PR URL the session touched (gh pr create/view output, links in replies)
  const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
  const prTouched = []; // PRs it worked on: in gh pr / git push commands or their output (newest last)
  const prMentioned = []; // PRs it only wrote about in replies
  const remember = (list, url) => {
    const u = url.replace(/[).,]+$/, '');
    const i = list.indexOf(u);
    if (i >= 0) list.splice(i, 1);
    list.push(u);
  };
  const urlsIn = (text) => (text && typeof text === 'string' && text.includes('/pull/') ? text.match(PR_RE) || [] : []);
  const notePr = (text, list) => {
    const m = urlsIn(text);
    if (m.length) prLink = m[m.length - 1];
    if (list) for (const x of m) remember(list, x);
  };
  const ghCmd = new Map(); // tool_use id -> true when the command is about PRs (gh pr …, git push, gh api …/pulls)
  const PR_CMD = /(^|&&|;|\n)\s*(gh pr |git (-C \S+ )?push\b|gh api \S*pulls)/;

  for (const r of recs) {
    if (r.isSidechain) continue;
    const at = u.ts(r.timestamp);
    if (at) lastAt = Math.max(lastAt, at);
    if (r.gitBranch) branch = r.gitBranch;
    if (r.cwd) cwd = r.cwd;

    if (r.type === 'queue-operation' && r.operation === 'enqueue' && at) lastTypedAt = Math.max(lastTypedAt, at); // typed while it was working
    const human = isHumanUserText(r);
    if (human) {
      lastUser = { text: human, at };
      if (at) lastTypedAt = Math.max(lastTypedAt, at);
      wrapAsk = null;
      apiError = null;
    }
    const content = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    if (r.type === 'assistant') {
      if (r.message && r.message.stop_reason) lastStop = r.message.stop_reason;
      if (r.isApiErrorMessage || r.error) apiError = u.clip(u.textOf(content) || r.error, 160);
      for (const c of content) {
        if (c.type === 'text' && c.text && c.text.trim()) {
          notePr(c.text, prMentioned);
          lastAssistantText = c.text;
          lastAssistantAt = at;
        } else if (c.type === 'tool_use') {
          toolCalls++;
          pending.set(c.id, { name: c.name, input: c.input || {}, at });
          const cmd = c.name === 'Bash' && c.input && typeof c.input.command === 'string' ? c.input.command : '';
          if (cmd && PR_CMD.test(cmd)) {
            ghCmd.set(c.id, true);
            notePr(cmd, prTouched);
            // `gh pr view 733` style: no URL, so keep repo/folder hints and resolve later.
            const repo = (cmd.match(/(?:--repo|-R)[ =]([\w.-]+\/[\w.-]+)/) || [])[1] || '';
            const dir = ((cmd.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/) || [])[1] || '').replace(/^["']|["']$/g, '').replace(/^~(?=\/)/, u.HOME);
            for (const m of cmd.matchAll(/gh pr (?:view|checks|merge|edit|comment|ready|review|diff|close|reopen)\s+(\d+)\b/g)) remember(prTouched, `ref:${repo}|${dir || cwd || ''}|${m[1]}`);
          }
          actions.push({ at, text: toolSummary(c.name, c.input || {}, cwd || '') });
          if (c.name === 'TodoWrite' && Array.isArray(c.input && c.input.todos)) {
            plan = c.input.todos.map((t) => ({ content: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content, status: t.status }));
          } else if (c.name === 'mcp__ccd_turn__update_plan') {
            plan = applyPlanUpdate(plan, c.input || {});
          } else if (c.name === 'mcp__ccd_turn__wrap_up') {
            wrapAsk = c.input && c.input.ask ? c.input.ask : null;
            wrapRecap = c.input && c.input.recap ? c.input.recap : null;
            wrapAt = at;
            if (plan) plan = plan.map((i) => ({ ...i, status: 'completed' }));
          }
        }
      }
    } else if (r.type === 'user') {
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        pending.delete(c.tool_use_id);
        notePr(typeof c.content === 'string' ? c.content : u.textOf(c.content), ghCmd.has(c.tool_use_id) ? prTouched : null);
      }
    }
  }

  return {
    pending: [...pending.values()],
    actions: actions.slice(-6).reverse(),
    plan,
    lastUser,
    lastAssistantText,
    lastAssistantAt,
    lastAt,
    wrapAsk,
    wrapRecap,
    wrapAt,
    toolCalls,
    branch,
    cwd,
    apiError,
    prLink,
    prTouched: prTouched.slice(-8).reverse(), // newest first
    prMentioned: prMentioned.slice(-8).reverse(),
    lastTypedAt,
    lastStop,
  };
}

function firstUserText(file) {
  for (const r of u.readJsonlHead(file, 1024 * 1024)) {
    const t = isHumanUserText(r);
    if (t) return t;
  }
  return null;
}

function transcriptPath(sessionId, cwd) {
  if (cwd) {
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const p = path.join(PROJECTS, slug, `${sessionId}.jsonl`);
    if (u.statSafe(p)) return p;
  }
  for (const d of u.listDir(PROJECTS)) {
    const p = path.join(PROJECTS, d, `${sessionId}.jsonl`);
    if (u.statSafe(p)) return p;
  }
  return null;
}

function hookSignal(sessionId) {
  return u.readJsonFile(path.join(HOOK_DIR, `${sessionId}.json`));
}

function decideState({ running, status, t, hook, now, startedAt }) {
  // 1. Explicit, certain blockers.
  for (const p of t.pending) {
    if (p.name === 'AskUserQuestion') {
      const q = (p.input.questions || [])[0];
      return { state: 'needs_you', needs: { kind: 'question', certain: true, label: 'Asking you a question', detail: q ? q.question : '' } };
    }
    if (p.name === 'ExitPlanMode') {
      return { state: 'needs_you', needs: { kind: 'plan', certain: true, label: 'Plan waiting for your approval', detail: u.clip(p.input.plan, 240) } };
    }
  }
  if (hook && u.ts(hook.at) >= t.lastAt - 2000 && running) {
    const type = hook.notification_type || '';
    if (/permission/i.test(type) || /permission/i.test(hook.message || '')) {
      return { state: 'needs_you', needs: { kind: 'approval', certain: true, label: 'Waiting for permission', detail: hook.message || '' } };
    }
  }
  if (!running) return { state: 'ended', needs: null };

  if (status === 'busy') {
    const stuck = !hookCovers(startedAt) && t.pending.find((p) => {
      if (LONG_RUNNING.has(p.name) || (p.name === 'Bash' && p.input.run_in_background)) return false;
      return now - p.at > (p.name === 'Bash' ? POSSIBLE_APPROVAL_BASH_MS : POSSIBLE_APPROVAL_AFTER_MS);
    });
    if (stuck) {
      return {
        state: 'needs_you',
        needs: { kind: 'approval', certain: false, label: 'Maybe waiting for approval', detail: toolSummary(stuck.name, stuck.input) },
      };
    }
    return { state: 'working', needs: null };
  }

  // Idle: the turn ended.
  if (t.apiError) return { state: 'needs_you', needs: { kind: 'error', certain: true, label: 'Stopped with an error', detail: t.apiError } };
  if (t.wrapAsk && t.wrapAt >= t.lastAssistantAt - 60_000) {
    return { state: 'needs_you', needs: { kind: 'question', certain: true, label: 'Asked for a decision', detail: t.wrapAsk } };
  }
  const finishedRecently = t.lastAt && (!t.lastUser || t.lastAt >= t.lastUser.at);
  if (finishedRecently && t.lastAssistantText) return { state: 'your_turn', needs: null };
  return { state: 'idle', needs: null };
}

// ---- helper agents (the Agent/Task tool) a session started: <transcript>/subagents/agent-*.jsonl + .meta.json ----
const MAX_HELPERS = 8;

function helperState(file, meta, parentRunning, now, recentMs) {
  if (meta.finished) return { state: 'done', pending: null };
  const st = u.statSafe(file);
  if (!parentRunning || !st || now - st.mtimeMs > recentMs) return { state: 'stopped', pending: null };
  const pending = new Map();
  for (const r of u.readJsonlTail(file, 256 * 1024)) {
    const content = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const c of content) {
      if (c.type === 'tool_use') pending.set(c.id, { name: c.name, input: c.input || {}, at: u.ts(r.timestamp) });
      else if (c.type === 'tool_result') pending.delete(c.tool_use_id);
    }
  }
  const last = [...pending.values()].pop() || null;
  return { state: 'working', pending: last };
}

function helpers(file, { running, needs, now, recentMs, cwd }) {
  // Background helpers can't stop to ask you; they only count as waiting when the parent says it's asking.
  if (!file) return [];
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  const out = [];
  for (const f of u.listDir(dir)) {
    if (!f.endsWith('.meta.json')) continue;
    const meta = u.readJsonFile(path.join(dir, f));
    if (!meta) continue;
    const jsonl = path.join(dir, f.replace(/\.meta\.json$/, '.jsonl'));
    const st = u.statSafe(jsonl);
    const at = st ? st.mtimeMs : 0;
    if (!at || (meta.finished && now - at > recentMs)) continue;
    out.push({ id: f.replace(/\.meta\.json$/, ''), meta, jsonl, at });
  }
  out.sort((a, b) => Number(!!a.meta.finished) - Number(!!b.meta.finished) || b.at - a.at);
  return out.slice(0, MAX_HELPERS).map(({ id, meta, jsonl, at }) => {
    const { state, pending } = helperState(jsonl, meta, running, now, recentMs);
    let approval = null;
    if (state === 'working' && pending && !LONG_RUNNING.has(pending.name) && !(pending.name === 'Bash' && pending.input.run_in_background)) {
      const waited = now - (pending.at || now);
      const parentAsks = needs && needs.kind === 'approval';
      const canAsk = !meta.requestNonInteractive;
      if (parentAsks || (canAsk && waited > (pending.name === 'Bash' ? POSSIBLE_APPROVAL_BASH_MS : POSSIBLE_APPROVAL_AFTER_MS))) {
        approval = { certain: !!(needs && needs.certain && parentAsks), detail: toolSummary(pending.name, pending.input, cwd) };
      }
    }
    return {
      id,
      kind: 'helper',
      title: u.clip(meta.description || meta.agentType || 'Helper agent', 80),
      type: meta.agentType || 'agent',
      background: meta.requestShape === 'background',
      state: approval ? 'needs_you' : state, // working | done | stopped | needs_you
      doing: pending && state === 'working' ? toolSummary(pending.name, pending.input, cwd) : null,
      approval,
      lastActivity: at,
    };
  });
}

function collect({ recentMs, now }) {
  const out = [];
  const seen = new Set();

  // Live registry.
  for (const f of u.listDir(REGISTRY)) {
    if (!f.endsWith('.json')) continue;
    const reg = u.readJsonFile(path.join(REGISTRY, f));
    if (!reg || !reg.sessionId) continue;
    const running = u.pidAlive(reg.pid);
    const file = transcriptPath(reg.sessionId, reg.cwd);
    const st = file && u.statSafe(file);
    const lastAt = Math.max(st ? st.mtimeMs : 0, reg.updatedAt || 0);
    if (!running && now - lastAt > recentMs) continue;
    seen.add(reg.sessionId);
    const t = file ? analyseTranscript(file) : { pending: [], actions: [], lastAt, toolCalls: 0 };
    const { state, needs } = decideState({ running, status: reg.status, t, hook: hookSignal(reg.sessionId), now, startedAt: reg.startedAt });
    const sess = build({ id: reg.sessionId, pid: running ? reg.pid : null, reg, file, t, state, needs, lastAt, running });
    sess.helpers = helpers(file, { running, needs, now, recentMs, cwd: sess.cwd });
    out.push(sess);
  }

  // Recently active transcripts with no live process.
  for (const d of u.listDir(PROJECTS)) {
    const dir = path.join(PROJECTS, d);
    for (const f of u.listDir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (seen.has(id)) continue;
      const file = path.join(dir, f);
      const st = u.statSafe(file);
      if (!st || now - st.mtimeMs > recentMs) continue;
      seen.add(id);
      const t = analyseTranscript(file);
      const sess = build({ id, pid: null, reg: null, file, t, state: 'ended', needs: null, lastAt: st.mtimeMs, running: false });
      sess.helpers = helpers(file, { running: false, needs: null, now, recentMs, cwd: sess.cwd });
      out.push(sess);
    }
  }
  return out;
}

function build({ id, pid, reg, file, t, state, needs, lastAt, running }) {
  const cwd = (reg && reg.cwd) || t.cwd || '';
  const entry = (reg && reg.entrypoint) || 'cli';
  const desktop = entry === 'claude-desktop';
  let title = reg && reg.name && reg.nameSource !== 'derived' ? reg.name : null;
  if (!title && file) title = u.clip(firstUserText(file), 90);
  if (!title) title = (reg && reg.name) || u.projectLabel(cwd) || id.slice(0, 8);
  const goal = file ? u.clip(firstUserText(file), 400) : null;
  const plan = t.plan || null;
  return {
    key: `claude:${id}`,
    agent: 'claude',
    agentLabel: desktop ? 'Claude Code · app' : 'Claude Code · CLI',
    id,
    pid,
    running,
    surface: desktop ? 'desktop' : 'terminal',
    title,
    cwd,
    cwdShort: u.shortPath(cwd),
    project: u.projectLabel(cwd),
    branch: t.branch || null,
    state,
    needs,
    lastActivity: Math.max(lastAt || 0, t.lastAt || 0),
    plan,
    currentStep: plan ? (plan.find((i) => i.status === 'in_progress') || {}).content || null : null,
    toolCalls: t.toolCalls || 0,
    actions: t.actions || [],
    lastUser: t.lastUser ? u.clip(t.lastUser.text, 200) : null,
    lastUserAt: t.lastTypedAt || (t.lastUser ? t.lastUser.at : 0),
    goal,
    lastAgent: t.wrapRecap && t.wrapAt >= (t.lastAssistantAt || 0) - 60_000 ? u.clipLines(h.plain(t.wrapRecap), 900) : u.clipLines(h.plain(t.lastAssistantText), 900),
    lastAgentAt: t.lastAssistantAt || null,
    prLink: t.prLink,
    prTouched: t.prTouched || [],
    prMentioned: t.prMentioned || [],
    turnEnded: t.lastStop === 'end_turn',
    file,
    resume: desktop ? null : `cd ${JSON.stringify(cwd)} && claude --resume ${id}`,
  };
}

module.exports = { collect };
