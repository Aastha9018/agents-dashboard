#!/usr/bin/env node
'use strict';
/**
 * Adds (or removes, with --remove) a Notification hook to ~/.claude/settings.json so the
 * dashboard knows exactly when a Claude Code session is waiting for permission.
 * A backup is written to ~/.claude/settings.json.agents-dashboard.bak first.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const file = path.join(os.homedir(), '.claude', 'settings.json');
const hookScript = path.resolve(__dirname, '..', 'hooks', 'claude-notify.js');
const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`;
const remove = process.argv.includes('--remove');

const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
fs.writeFileSync(file + '.agents-dashboard.bak', JSON.stringify(settings, null, 2));

settings.hooks = settings.hooks || {};
const groups = (settings.hooks.Notification || []).map((g) => ({
  ...g,
  hooks: (g.hooks || []).filter((h) => !(h.command || '').includes('claude-notify.js')),
})).filter((g) => g.hooks.length);

if (!remove) groups.push({ matcher: '', hooks: [{ type: 'command', command }] });
if (groups.length) settings.hooks.Notification = groups;
else delete settings.hooks.Notification;

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
const marker = require('../lib/paths').HOOK_INSTALLED_FILE;
if (remove) {
  // The plugin's own hook uses the same marker: keep it while the plugin is installed.
  if (!fs.existsSync(require('../lib/paths').PLUGIN_ROOT_FILE)) fs.rmSync(marker, { force: true });
}
else {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString() + '\n');
}
console.log(remove ? 'Removed the agents-dashboard Notification hook.' : `Installed Notification hook → ${command}`);
console.log(`Backup: ${file}.agents-dashboard.bak`);
console.log('New Claude Code sessions pick it up automatically; running sessions may need a restart.');
