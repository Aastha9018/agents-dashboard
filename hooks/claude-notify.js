#!/usr/bin/env node
'use strict';
/**
 * Claude Code Notification hook. Claude Code runs this when a session shows a permission
 * prompt or has been idle waiting for input. It records the event so the dashboard can show
 * an exact "Waiting for permission" state instead of guessing.
 */
const fs = require('node:fs');
const path = require('node:path');

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(input);
    if (!ev.session_id) return;
    const dir = require('../lib/paths').HOOK_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${ev.session_id}.json`),
      JSON.stringify({ at: Date.now(), message: ev.message || '', notification_type: ev.notification_type || '', cwd: ev.cwd || '' }),
    );
  } catch {
    /* never block Claude Code */
  }
});
