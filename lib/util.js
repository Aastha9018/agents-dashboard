'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Read the last `bytes` of a file and return complete JSONL records (oldest first). */
function readJsonlTail(file, bytes = 768 * 1024) {
  const st = statSafe(file);
  if (!st) return [];
  const start = Math.max(0, st.size - bytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  let lines = buf.toString('utf8').split('\n');
  if (start > 0) lines = lines.slice(1); // first line is probably partial
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const o = safeJson(l);
    if (o) out.push(o);
  }
  return out;
}

/** Read the first `bytes` of a file and return complete JSONL records. */
function readJsonlHead(file, bytes = 128 * 1024) {
  const st = statSafe(file);
  if (!st) return [];
  const len = Math.min(bytes, st.size);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  if (len < st.size) lines.pop();
  const out = [];
  for (const l of lines) {
    const o = safeJson(l);
    if (o) out.push(o);
  }
  return out;
}

function clip(s, n = 220) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Like clip, but keeps line breaks (collapses runs of blank lines). */
function clipLines(s, n = 2500) {
  if (!s) return '';
  s = String(s).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function ts(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** Text blocks from an Anthropic-style content array or string. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text'))
    .map((c) => c.text || '')
    .join('\n');
}

function shortPath(p) {
  if (!p) return '';
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

/** Project label from a cwd: repo name, plus worktree name when inside .claude/worktrees. */
function projectLabel(cwd) {
  if (!cwd) return '';
  const m = cwd.match(/\/([^/]+)\/\.claude\/worktrees\/([^/]+)/);
  if (m) return `${m[1]} · ${m[2]}`;
  return path.basename(cwd);
}

module.exports = {
  HOME,
  pidAlive,
  safeJson,
  readJsonFile,
  statSafe,
  listDir,
  readJsonlTail,
  readJsonlHead,
  clip,
  clipLines,
  ts,
  textOf,
  shortPath,
  projectLabel,
};
