'use strict';
/**
 * Full session history, split into turns: what you asked → what the agent did → what it replied.
 * Read on demand (only when a card is expanded), so whole transcripts are fine.
 */
const fs = require('node:fs');
const u = require('./util');
const h = require('./humanize');
const story = require('./story');

const MAX_TURNS = 60;
const MAX_STEPS = 250;

function readAll(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    const o = u.safeJson(l);
    if (o) out.push(o);
  }
  return out;
}

function newTurn(prompt, at) {
  return { prompt: prompt ? u.clipLines(h.cleanPrompt(prompt), 2000) : null, at, endAt: at, steps: [], reply: null, said: [], files: new Set(), counts: { command: 0, edit: 0, read: 0, search: 0, web: 0, agent: 0, plan: 0, ask: 0, other: 0 } };
}

function addStep(turn, at, step) {
  turn.counts[step.kind] = (turn.counts[step.kind] || 0) + 1;
  if (step.file) turn.files.add(step.file);
  if (turn.steps.length < MAX_STEPS) turn.steps.push({ at, kind: step.kind, text: step.text, detail: step.detail || '', list: step.list || null });
  if (at) turn.endAt = Math.max(turn.endAt || 0, at);
}

function addText(turn, at, text) {
  if (!text || !text.trim()) return;
  turn.reply = text;
  if (turn.steps.length < MAX_STEPS) turn.steps.push({ at, kind: 'say', text: u.clip(h.plain(text), 300) });
  if (at) turn.endAt = Math.max(turn.endAt || 0, at);
}

function finish(turns, cwd) {
  const list = turns.filter((t) => t.prompt || t.steps.length);
  const total = list.length;
  return {
    totalTurns: total,
    turns: list.slice(-MAX_TURNS).map((t, i) => {
      // The final reply already shows below the steps; drop its duplicate "said" step.
      if (t.reply && t.steps.length && t.steps[t.steps.length - 1].kind === 'say') t.steps.pop();
      return {
        n: total - Math.min(total, MAX_TURNS) + i + 1,
        at: t.at,
        endAt: t.endAt,
        prompt: t.prompt,
        reply: t.reply ? u.clipLines(h.plain(t.reply), 4000) : null,
        points: story.condense(t.steps),
        steps: t.steps,
        counts: t.counts,
        files: [...t.files].map((f) => (cwd && f.startsWith(cwd + '/') ? f.slice(cwd.length + 1) : u.shortPath(f))),
      };
    }),
  };
}

function claude(file, cwd) {
  const recs = readAll(file);
  const turns = [newTurn(null, 0)];
  for (const r of recs) {
    if (r.isSidechain) continue;
    const at = u.ts(r.timestamp);
    if (r.cwd) cwd = cwd || r.cwd;
    const content = r.message && r.message.content;
    if (r.type === 'user' && !r.isMeta) {
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content) && !content.some((c) => c.type === 'tool_result')) text = u.textOf(content);
      text = h.cleanPrompt(text);
      if (text && !/^<(command-|local-command|task-notification|side-sessions-event|ci-monitor-event)/.test(text) && !text.startsWith('[Request interrupted')) {
        if (text.startsWith('This session is being continued from a previous conversation')) text = 'Session continued (earlier conversation was summarized to free up memory)';
        turns.push(newTurn(text, at));
      }
      continue;
    }
    if (r.type !== 'assistant' || !Array.isArray(content)) continue;
    const turn = turns[turns.length - 1];
    for (const c of content) {
      if (c.type === 'text') addText(turn, at, c.text);
      else if (c.type === 'tool_use') addStep(turn, at, h.claudeTool(c.name, c.input || {}, cwd));
    }
  }
  return finish(turns, cwd);
}

function prime(file, cwd) {
  const recs = readAll(file);
  const turns = [newTurn(null, 0)];
  for (const r of recs) {
    if (r.type === 'session' && r.cwd) cwd = cwd || r.cwd;
    if (r.type !== 'message' || !r.message) continue;
    const m = r.message;
    const at = u.ts(r.timestamp);
    if (m.role === 'user') {
      const t = u.textOf(m.content).trim();
      if (t) turns.push(newTurn(t, at));
    } else if (m.role === 'assistant') {
      const turn = turns[turns.length - 1];
      for (const c of m.content || []) {
        if (c.type === 'text') addText(turn, at, c.text);
        else if (c.type === 'toolCall') addStep(turn, at, h.primeTool(c.name, c.arguments || {}));
      }
      if (m.stopReason === 'error') addStep(turn, at, { kind: 'other', text: `Error: ${u.clip(m.errorMessage || 'model request failed', 160)}` });
    }
  }
  return finish(turns, cwd);
}

function codex(file, cwd) {
  const recs = readAll(file);
  const turns = [newTurn(null, 0)];
  for (const r of recs) {
    const at = u.ts(r.timestamp);
    const p = r.payload || {};
    if (r.type === 'session_meta' && p.cwd) cwd = cwd || p.cwd;
    if (r.type === 'event_msg' && p.type === 'user_message' && p.message) turns.push(newTurn(p.message, at));
    else if (r.type === 'event_msg' && p.type === 'agent_message') addText(turns[turns.length - 1], at, p.message);
    else if (r.type === 'response_item' && ['function_call', 'local_shell_call', 'custom_tool_call'].includes(p.type)) addStep(turns[turns.length - 1], at, h.codexTool(p));
  }
  return finish(turns, cwd);
}

function build(session) {
  if (!session || !session.file) return { totalTurns: 0, turns: [] };
  if (session.agent === 'claude') return claude(session.file, session.cwd);
  if (session.agent === 'prime') return prime(session.file, session.cwd);
  if (session.agent === 'codex') return codex(session.file, session.cwd);
  return { totalTurns: 0, turns: [] };
}

module.exports = { build };
