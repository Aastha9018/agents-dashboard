#!/usr/bin/env node
'use strict';
/**
 * Agents dashboard: one local page showing every Claude Code, Codex and Prime Agent session
 * on this Mac, and which ones are waiting on you.
 *
 *   node server.js            → http://localhost:4777
 *   PORT=5000 node server.js
 *   NOTIFY=0 node server.js   → no macOS notifications
 *   RECENT_HOURS=48 node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const claude = require('./lib/claude');
const codex = require('./lib/codex');
const prime = require('./lib/prime');
const { focusSession, notify, focusedKeys, appSessions, appSessionByLocal } = require('./lib/focus');
const timeline = require('./lib/timeline');
const alerts = require('./lib/alerts');
const github = require('./lib/github');
const demo = require('./lib/demo');

const PORT = Number(process.env.PORT || 4777);

// ---- sharing (e.g. through ngrok) ----
// Requests that arrive through a tunnel carry X-Forwarded-For. They must bring the share key once
// (?key=…, then a cookie), and they are view-only: no opening sessions on this Mac, no alerts.
const { SHARE_KEY_FILE } = require('./lib/paths');
function shareKey() {
  try {
    return fs.readFileSync(SHARE_KEY_FILE, 'utf8').trim();
  } catch {
    const k = require('node:crypto').randomBytes(12).toString('base64url');
    fs.mkdirSync(path.dirname(SHARE_KEY_FILE), { recursive: true });
    fs.writeFileSync(SHARE_KEY_FILE, k, { mode: 0o600 });
    return k;
  }
}
const SHARE_KEY = process.env.SHARE_KEY || shareKey();
function isRemote(req) {
  return !!(req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']);
}
function cookieKey(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)ad_key=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && require('node:crypto').timingSafeEqual(x, y);
}
const RECENT_MS = Number(process.env.RECENT_HOURS || 24) * 3600_000;
const NOTIFY = process.env.NOTIFY !== '0';

// User settings, saved in ~/.agents-dashboard/settings.json. sound: play a sound with alerts (false = silent).
const { SETTINGS_FILE } = require('./lib/paths');
const settings = { sound: process.env.SOUND !== '0' };
try {
  Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
} catch {}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}
const POLL_MS = 4000;

const SOURCES = [
  ['claude', claude],
  ['codex', codex],
  ['prime', prime],
];

const STATE_ORDER = { needs_you: 0, your_turn: 1, working: 2, idle: 3, ended: 4 };

let snapshot = { generatedAt: 0, sessions: [], errors: {} };

function scan() {
  const now = Date.now();
  const sessions = [];
  const errors = {};
  for (const [name, src] of SOURCES) {
    try {
      sessions.push(...src.collect({ recentMs: RECENT_MS, now }));
    } catch (e) {
      errors[name] = String((e && e.message) || e);
    }
  }
  sessions.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.lastActivity - a.lastActivity);
  try {
    linkChildren(sessions);
  } catch (e) {
    errors.links = String((e && e.message) || e);
  }
  return { generatedAt: now, sessions, errors };
}

/**
 * Sub agents of each session: its helper agents (s.helpers) plus sessions it started
 * (Claude app "start a new session" → spawnedFrom). Sets s.parentKey on the child and s.subs on the parent.
 */
function linkChildren(sessions) {
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  const app = appSessions();
  for (const s of sessions) {
    s.subs = [];
    s.parentKey = null;
  }
  for (const s of sessions) {
    if (s.agent !== 'claude') continue;
    const me = app.get(s.id);
    if (me && me.title && /^Background \(from the session/i.test(s.title || '')) s.title = me.title; // the app's short name beats the brief's first line
    const parentApp = me && me.parentLocalId ? appSessionByLocal(me.parentLocalId) : null;
    const parent = parentApp && parentApp.cliId ? byKey.get(`claude:${parentApp.cliId}`) : null;
    if (parent && parent !== s) s.parentKey = parent.key;
  }
  for (const s of sessions) {
    for (const h of s.helpers || []) {
      s.subs.push({ ...h, key: `${s.key}/${h.id}`, openKey: s.key, approvalKey: h.approval ? s.key : null, needs: h.approval ? { kind: 'approval', certain: h.approval.certain, label: 'Waiting for approval', detail: h.approval.detail } : null });
    }
    if (s.parentKey) {
      const p = byKey.get(s.parentKey);
      const needsApproval = s.state === 'needs_you';
      p.subs.push({ id: s.id, kind: 'session', key: s.key, title: s.title, type: s.agentLabel, state: s.state, doing: s.currentStep, needs: s.needs, lastActivity: s.lastActivity, openKey: s.key, approvalKey: needsApproval ? s.key : null });
    }
  }
  const rank = { needs_you: 0, working: 1, your_turn: 2, idle: 3, stopped: 4, done: 5, ended: 6 };
  for (const s of sessions) s.subs.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || b.lastActivity - a.lastActivity);
}

// ---- notifications on state transitions ----
// The page shows alerts as browser notifications (with buttons that jump to the session).
// If no page with notification permission has polled recently, fall back to a plain macOS banner.
const lastState = new Map();
let firstScan = true;
const queue = []; // { id, at, key, title, subtitle, body, cta }
let nextId = 1;
let pageSeenAt = 0;
const PAGE_FRESH_MS = 10_000;

// Alert only when you have something to do:
//  - needs_you (certain): a question, plan, permission prompt, decision or error. Right away.
//  - finished: the turn really ended (not a pause between steps) and stayed finished for FINISH_SETTLE_MS.
const FINISH_SETTLE_MS = 20_000;
const finishing = new Map(); // key -> time it went from working to your_turn

function push(s, a, focused) {
  if (focused.has(s.key)) return; // you're already looking at it
  queue.push({ id: nextId++, at: Date.now(), ...a });
  if (queue.length > 50) queue.shift();
  if (Date.now() - pageSeenAt > PAGE_FRESH_MS) notify(a.title, a.subtitle, a.body, settings.sound);
}

function maybeNotify(sessions) {
  let focused = null; // looked up only when there's something to alert about
  const focus = () => focused || (focused = focusedKeys(sessions));
  const now = Date.now();
  for (const s of sessions) {
    const prev = lastState.get(s.key);
    const sig = s.state === 'needs_you' ? `needs:${s.needs && s.needs.kind}:${s.needs && s.needs.detail}` : s.state;
    lastState.set(s.key, sig);
    if (s.state !== 'your_turn') finishing.delete(s.key);
    if (firstScan || !NOTIFY) continue;

    if (prev !== sig && s.state === 'needs_you' && s.needs && s.needs.certain) {
      const a = alerts.forSession(s, prev);
      if (a) push(s, a, focus());
      continue;
    }
    if (prev !== sig && s.state === 'your_turn' && prev === 'working') finishing.set(s.key, now);
    const since = finishing.get(s.key);
    if (since && now - since >= FINISH_SETTLE_MS) {
      finishing.delete(s.key);
      if (s.turnEnded === false) continue; // stopped mid-task, not a real finish
      const a = alerts.forSession(s, 'working');
      if (a) push(s, a, focus());
    }
  }
  firstScan = false;
}

function tick() {
  snapshot = scan();
  for (const s of snapshot.sessions) if (s.state !== 'ended') s.pr = github.get(s); // cached; refreshes in the background
  maybeNotify(snapshot.sessions);
}

// ---- http ----
const INDEX = path.join(__dirname, 'public', 'index.html');

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const remote = isRemote(req);
  if (remote) {
    const given = url.searchParams.get('key');
    if (given && safeEqual(given, SHARE_KEY)) {
      res.writeHead(302, { 'Set-Cookie': `ad_key=${encodeURIComponent(SHARE_KEY)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`, Location: '/' });
      return res.end();
    }
    if (!safeEqual(cookieKey(req), SHARE_KEY)) return send(res, 401, 'This dashboard link needs its key. Ask the person who shared it for the full link.', 'text/plain; charset=utf-8');
    if (req.method !== 'GET') return send(res, 403, { error: 'This is a view-only link. Opening sessions only works on the host Mac.' });
    if (url.pathname === '/api/alerts') return send(res, 200, { lastId: 0, alerts: [] }); // viewers never get (or silence) alerts
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    if (url.searchParams.get('fresh') === '1') tick();
    return send(res, 200, {
      ...snapshot,
      sessions: (url.searchParams.get('demo') === '1' ? demo.sessions(Date.now()) : []).concat(snapshot.sessions.map(({ file, ...rest }) => rest)), // don't ship local paths the page doesn't need
      notify: NOTIFY,
      viewOnly: remote,
      settings,
      recentHours: RECENT_MS / 3600_000,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/alerts') {
    if (url.searchParams.get('notif') === '1') pageSeenAt = Date.now();
    const after = Number(url.searchParams.get('after') || 0);
    return send(res, 200, { lastId: nextId - 1, alerts: NOTIFY ? queue.filter((a) => a.id > after) : [] });
  }
  if (req.method === 'GET' && url.pathname === '/sw.js') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8'), 'text/javascript');
  }
  if (req.method === 'GET' && url.pathname === '/api/timeline') {
    const tkey = url.searchParams.get('key') || '';
    if (tkey.startsWith('demo:')) return send(res, 200, demo.timeline(tkey, Date.now()));
    const s = snapshot.sessions.find((x) => x.key === tkey);
    if (!s) return send(res, 404, { error: 'session not found' });
    try {
      return send(res, 200, timeline.build(s));
    } catch (e) {
      return send(res, 500, { error: String((e && e.message) || e) });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j;
      try {
        j = JSON.parse(body);
      } catch {
        return send(res, 400, { error: 'bad json' });
      }
      if (typeof j.sound === 'boolean') settings.sound = j.sound;
      try {
        saveSettings();
      } catch (e) {
        return send(res, 500, { error: String(e.message || e) });
      }
      return send(res, 200, settings);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/image') {
    const img = timeline.getShot(url.searchParams.get('key'), url.searchParams.get('id'));
    if (!img) return send(res, 404, { error: 'image not found' });
    res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    return res.end(Buffer.from(img.data, 'base64'));
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let key;
      try {
        key = JSON.parse(body).key;
      } catch {
        return send(res, 400, { error: 'bad json' });
      }
      if (String(key).startsWith('demo:')) return send(res, 200, { message: 'Demo session: on a real one, this jumps straight to it.' });
      const s = snapshot.sessions.find((x) => x.key === key);
      if (!s) return send(res, 404, { error: 'session not found' });
      return send(res, 200, { message: focusSession(s) });
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

tick();
setInterval(tick, POLL_MS);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agents dashboard → http://localhost:${PORT}  (notifications ${NOTIFY ? 'on' : 'off'})`);
  console.log(`Share through a tunnel (view-only): <tunnel url>/?key=${SHARE_KEY}`);
});
