'use strict';

const monitor = require('./monitor');
const analysis = require('./analysis');
const hooks = require('./hooks');
const config = require('./config');
const handoff = require('./handoff');

/**
 * Analyse the most recent Claude Code session for the given directory.
 *
 * @param {string} [cwd=process.cwd()] - Absolute path to the project directory.
 * @param {number|null} [contextPct=null] - Context window usage percentage (0-100).
 * @returns {object|null}
 */
function analyse(cwd, contextPct) {
  const dir = cwd || process.cwd();
  const sessions = monitor.listSessions(dir);
  if (sessions.length === 0) return null;

  const filePath = sessions[0];
  const detailed = monitor.parseSessionDetailed(filePath);
  if (!detailed) return null;

  const cfg = config.load();
  const result = analysis.analyse(detailed, contextPct || null, cfg);

  return Object.assign({ filePath }, result);
}

/**
 * Install the hooks and statusline in ~/.claude/settings.json.
 * @returns {{ alreadyInstalled: boolean, settingsPath: string }}
 */
function installHook() {
  return hooks.install();
}

/**
 * Remove the hooks and statusline from ~/.claude/settings.json.
 * @returns {{ wasInstalled: boolean, settingsPath: string }}
 */
function uninstallHook() {
  return hooks.uninstall();
}

/**
 * Load the current configuration.
 */
function getConfig() {
  return config.load();
}

/**
 * Generate a handoff markdown file from the latest session transcript.
 * See handoff.generateHandoff for the full option shape.
 */
function generateHandoffMd(opts) {
  return handoff.generateHandoff(opts);
}

module.exports = { analyse, installHook, uninstallHook, getConfig, generateHandoff: generateHandoffMd };
