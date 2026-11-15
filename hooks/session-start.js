#!/usr/bin/env node
'use strict';
/**
 * Plugin SessionStart hook. Remembers where the plugin is installed (so /dashboard can start it)
 * and when the Notification hook first became active (so sessions started after that skip guessing).
 * Never prints anything and never fails: it must not get in Claude Code's way.
 */
const fs = require('node:fs');
const path = require('node:path');
try {
  const p = require('../lib/paths');
  fs.mkdirSync(p.STATE, { recursive: true });
  fs.writeFileSync(p.PLUGIN_ROOT_FILE, path.resolve(__dirname, '..') + '\n');
  if (!fs.existsSync(p.HOOK_INSTALLED_FILE)) fs.writeFileSync(p.HOOK_INSTALLED_FILE, new Date().toISOString() + '\n');
} catch {}
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 2000).unref();
