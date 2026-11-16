'use strict';
/**
 * PR + GitHub Actions status for a session, via the `gh` CLI.
 * get(session) is synchronous: it returns the cached result and refreshes it in the background.
 * The PR is the one for the session's branch; failing that, the last PR link in its transcript.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');

const TTL_RUNNING_MS = 20_000; // checks running: refresh often
const TTL_IDLE_MS = 120_000;
const TTL_NONE_MS = 300_000; // no PR found
const MAX_STEP_LOOKUPS = 3;
const SKIP_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD', '']);

const cache = new Map(); // id -> { at, ttl, data, busy }
let ghMissing = false;

function run(args, cwd) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') ghMissing = true;
      resolve(err ? null : stdout);
    });
  });
}

function json(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const FIELDS = 'number,title,url,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName';

const remotes = new Map(); // dir -> "owner/repo" | null
function originRepo(dir) {
  if (!remotes.has(dir)) {
    let r = null;
    try {
      const url = require('node:child_process').execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 3000 }).trim();
      r = (url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/) || [])[1] || null;
    } catch {}
    remotes.set(dir, r);
  }
  return remotes.get(dir);
}

async function lookup(s) {
  let pr = null;
  const dir = s.cwd && fs.existsSync(s.cwd) ? s.cwd : null;
  const own = dir ? originRepo(dir) : null;
  if (dir && s.branch && !SKIP_BRANCHES.has(s.branch)) {
    pr = json(await run(['pr', 'view', s.branch, '--json', FIELDS], dir));
  }
  // A PR link in the transcript counts only if it's in this session's own repo (not one it just mentioned).
  const linkRepo = s.prLink && (s.prLink.match(/github\.com\/([^/]+\/[^/]+)\/pull/) || [])[1];
  if (!pr && s.prLink && own && linkRepo && linkRepo.toLowerCase() === own.toLowerCase()) pr = json(await run(['pr', 'view', s.prLink, '--json', FIELDS]));
  if (!pr) return null;

  const repo = (pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull/) || [])[1];
  const checks = summarize(pr.statusCheckRollup || []);
  // What is each running job doing right now? (one API call per running job, capped)
  for (const c of checks.running.slice(0, MAX_STEP_LOOKUPS)) {
    const jobId = (c.url.match(/\/job\/(\d+)/) || [])[1];
    if (!repo || !jobId) continue;
    const job = json(await run(['api', `repos/${repo}/actions/jobs/${jobId}`]));
    const steps = (job && job.steps) || [];
    const cur = steps.find((x) => x.status === 'in_progress') || steps.find((x) => x.status === 'queued');
    if (cur) c.step = cur.name;
    if (steps.length) c.stepOf = `${steps.filter((x) => x.status === 'completed').length + (cur ? 1 : 0)}/${steps.length}`;
  }
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repo,
    branch: pr.headRefName,
    state: pr.state, // OPEN | MERGED | CLOSED
    draft: !!pr.isDraft,
    review: pr.reviewDecision || null, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED
    mergeState: pr.mergeStateStatus || null, // CLEAN | BEHIND | DIRTY (conflicts) | BLOCKED | ...
    checks,
  };
}

function summarize(rollup) {
  const out = { total: 0, passed: 0, skipped: 0, failed: [], running: [], queued: 0 };
  const seen = new Set();
  for (const c of rollup) {
    const name = c.name || c.context || 'check';
    const id = `${c.workflowName || ''}/${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.total++;
    if (c.__typename === 'StatusContext') {
      if (c.state === 'SUCCESS') out.passed++;
      else if (c.state === 'PENDING' || c.state === 'EXPECTED') out.running.push({ name, workflow: '', url: c.targetUrl || '', startedAt: c.startedAt || null });
      else out.failed.push({ name, url: c.targetUrl || '' });
      continue;
    }
    if (c.status === 'IN_PROGRESS') out.running.push({ name, workflow: c.workflowName || '', url: c.detailsUrl || '', startedAt: c.startedAt || null });
    else if (c.status !== 'COMPLETED') out.queued++;
    else if (['SUCCESS', 'NEUTRAL'].includes(c.conclusion)) out.passed++;
    else if (c.conclusion === 'SKIPPED') out.skipped++;
    else out.failed.push({ name, url: c.detailsUrl || '', conclusion: c.conclusion });
  }
  return out;
}

function get(s) {
  if (ghMissing || (!s.prLink && (!s.branch || SKIP_BRANCHES.has(s.branch)))) return null;
  const id = `${s.cwd}|${s.branch}|${s.prLink}`;
  let e = cache.get(id);
  const now = Date.now();
  if (!e) cache.set(id, (e = { at: 0, ttl: 0, data: null, busy: false }));
  if (!e.busy && now - e.at > e.ttl) {
    e.busy = true;
    lookup(s)
      .then((data) => {
        e.data = data;
        e.ttl = !data ? TTL_NONE_MS : data.state === 'OPEN' && (data.checks.running.length || data.checks.queued) ? TTL_RUNNING_MS : TTL_IDLE_MS;
      })
      .catch(() => {})
      .finally(() => {
        e.at = Date.now();
        e.busy = false;
      });
  }
  return e.data;
}

// ---- every PR related to a session: state, CI and deployments ----
const LIST_FIELDS = 'number,title,url,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,headRefOid,mergeCommit,mergedAt,updatedAt';
const MAX_PRS = 6;
const MAX_PARALLEL = 3;
const prCache = new Map(); // url -> { at, ttl, data, busy }
let active = 0;
const waiting = [];
function limited(fn) {
  return new Promise((resolve) => {
    const go = () => {
      active++;
      fn().then(resolve, () => resolve(null)).finally(() => {
        active--;
        if (waiting.length) waiting.shift()();
      });
    };
    active < MAX_PARALLEL ? go() : waiting.push(go);
  });
}

const DEPLOY_ENV = /(dev|stag|prod|preview|uat|qa|sandbox|live|demo)/i;
/** Latest deployment per environment for a commit: [{ env, state, url, at }], newest first. */
async function deploymentsFor(repo, sha, merged) {
  if (!repo || !sha) return [];
  const list = json(await run(['api', `repos/${repo}/deployments?sha=${sha}&per_page=20`])) || [];
  const byEnv = new Map();
  for (const d of list) if (!byEnv.has(d.environment)) byEnv.set(d.environment, d); // API returns newest first
  let envs = [...byEnv.values()];
  const named = envs.filter((d) => DEPLOY_ENV.test(d.environment));
  envs = (named.length ? named : merged ? envs : []).slice(0, 4); // open PRs: only real environments, not CI scratch ones
  const out = [];
  for (const d of envs) {
    const st = (json(await run(['api', `repos/${repo}/deployments/${d.id}/statuses?per_page=1`])) || [])[0];
    out.push({ env: d.environment, state: st ? st.state : 'pending', url: (st && (st.log_url || st.target_url || st.environment_url)) || '', at: (st && st.created_at) || d.created_at });
  }
  const order = (e) => (/dev/i.test(e) ? 0 : /stag|uat|qa|sandbox|preview/i.test(e) ? 1 : /prod|live/i.test(e) ? 2 : 3);
  return out.sort((a, b) => order(a.env) - order(b.env));
}

async function fetchPr(url) {
  const pr = json(await run(['pr', 'view', url, '--json', LIST_FIELDS]));
  if (!pr) return null;
  const repo = (pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull/) || [])[1];
  const merged = pr.state === 'MERGED';
  const sha = merged ? pr.mergeCommit && pr.mergeCommit.oid : pr.state === 'OPEN' ? pr.headRefOid : null;
  return {
    number: pr.number, title: pr.title, url: pr.url, repo, branch: pr.headRefName,
    state: pr.state, draft: !!pr.isDraft, review: pr.reviewDecision || null, mergeState: pr.mergeStateStatus || null,
    mergedAt: pr.mergedAt || null, updatedAt: pr.updatedAt || null,
    checks: summarize(pr.statusCheckRollup || []),
    deployments: await deploymentsFor(repo, sha, merged),
  };
}

function prTtl(d) {
  if (!d) return TTL_NONE_MS;
  const busy = d.checks.running.length || d.checks.queued || d.deployments.some((x) => /pending|queued|in_progress/.test(x.state));
  if (busy) return 30_000;
  return d.state === 'OPEN' ? TTL_IDLE_MS : 600_000;
}

/** Cached details for each URL (refreshing in the background). Unknown ones are left out until fetched. */
function list(urls) {
  if (ghMissing) return [];
  const out = [];
  const now = Date.now();
  for (const url of urls.slice(0, MAX_PRS)) {
    let e = prCache.get(url);
    if (!e) prCache.set(url, (e = { at: 0, ttl: 0, data: null, busy: false }));
    if (!e.busy && now - e.at > e.ttl) {
      e.busy = true;
      limited(() => fetchPr(url))
        .then((d) => {
          if (d || !e.data) e.data = d; // keep the last good answer through a failed refresh
          e.ttl = prTtl(e.data);
        })
        .finally(() => {
          e.at = Date.now();
          e.busy = false;
        });
    }
    if (e.data) out.push(e.data);
  }
  return out;
}

/** A PR reference from a transcript → its URL. "ref:<repo>|<dir>|<n>" uses the repo, else the folder's origin. */
function resolve(ref) {
  if (!ref.startsWith('ref:')) return ref;
  const [repo, dir, n] = ref.slice(4).split('|');
  const r = repo || (dir && fs.existsSync(dir) ? originRepo(dir) : null);
  return r ? `https://github.com/${r}/pull/${n}` : null;
}

module.exports = { get, list, resolve, originRepo };
