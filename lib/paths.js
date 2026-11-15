'use strict';
/**
 * Where the dashboard keeps its own small state (hook signals, share key, server log).
 * Outside the code folder on purpose: a plugin's folder is replaced on every update.
 * Override with AGENTS_DASHBOARD_HOME.
 */
const path = require('node:path');
const os = require('node:os');

const STATE = process.env.AGENTS_DASHBOARD_HOME || path.join(os.homedir(), '.agents-dashboard');

module.exports = {
  STATE,
  HOOK_DIR: path.join(STATE, 'claude-notify'),
  HOOK_INSTALLED_FILE: path.join(STATE, 'hook-installed-at'),
  SHARE_KEY_FILE: path.join(STATE, 'share-key'),
  PLUGIN_ROOT_FILE: path.join(STATE, 'plugin-root'),
};
