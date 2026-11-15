'use strict';
/**
 * Sample sessions for demos and screen recordings (/?demo=1). They are mixed in with the real ones,
 * marked "Demo", and never touch anything: opening one only shows a message.
 */
const MIN = 60_000;

function sessions(now) {
  const t = (m) => now - m * MIN;
  const base = { running: true, pid: null, cwd: '', cwdShort: '', resume: null, actions: [], toolCalls: 0, lastUser: null, goal: null, prLink: null, turnEnded: true, helpers: [], demo: true };
  const checkout = {
    ...base, key: 'demo:claude-checkout', agent: 'claude', agentLabel: 'Claude Code · CLI', id: 'demo-checkout', surface: 'terminal',
    title: 'Checkout page redesign', project: 'web-shop', branch: 'feat/checkout-redesign', state: 'working', needs: null,
    lastActivity: t(0.3), currentStep: 'Run the checkout e2e tests',
    plan: [{ content: 'Rebuild the summary card', status: 'completed' }, { content: 'Add Apple Pay button', status: 'completed' }, { content: 'Run the checkout e2e tests', status: 'in_progress' }, { content: 'Open a pull request', status: 'pending' }],
    lastAgent: 'Rebuilt the order summary and added Apple Pay.', lastAgentAt: t(4),
    pr: { number: 412, title: 'Checkout page redesign', url: 'https://github.com/', repo: 'acme/web-shop', branch: 'feat/checkout-redesign', state: 'OPEN', draft: false, review: 'REVIEW_REQUIRED', mergeState: 'CLEAN',
      checks: { total: 6, passed: 4, skipped: 0, failed: [], queued: 0, running: [{ name: 'e2e (chromium)', workflow: 'CI', url: '', startedAt: new Date(t(2)).toISOString(), step: 'Run Playwright', stepOf: '5/8' }, { name: 'Lighthouse', workflow: 'CI', url: '', startedAt: new Date(t(1)).toISOString(), step: 'Audit', stepOf: '3/4' }] } },
    subs: [
      { kind: 'helper', key: 'demo:claude-checkout/a1', id: 'a1', title: 'Fix flaky payment test', type: 'general-purpose', background: false, state: 'needs_you', doing: null, lastActivity: t(0.5), openKey: 'demo:claude-checkout', approvalKey: 'demo:claude-checkout', needs: { kind: 'approval', certain: true, label: 'Waiting for approval', detail: 'Run a command: npx playwright test payment.spec.ts' } },
      { kind: 'helper', key: 'demo:claude-checkout/a2', id: 'a2', title: 'Check the page on mobile sizes', type: 'Explore', background: true, state: 'working', doing: 'Took a browser screenshot', lastActivity: t(0.2), openKey: 'demo:claude-checkout', approvalKey: null, needs: null },
      { kind: 'helper', key: 'demo:claude-checkout/a3', id: 'a3', title: 'Find unused CSS', type: 'Explore', background: true, state: 'done', doing: null, lastActivity: t(9), openKey: 'demo:claude-checkout', approvalKey: null, needs: null },
    ],
  };
  const codex = {
    ...base, key: 'demo:codex-webhooks', agent: 'codex', agentLabel: 'Codex', id: 'demo-codex', surface: 'terminal',
    title: 'Refactor payment webhooks', project: 'payments-api', branch: 'codex/webhooks', state: 'working', needs: null,
    lastActivity: t(0.4), currentStep: 'Updating webhook signature checks', plan: null, lastAgent: 'Moved retries into a queue.', lastAgentAt: t(6), subs: [],
  };
  const prime = {
    ...base, key: 'demo:prime-release', agent: 'prime', agentLabel: 'Prime Agent', id: 'demo-prime', surface: 'terminal',
    title: 'Release notes for v2.4', project: 'mobile-app', branch: 'main', state: 'needs_you',
    needs: { kind: 'question', certain: true, label: 'Asking you a question', detail: 'Should the release notes mention the new referral bonus, or keep it for the marketing post?' },
    lastActivity: t(1), currentStep: null, plan: null, lastAgent: 'Drafted the release notes from 38 merged PRs.', lastAgentAt: t(1), subs: [],
  };
  const app = {
    ...base, key: 'demo:claude-onboarding', agent: 'claude', agentLabel: 'Claude Code · app', id: 'demo-onboarding', surface: 'desktop',
    title: 'Onboarding emails', project: 'growth', branch: 'feat/onboarding', state: 'your_turn', needs: null,
    lastActivity: t(3), currentStep: null, plan: null, lastAgent: 'All three onboarding emails are written and previewed. Ready for your review.', lastAgentAt: t(3), subs: [],
  };
  return [prime, checkout, codex, app];
}

function timeline(key, now) {
  const t = (m) => now - m * MIN;
  const turns = {
    'demo:claude-checkout': [
      { n: 1, at: t(40), endAt: t(25), prompt: 'Redesign the checkout page: cleaner summary card and an Apple Pay button.', points: [
        { group: 'explore', title: 'Looked through the code', detail: '12 files read · 4 searches', at: t(39) },
        { group: 'plan', title: 'Made a plan with 4 steps', list: ['Rebuild the summary card', 'Add Apple Pay button', 'Run the checkout e2e tests', 'Open a pull request'], at: t(37) },
        { group: 'edit', title: 'Worked on the change', detail: '7 files changed · 9 commands', list: ['src/checkout/Summary.tsx', 'src/checkout/ApplePay.tsx'], at: t(30) },
        { group: 'browser', title: 'Checked it in the browser', detail: '4 browser actions', at: t(26) },
      ], reply: 'Rebuilt the order summary and added Apple Pay. Next I am running the e2e tests.', shots: [], youShots: [] },
      { n: 2, at: t(5), endAt: t(0.3), prompt: 'Looks good, run the tests and open a PR.', points: [
        { group: 'push', title: 'Pushed to GitHub', at: t(4) },
        { group: 'pr', title: 'Opened a pull request', detail: 'acme/web-shop#412', at: t(3) },
        { group: 'agent', title: 'Started 3 helper agents', list: ['Fix flaky payment test', 'Check the page on mobile sizes', 'Find unused CSS'], at: t(2) },
      ], reply: null, shots: [], youShots: [] },
    ],
  };
  const list = turns[key] || [{ n: 1, at: t(20), endAt: t(1), prompt: 'Sample session for the demo.', points: [{ group: 'explore', title: 'Looked through the code', detail: '6 files read', at: t(18) }, { group: 'edit', title: 'Changed 2 files', at: t(10) }], reply: 'This is sample data for the demo.', shots: [], youShots: [] }];
  return { totalTurns: list.length, turns: list };
}

module.exports = { sessions, timeline };
