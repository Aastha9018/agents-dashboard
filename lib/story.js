'use strict';
/**
 * Condense a turn's raw steps into a few "main points" for the flowchart, in order.
 * Consecutive steps of the same sort merge into one point ("Changed 3 files").
 */
const u = require('./util');

function cmdOf(st) {
  return `${st.detail || ''} ${st.text || ''}`;
}

/** Which flowchart group a raw step belongs to (null = leave it out). */
function groupOf(st) {
  if (st.kind === 'say') return null;
  if (st.kind === 'read' || st.kind === 'search' || st.kind === 'web') return 'explore';
  if (st.kind === 'edit') return 'edit';
  if (st.kind === 'ask') return 'ask';
  if (st.kind === 'agent') return 'agent';
  if (st.kind === 'plan') {
    if (/^Made a plan|^Updated its to-do list/.test(st.text)) return 'plan';
    return null; // "moved to next step", wrap-up: the reply covers it
  }
  if (st.kind === 'command') {
    const c = st.detail || st.text.replace(/^Ran a command: /, ''); // the real command when known
    const at = (re) => new RegExp(`(^|&&|;|\\|\\||\\n|\\$\\()\\s*${re}`).test(c); // only when the command itself starts with it
    if (at('gh pr create\\b')) return 'pr';
    if (at('gh pr merge\\b')) return 'merge';
    if (at('git (-C \\S+ )?push\\b')) return 'push';
    if (at('git (-C \\S+ )?commit\\b')) return 'commit';
    if (at('gh (run|pr checks)\\b')) return 'ci';
    if (at('(fly deploy|terraform apply|kubectl apply|npm run deploy)\\b')) return 'deploy';
    return 'run'; // tests and other commands share one point; it says when checks ran
  }
  if (/^Error/.test(st.text)) return 'error';
  if (/^(Used Task(Stop|Output|Create|Update|List|Get)|Loaded extra tools|App |Used (Monitor|ScheduleWakeup|SendUserFile))/i.test(st.text)) return null; // housekeeping
  if (/^(Browser|claude-in-chrome|Claude in Chrome)[: ]/i.test(st.text)) return 'browser';
  return 'other';
}

const SINGLE = new Set(['ask', 'pr', 'merge', 'commit', 'error', 'plan', 'deploy']); // never merged

function strip(text) {
  return String(text || '').replace(/^Ran (a command|Python): /, '');
}

function commitMsg(st) {
  const m = cmdOf(st).match(/-m\s+(?:"([^"]+)"|'([^']+)'|\$\(cat <<'?EOF'?\s+([^\n]+))/);
  return m ? (m[1] || m[2] || m[3] || '').split('\n')[0] : strip(st.text);
}

/** Plain words for one command: "Checked git", "Ran tests"… (null = no good name). */
function cmdName(c) {
  const segs = String(c || '').split(/\s*(?:&&|;|\|\|)\s*/).map((x) => x.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=('[^']*'|"[^"]*"|\S*)\s+)+/, '')).filter((x) => x && !/^(cd|export)\b/.test(x) && !/^[A-Z_][A-Z0-9_]*=/.test(x));
  const first = segs[0] || '';
  const any = (re) => segs.some((x) => re.test(x));
  if (any(/\b(vitest|jest|pytest|playwright|npm (run )?test|pnpm test|yarn test|go test)\b/)) return 'Ran tests';
  if (any(/\b(typecheck|tsc\b|eslint|lint)\b/)) return 'Ran checks';
  if (any(/\b(npm|pnpm|yarn) (run )?build\b/)) return 'Built it';
  if (/^gh api .*\/(comments|replies|reviews)/.test(first) && /-f |--field|-X POST/.test(first)) return 'Replied on GitHub';
  if (/^gh (pr|issue) (view|list|diff|status)/.test(first) || /^gh api .*pulls/.test(first)) return 'Checked the pull request';
  if (/^gh (run|workflow)/.test(first)) return 'Checked GitHub Actions';
  if (/^gh /.test(first)) return 'Used GitHub';
  if (/^git (fetch|pull)/.test(first)) return 'Fetched the latest code';
  if (/^git (merge|rebase)/.test(first)) return 'Merged branches';
  if (/^git (log|status|diff|show|ls-remote|branch|rev-parse|merge-tree)/.test(first)) return 'Checked git';
  if (/^(grep|rg|find|ls|cat|head|tail|sed -n|wc)\b/.test(first)) return 'Looked through files';
  if (/^(curl|wget)\b/.test(first)) return 'Called a URL';
  if (/^(python3?|node)\b/.test(first)) return 'Ran a script';
  if (/^(npm|pnpm|yarn) (i|install|add)\b/.test(first)) return 'Installed packages';
  return null;
}

function point(group, steps) {
  const at = steps[0].at;
  const endAt = steps[steps.length - 1].at;
  const n = steps.length;
  const first = steps[0];
  const many = (one, few) => (n === 1 ? one : few);
  switch (group) {
    case 'explore': {
      const reads = steps.filter((s) => s.kind === 'read').length;
      const searches = steps.filter((s) => s.kind === 'search').length;
      const web = steps.filter((s) => s.kind === 'web').length;
      const parts = [reads && `${reads} file${reads > 1 ? 's' : ''} read`, searches && `${searches} search${searches > 1 ? 'es' : ''}`, web && `${web} web lookup${web > 1 ? 's' : ''}`].filter(Boolean);
      return { group, title: web && !reads && !searches ? 'Looked things up online' : 'Looked through the code', detail: parts.join(' · '), at, endAt };
    }
    case 'edit': {
      const files = [...new Set(steps.map((s) => s.text.replace(/^(Edited|Wrote)( notebook)? /, '')))];
      return { group, title: `Changed ${files.length} file${files.length > 1 ? 's' : ''}`, list: files.slice(0, 6), more: Math.max(0, files.length - 6), at, endAt };
    }
    case 'run': {
      const checks = steps.filter((s) => /\b(tests?|vitest|jest|pytest|playwright|typecheck|lint|eslint|build)\b/i.test(s.text)).length;
      if (n === 1) {
        const raw = strip(first.text);
        const name = cmdName(first.detail || raw);
        return { group, title: name || 'Ran a command', list: [u.clip(raw, 200)], at, endAt }; // the raw command shows only when opened
      }
      const names = [...new Set(steps.map((s) => cmdName(s.detail || strip(s.text))).filter(Boolean))];
      const title = `Ran ${n} commands${checks ? `, ${checks} of them checks` : ''}`;
      const list = [...new Set(steps.map((s) => u.clip(strip(s.text), 90)))].slice(-3);
      return { group, title, detail: names.slice(0, 3).join(', '), list, at, endAt };
    }
    case 'ci':
      return { group, title: 'Checked GitHub Actions', detail: u.clip(strip(steps[n - 1].text), 110), at, endAt };
    case 'push':
      return { group, title: 'Pushed to GitHub', at, endAt };
    case 'commit':
      return { group, title: 'Committed', detail: u.clip(commitMsg(first), 110), at, endAt };
    case 'pr':
      return { group, title: 'Opened a pull request', detail: u.clip(strip(first.text), 110), at, endAt };
    case 'merge':
      return { group, title: 'Merged the pull request', at, endAt };
    case 'deploy':
      return { group, title: 'Deployed', detail: u.clip(strip(first.text), 110), at, endAt };
    case 'plan':
      return { group, title: first.list && first.list.length ? `Made a plan with ${first.list.length} steps` : 'Made a plan', list: first.list ? first.list.slice(0, 8) : null, at, endAt };
    case 'ask':
      return { group, title: 'Asked you a question', detail: u.clip(first.text.replace(/^Asked you: /, ''), 160), at, endAt };
    case 'agent':
      return { group, title: many('Started a helper agent', `Started ${n} helper agents`), list: steps.slice(0, 3).map((s) => u.clip(s.text.replace(/^Started a helper agent: /, ''), 80)), at, endAt };
    case 'browser':
      return { group, title: 'Checked it in the browser', detail: n > 1 ? `${n} browser actions` : '', at, endAt };
    case 'error':
      return { group, title: 'Hit an error', detail: u.clip(first.text.replace(/^Error: /, ''), 160), at, endAt };
    default: {
      const names = [...new Set(steps.map((s) => u.clip(s.text, 50)))];
      return { group: 'other', title: n === 1 ? names[0] : `Used ${n} tools`, list: n > 1 ? names.slice(0, 3) : null, at, endAt };
    }
  }
}

function condense(steps) {
  const out = [];
  let cur = null;
  for (const st of steps) {
    const g = groupOf(st);
    if (!g) continue;
    if (cur && cur.group === g && !SINGLE.has(g)) cur.steps.push(st);
    else out.push((cur = { group: g, steps: [st] }));
  }
  return foldRoutine(out.map((c) => point(c.group, c.steps)), out);
}

const ROUTINE = new Set(['explore', 'edit', 'run', 'other', 'browser', 'agent']);

/** 3+ routine points in a row → one "Worked on it" point, so milestones stand out. */
function foldRoutine(points, raw) {
  const res = [];
  for (let i = 0; i < points.length; ) {
    let j = i;
    while (j < points.length && ROUTINE.has(points[j].group)) j++;
    if (j - i >= 3) {
      const steps = raw.slice(i, j).flatMap((c) => c.steps);
      const count = (k) => steps.filter((s) => s.kind === k).length;
      const files = [...new Set(steps.filter((s) => s.kind === 'edit').map((s) => s.text.replace(/^(Edited|Wrote)( notebook)? /, '')))];
      const reads = count('read') + count('search') + count('web');
      const cmds = count('command');
      const browser = raw.slice(i, j).filter((c) => c.group === 'browser').length;
      const detail = [files.length && `${files.length} file${files.length > 1 ? 's' : ''} changed`, cmds && `${cmds} command${cmds > 1 ? 's' : ''}`, reads && `${reads} look-up${reads > 1 ? 's' : ''}`, browser && 'checked in the browser'].filter(Boolean).join(' · ');
      res.push({ group: files.length ? 'edit' : 'run', title: files.length ? 'Worked on the change' : 'Investigated', detail, list: files.slice(0, 6), more: Math.max(0, files.length - 6), at: points[i].at, endAt: points[j - 1].endAt });
      i = j;
    } else {
      res.push(...points.slice(i, j));
      if (j < points.length) res.push(points[j]);
      i = j + 1;
    }
  }
  return res;
}

module.exports = { condense };
