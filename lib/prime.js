'use strict';
/**
 * Prime Agent sessions.
 *  - Transcripts: ~/.prime/agent/sessions/<id>.jsonl
 *  - Live lease:  ~/.prime/agent/session-leases/<hash>.lock/owner.json  ({pid, sessionPath})
 */
const path = require('node:path');
const u = require('./util');
const h = require('./humanize');

const PRIME = path.join(u.HOME, '.prime', 'agent');
const SESSIONS = path.join(PRIME, 'sessions');
const LEASES = path.join(PRIME, 'session-leases');

function liveLeases() {
  const map = new Map(); // sessionPath -> pid
  for (const d of u.listDir(LEASES)) {
    const o = u.readJsonFile(path.join(LEASES, d, 'owner.json'));
    if (o && o.sessionPath && u.pidAlive(o.pid)) map.set(o.sessionPath, o.pid);
  }
  return map;
}

function analyse(file) {
  const recs = u.readJsonlTail(file);
  let meta = null;
  let archived = false;
  let lastAt = 0;
  let lastUser = null;
  let lastAssistantText = null;
  let lastStop = null;
  let lastRole = null;
  let lastError = null;
  let statusSummary = null;
  let toolCalls = 0;
  const pending = new Map();
  const actions = [];
  let branch = null;

  for (const r of recs) {
    const at = u.ts(r.timestamp);
    if (at) lastAt = Math.max(lastAt, at);
    if (r.type === 'session') meta = r;
    if (r.type === 'git_state' && r.branch) branch = r.branch;
    if (r.type === 'session_state' && r.state) archived = r.state.status === 'archived';
    if (r.type === 'agent_status' && r.status) {
      statusSummary = r.status;
    }
    if (r.type !== 'message' || !r.message) continue;
    const m = r.message;
    lastRole = m.role;
    if (m.role === 'user') {
      const t = u.textOf(m.content).trim();
      if (t) lastUser = { text: t, at };
      lastError = null;
    } else if (m.role === 'assistant') {
      lastStop = m.stopReason || null;
      if (m.stopReason === 'error') lastError = m.errorMessage || 'Model request failed';
      for (const c of m.content || []) {
        if (c.type === 'text' && c.text && c.text.trim()) lastAssistantText = c.text;
        if (c.type === 'toolCall' || c.type === 'tool_use') {
          toolCalls++;
          const name = c.name || c.toolName || 'tool';
          pending.set(c.id, { name, at });
          actions.push({ at, text: name === 'ipython' || name === 'websearch' ? h.primeTool(name, c.arguments || c.input || {}).text : `Used ${name}` });
        }
      }
    } else if (m.role === 'toolResult') {
      pending.delete(m.toolCallId);
    }
  }
  if (!meta) {
    const head = u.readJsonlHead(file, 4096);
    meta = head.find((r) => r.type === 'session') || null;
    if (meta && meta.git && !branch) branch = meta.git.branch;
  }
  return { meta, archived, lastAt, lastUser, lastAssistantText, lastStop, lastRole, lastError, statusSummary, toolCalls, pending: [...pending.values()], actions: actions.slice(-6).reverse(), branch };
}

function firstUserText(file) {
  for (const r of u.readJsonlHead(file, 256 * 1024)) {
    if (r.type === 'message' && r.message && r.message.role === 'user') {
      const t = u.textOf(r.message.content).trim();
      if (t) return h.cleanPrompt(t);
    }
  }
  return null;
}

function collect({ recentMs, now }) {
  const leases = liveLeases();
  const out = [];
  for (const f of u.listDir(SESSIONS)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = path.join(SESSIONS, f);
    const st = u.statSafe(file);
    if (!st) continue;
    const pid = leases.get(file) || null;
    const running = !!pid;
    if (!running && now - st.mtimeMs > recentMs) continue;
    const t = analyse(file);
    if (t.archived && !running) continue;
    const id = f.slice(0, -6);
    const cwd = (t.meta && t.meta.cwd) || '';

    let state = 'idle';
    let needs = null;
    if (!running) state = 'ended';
    else if (t.lastError) {
      state = 'needs_you';
      needs = { kind: 'error', certain: true, label: 'Stopped with an error', detail: u.clip(t.lastError, 200) };
    } else if (t.lastRole === 'user' || t.lastRole === 'toolResult' || t.pending.length || t.lastStop === 'toolUse') {
      state = now - t.lastAt < 15 * 60_000 ? 'working' : 'idle';
    } else if (t.lastStop === 'stop' || t.lastStop === 'aborted') {
      state = 'your_turn';
    }

    out.push({
      key: `prime:${id}`,
      agent: 'prime',
      agentLabel: 'Prime Agent',
      id,
      pid,
      running,
      surface: 'terminal',
      title: u.clip(firstUserText(file), 90) || u.projectLabel(cwd) || id.slice(0, 8),
      goal: u.clip(firstUserText(file), 400),
      file,
      lastAgentAt: t.lastAt,
      cwd,
      cwdShort: u.shortPath(cwd),
      project: u.projectLabel(cwd),
      branch: t.branch,
      state,
      needs,
      lastActivity: Math.max(t.lastAt, st.mtimeMs),
      plan: null,
      currentStep: t.statusSummary && t.statusSummary.taskState !== 'error' ? u.clip(t.statusSummary.summary, 140) : null,
      toolCalls: t.toolCalls,
      actions: t.actions,
      lastUser: t.lastUser ? u.clip(t.lastUser.text, 200) : null,
      lastAgent: u.clipLines(h.plain(t.lastAssistantText), 900),
      resume: cwd ? `cd ${JSON.stringify(cwd)} && prime-agent` : null,
    });
  }
  return out;
}

module.exports = { collect };
