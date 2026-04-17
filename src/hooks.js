'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Try all known settings paths across platforms; prefer ~/.claude/settings.json
const SETTINGS_CANDIDATES = [
  path.join(os.homedir(), '.claude', 'settings.json'),           // macOS / Linux
  path.join(os.homedir(), '.config', 'claude', 'settings.json'), // Linux alt
  ...(process.env.APPDATA
    ? [path.join(process.env.APPDATA, 'Claude', 'settings.json')]
    : []),                                                         // Windows
];

const HOOK_COMMAND = 'npx claude-context-guard check';
const HOOK_MATCHER = 'Edit|Write';
const STATUSLINE_COMMAND = 'npx claude-context-guard statusline';
const SESSIONSTART_COMMAND = 'npx claude-context-guard session-start';

function resolveSettingsPath() {
  for (const p of SETTINGS_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  // Default to first candidate even if it doesn't exist yet
  return SETTINGS_CANDIDATES[0];
}

function readSettings(settingsPath) {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSettings(settingsPath, settings) {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function hasHookCommand(list, command) {
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    if (!Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((h) => h.type === 'command' && h.command === command);
  });
}

function isInstalled(settings) {
  return (
    hasHookCommand(settings?.hooks?.PostToolUse, HOOK_COMMAND) &&
    hasHookCommand(settings?.hooks?.Stop, HOOK_COMMAND) &&
    hasHookCommand(settings?.hooks?.SessionStart, SESSIONSTART_COMMAND) &&
    settings?.statusLine?.command === STATUSLINE_COMMAND
  );
}

function install() {
  const settingsPath = resolveSettingsPath();
  const settings = readSettings(settingsPath);

  if (isInstalled(settings)) {
    return { alreadyInstalled: true, settingsPath };
  }

  if (!settings.hooks) settings.hooks = {};

  // PostToolUse hook (Edit|Write)
  if (!hasHookCommand(settings.hooks.PostToolUse, HOOK_COMMAND)) {
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
    settings.hooks.PostToolUse.push({
      matcher: HOOK_MATCHER,
      hooks: [{ type: 'command', command: HOOK_COMMAND }],
    });
  }

  // Stop hook (after every Claude response)
  if (!hasHookCommand(settings.hooks.Stop, HOOK_COMMAND)) {
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    settings.hooks.Stop.push({
      hooks: [{ type: 'command', command: HOOK_COMMAND }],
    });
  }

  // SessionStart hook (auto-load handoff.md into fresh sessions)
  if (!hasHookCommand(settings.hooks.SessionStart, SESSIONSTART_COMMAND)) {
    if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];
    settings.hooks.SessionStart.push({
      hooks: [{ type: 'command', command: SESSIONSTART_COMMAND }],
    });
  }

  // Statusline
  if (settings?.statusLine?.command !== STATUSLINE_COMMAND) {
    settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND, refreshInterval: 5 };
  }

  writeSettings(settingsPath, settings);
  return { alreadyInstalled: false, settingsPath };
}

function removeHookCommand(list, command) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      const filtered = (entry.hooks || []).filter(
        (h) => !(h.type === 'command' && h.command === command)
      );
      if (filtered.length === 0) return null;
      return Object.assign({}, entry, { hooks: filtered });
    })
    .filter(Boolean);
}

function uninstall() {
  const settingsPath = resolveSettingsPath();
  const settings = readSettings(settingsPath);

  const hadPostToolUse = hasHookCommand(settings?.hooks?.PostToolUse, HOOK_COMMAND);
  const hadStop = hasHookCommand(settings?.hooks?.Stop, HOOK_COMMAND);
  const hadSessionStart = hasHookCommand(settings?.hooks?.SessionStart, SESSIONSTART_COMMAND);

  if (!hadPostToolUse && !hadStop && !hadSessionStart) {
    return { wasInstalled: false, settingsPath };
  }

  if (!settings.hooks) settings.hooks = {};

  settings.hooks.PostToolUse = removeHookCommand(settings.hooks.PostToolUse, HOOK_COMMAND);
  if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;

  settings.hooks.Stop = removeHookCommand(settings.hooks.Stop, HOOK_COMMAND);
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;

  settings.hooks.SessionStart = removeHookCommand(settings.hooks.SessionStart, SESSIONSTART_COMMAND);
  if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  // Remove statusline
  if (settings?.statusLine?.command === STATUSLINE_COMMAND) {
    delete settings.statusLine;
  }

  writeSettings(settingsPath, settings);
  return { wasInstalled: true, settingsPath };
}

module.exports = { install, uninstall, isInstalled, resolveSettingsPath };
