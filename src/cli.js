#!/usr/bin/env node
'use strict';

const { analyseLatestSession } = require('./monitor');
const { install, uninstall } = require('./hooks');
const { load: loadConfig, configPath } = require('./config');

const cwd = process.cwd();

function formatRatio(ratio) {
  if (ratio === null) return 'N/A';
  return ratio.toFixed(1);
}

function ratioStatus(ratio, min) {
  if (ratio === null) return '';
  return ratio >= min ? 'healthy' : 'degraded';
}

function ratioIcon(ratio, min) {
  if (ratio === null) return '';
  return ratio >= min ? 'OK' : '!!';
}

// ── commands ──────────────────────────────────────────────────────────────────

function cmdStatus() {
  const config = loadConfig();
  const result = analyseLatestSession(cwd);

  if (!result) {
    console.log('No session data found for current directory.');
    console.log('Make sure Claude Code has been run in this directory.');
    process.exit(0);
  }

  const { reads, edits, totalToolCalls, ratio, filePath } = result;
  const status = ratioStatus(ratio, config.minReadToEditRatio);
  const icon = ratioIcon(ratio, config.minReadToEditRatio);

  console.log('');
  console.log('Session Quality Report');
  console.log('──────────────────────────');
  console.log(`Read-to-edit ratio:  ${formatRatio(ratio)}  ${icon}  (${status || 'no edits yet'})`);
  console.log(`Total tool calls:    ${totalToolCalls}`);
  console.log(`File edits:          ${edits}`);
  console.log(`Files read:          ${reads}`);

  if (ratio !== null && ratio < config.minReadToEditRatio && edits >= config.alertAfterEdits) {
    console.log(`Recommendation:      Run /compact now or start a new session`);
  }

  console.log(`Session file:        ${filePath}`);
  console.log('');
}

function cmdCheck() {
  // Called by Claude Code hook via stdin; read JSON then analyse.
  // Alerts go to stderr to avoid interfering with hook processing.
  const config = loadConfig();

  const timeout = setTimeout(() => {
    process.exit(0);
  }, 2000);
  timeout.unref();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let hookCwd = cwd;
    try {
      const data = JSON.parse(raw);
      if (data.cwd) hookCwd = data.cwd;
    } catch {
      // ignore parse errors — use process.cwd()
    }

    const result = analyseLatestSession(hookCwd);
    if (!result) process.exit(0);

    const { reads, edits, ratio } = result;

    if (config.silent) process.exit(0);
    if (edits < config.alertAfterEdits) process.exit(0);
    if (ratio === null) process.exit(0);

    if (ratio < config.minReadToEditRatio) {
      process.stderr.write('\n');
      process.stderr.write('WARNING: claude-context-guard: Context quality dropping\n');
      process.stderr.write(`    Read-to-edit ratio: ${formatRatio(ratio)} (healthy: >${config.minReadToEditRatio})\n`);
      process.stderr.write('    Claude is editing without reading enough context.\n');
      process.stderr.write('    Consider running /compact or starting a fresh session.\n');
      process.stderr.write('\n');
      process.exit(1);
    }

    process.exit(0);
  });
}

function cmdInstall() {
  const result = install();
  if (result.alreadyInstalled) {
    console.log('claude-context-guard is already installed.');
  } else {
    console.log('Installed successfully.');
  }
  console.log(`Settings: ${result.settingsPath}`);
}

function cmdUninstall() {
  const result = uninstall();
  if (!result.wasInstalled) {
    console.log('claude-context-guard was not installed.');
  } else {
    console.log('Uninstalled successfully.');
  }
  console.log(`Settings: ${result.settingsPath}`);
}

function cmdConfig() {
  const config = loadConfig();
  console.log('');
  console.log('Current configuration:');
  console.log(JSON.stringify(config, null, 2));
  console.log('');
  console.log(`Config file: ${configPath()}`);
  console.log('');
}

function cmdHelp() {
  console.log('');
  console.log('Usage: claude-context-guard <command>');
  console.log('');
  console.log('Commands:');
  console.log('  status      Show session quality report for current directory');
  console.log('  check       Hook mode: read stdin JSON and alert if degraded');
  console.log('  install     Add PostToolUse hook to ~/.claude/settings.json');
  console.log('  uninstall   Remove the hook from ~/.claude/settings.json');
  console.log('  config      Show current configuration');
  console.log('  help        Show this help message');
  console.log('');
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const command = process.argv[2] || 'help';

switch (command) {
  case 'status':    cmdStatus();    break;
  case 'check':     cmdCheck();     break;
  case 'install':   cmdInstall();   break;
  case 'uninstall': cmdUninstall(); break;
  case 'config':    cmdConfig();    break;
  case 'help':
  default:
    cmdHelp();
    break;
}
