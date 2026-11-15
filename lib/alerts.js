'use strict';
/** Short notification text: agent → session → one line → button label. */
const h = require('./humanize');

function oneLine(s, n = 90) {
  if (!s) return '';
  let t = h.plain(String(s)).split(/\[code\]|\n\s*\|/)[0].replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim();
  const end = t.search(/[.!?](\s|$)/); // first sentence only
  if (end > 20) t = t.slice(0, end + 1);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function sessionName(s) {
  let name = String(s.title || '')
    .replace(/^Background \(from the session that started this one\):\s*/i, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[\s\-–:·]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length > 48) name = name.slice(0, 47).replace(/\s+\S*$/, '') + '…';
  const project = (s.project || '').split(' · ')[0]; // repo name, without the worktree folder
  const label = [project, name && name !== project ? name : ''].filter(Boolean).join(' · ');
  return label || 'Session';
}

/** Returns null when this session change isn't worth an alert. */
function forSession(s, prevState) {
  let line, cta;
  if (s.state === 'needs_you' && s.needs && s.needs.certain) {
    const d = oneLine(s.needs.detail);
    switch (s.needs.kind) {
      case 'question': line = d ? `Asks: ${d}` : s.needs.label; cta = 'Answer'; break;
      case 'plan': line = 'Plan ready for your approval'; cta = 'Review plan'; break;
      case 'approval': line = d ? `Needs approval: ${d}` : 'Needs your approval to continue'; cta = 'Approve'; break;
      case 'error': line = d ? `Stopped: ${d}` : 'Stopped with an error'; cta = 'Open'; break;
      default: line = s.needs.label; cta = 'Open';
    }
  } else if (s.state === 'your_turn' && prevState === 'working') {
    const d = oneLine(s.lastAgent);
    line = d ? `Done: ${d}` : 'Finished, waiting for your reply';
    cta = 'Reply';
  } else {
    return null;
  }
  return { key: s.key, title: s.agentLabel, subtitle: sessionName(s), body: line, cta };
}

module.exports = { forSession };
