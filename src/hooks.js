'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Try both known settings paths; prefer ~/.claude/settings.json
const SETTINGS_CANDIDATES = [
  path.join(os.homedir(), '.claude', 'settings.json'),
  path.join(os.homedir(), '.config', 'claude', 'settings.json'),
];

const HOOK_COMMAND = 'npx claude-context-guard check';
const HOOK_MATCHER = 'Edit|Write';

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

function isInstalled(settings) {
  const postToolUse = settings?.hooks?.PostToolUse;
  if (!Array.isArray(postToolUse)) return false;
  return postToolUse.some((entry) => {
    if (!Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((h) => h.type === 'command' && h.command === HOOK_COMMAND);
  });
}

function install() {
  const settingsPath = resolveSettingsPath();
  const settings = readSettings(settingsPath);

  if (isInstalled(settings)) {
    return { alreadyInstalled: true, settingsPath };
  }

  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

  settings.hooks.PostToolUse.push({
    matcher: HOOK_MATCHER,
    hooks: [
      {
        type: 'command',
        command: HOOK_COMMAND,
      },
    ],
  });

  writeSettings(settingsPath, settings);
  return { alreadyInstalled: false, settingsPath };
}

function uninstall() {
  const settingsPath = resolveSettingsPath();
  const settings = readSettings(settingsPath);

  if (!isInstalled(settings)) {
    return { wasInstalled: false, settingsPath };
  }

  settings.hooks.PostToolUse = settings.hooks.PostToolUse
    .map((entry) => {
      const filtered = (entry.hooks || []).filter(
        (h) => !(h.type === 'command' && h.command === HOOK_COMMAND)
      );
      if (filtered.length === 0) return null;
      return Object.assign({}, entry, { hooks: filtered });
    })
    .filter(Boolean);

  if (settings.hooks.PostToolUse.length === 0) {
    delete settings.hooks.PostToolUse;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeSettings(settingsPath, settings);
  return { wasInstalled: true, settingsPath };
}

module.exports = { install, uninstall, isInstalled, resolveSettingsPath };
