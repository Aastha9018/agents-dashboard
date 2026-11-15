'use strict';
/** Turn raw tool calls into short plain-English sentences. */
const u = require('./util');

function rel(p, cwd) {
  if (!p) return '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return u.shortPath(p);
}

function words(s) {
  return String(s)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

function mcpLabel(name) {
  // mcp__<server>__<tool>
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return null;
  let server = m[1];
  const tool = m[2];
  if (UUIDISH.test(server)) server = '';
  server = server.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/i, '').replace(/_\d+$/, '').replace(/^ccd_/, 'app ').replace(/^Claude_/, '').replace(/_/g, ' ');
  server = server.trim();
  let t = words(tool);
  if (server && t.startsWith(server.toLowerCase() + ' ')) t = t.slice(server.length + 1); // "Slack: slack send message" → "Slack: send message"
  return { server, tool: t };
}

/** kind: command | edit | read | search | web | agent | plan | ask | other */
function claudeTool(name, input = {}, cwd = '') {
  const c = (s, n = 110) => u.clip(s, n);
  switch (name) {
    case 'Bash':
      return { kind: 'command', text: `Ran a command: ${c(input.description || input.command)}`, detail: input.description ? c(input.command, 300) : '' };
    case 'Read':
      return { kind: 'read', text: `Read ${rel(input.file_path, cwd)}` };
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'edit', text: `Edited ${rel(input.file_path, cwd)}`, file: input.file_path };
    case 'Write':
      return { kind: 'edit', text: `Wrote ${rel(input.file_path, cwd)}`, file: input.file_path };
    case 'NotebookEdit':
      return { kind: 'edit', text: `Edited notebook ${rel(input.notebook_path, cwd)}`, file: input.notebook_path };
    case 'Grep':
      return { kind: 'search', text: `Searched the code for "${c(input.pattern, 60)}"` };
    case 'Glob':
      return { kind: 'search', text: `Looked for files matching ${c(input.pattern, 60)}` };
    case 'Agent':
    case 'Task':
      return { kind: 'agent', text: `Started a helper agent: ${c(input.description, 80)}` };
    case 'WebSearch':
      return { kind: 'web', text: `Searched the web for "${c(input.query, 80)}"` };
    case 'WebFetch':
      return { kind: 'web', text: `Opened a web page: ${c(input.url, 90)}` };
    case 'TodoWrite':
      return { kind: 'plan', text: `Updated its to-do list (${(input.todos || []).length} items)`, list: (input.todos || []).map((t) => t.content) };
    case 'AskUserQuestion': {
      const q = (input.questions || [])[0];
      return { kind: 'ask', text: `Asked you: ${c(q && q.question, 140)}` };
    }
    case 'ExitPlanMode':
      return { kind: 'ask', text: 'Proposed a plan for your approval' };
    case 'Skill':
      return { kind: 'other', text: `Used the "${input.skill}" skill` };
    case 'ToolSearch':
      return { kind: 'other', text: 'Loaded extra tools' };
    case 'mcp__ccd_turn__update_plan':
      return Array.isArray(input.items)
        ? { kind: 'plan', text: `Made a plan with ${input.items.length} steps`, list: input.items.map((i) => i.content) }
        : { kind: 'plan', text: 'Moved to the next step of its plan' };
    case 'mcp__ccd_turn__wrap_up':
      return { kind: 'plan', text: `Wrapped up: ${c(input.recap, 160)}` };
    default: {
      const m = mcpLabel(name);
      if (m) return { kind: 'other', text: cap(`${m.server ? m.server + ': ' : ''}${m.tool}`) };
      return { kind: 'other', text: `Used ${name}` };
    }
  }
}

function primeTool(name, args = {}) {
  if (name === 'ipython') {
    const src = String(args.code || '');
    const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
    const comment = lines.find((l) => l.startsWith('#'));
    const sh = src.match(/\bbash\(\s*(?:f|r)?(['"`]{1,3})([\s\S]+?)\1/) || src.match(/subprocess\.\w+\(\s*\[?\s*(['"])(.+?)\1/);
    const code = lines.find((l) => !l.startsWith('#') && !/^(import|from)\s/.test(l)) || lines[0] || '';
    if (comment) return { kind: 'command', text: `Ran Python: ${u.clip(comment.replace(/^#+\s*/, ''), 110)}`, detail: u.clip(code, 300) };
    if (sh) return { kind: 'command', text: `Ran a command: ${u.clip(sh[2].split(';')[0], 110)}`, detail: u.clip(sh[2], 300) };
    return { kind: 'command', text: `Ran Python: ${u.clip(code, 110)}` };
  }
  if (name === 'websearch') return { kind: 'web', text: `Searched the web for "${u.clip(args.query, 80)}"` };
  return { kind: 'other', text: `Used ${name}` };
}

function codexTool(p) {
  if (p.name === 'update_plan') return { kind: 'plan', text: 'Updated its plan' };
  if (p.name === 'apply_patch' || p.type === 'custom_tool_call') {
    const files = String(p.input || p.arguments || '').match(/\*\*\* (?:Update|Add|Delete) File: (.+)/g) || [];
    return { kind: 'edit', text: files.length ? `Edited ${files.map((f) => f.replace(/^\*\*\* \w+ File: /, '')).join(', ')}` : 'Edited files' };
  }
  const args = u.safeJson(p.arguments) || p.action || {};
  const cmd = Array.isArray(args.command) ? args.command.join(' ') : args.command || args.cmd || '';
  if (cmd) return { kind: 'command', text: `Ran a command: ${u.clip(cmd.replace(/^bash -lc /, ''), 110)}` };
  return { kind: 'other', text: `Used ${p.name || p.type}` };
}

/** Strip harness wrappers from a user prompt. */
function cleanPrompt(s) {
  if (!s) return s;
  return String(s)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_, c) => `You ran in the terminal: ${c.trim()}`)
    .replace(/<bash-(stdout|stderr)>[\s\S]*?<\/bash-\1>/g, '')
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content>/g, (_, body) => `[pasted text] ${body.trim()}`)
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
}

/** Light markdown → plain text for snippets. */
function plain(s) {
  if (!s) return '';
  return String(s)
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

module.exports = { claudeTool, primeTool, codexTool, plain, cleanPrompt };
