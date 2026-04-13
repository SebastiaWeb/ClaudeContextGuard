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

// ── commands ──────────────────────────────────────────────────────────────────

function cmdStatus() {
  const config = loadConfig();
  const result = analyseLatestSession(cwd);

  if (!result) {
    console.log('');
    console.log('No hay datos de sesión para este directorio.');
    console.log('Asegúrate de haber usado Claude Code aquí primero.');
    console.log('');
    process.exit(0);
  }

  const { edits, ratio } = result;
  const degraded = ratio !== null && ratio < config.minReadToEditRatio && edits >= config.alertAfterEdits;

  console.log('');
  if (ratio === null || edits < config.alertAfterEdits) {
    console.log('🟢  Claude está trabajando bien en esta sesión.');
  } else if (!degraded) {
    console.log('🟢  Claude está trabajando bien en esta sesión.');
  } else {
    console.log('🔴  Claude está perdiendo contexto — puede cometer errores.');
    console.log('');
    console.log('    → Escribe /compact en el chat para que se ponga al día.');
    console.log('    → O empieza una sesión nueva si el problema persiste.');
  }
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
      process.stderr.write('⚠️  Claude lleva mucho rato trabajando y puede estar perdiendo el hilo.\n');
      process.stderr.write('    Escribe /compact en el chat para que se ponga al día.\n');
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
