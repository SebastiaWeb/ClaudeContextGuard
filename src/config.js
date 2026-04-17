'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'context-guard.json');

const DEFAULTS = {
  minReadToEditRatio: 4.0,
  alertAfterEdits: 10,
  silent: false,
  slidingWindowSize: 40,
  blindEditLookback: 10,
  thrashingThreshold: 3,
};

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}

function save(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function configPath() {
  return CONFIG_PATH;
}

module.exports = { load, save, configPath, DEFAULTS };
