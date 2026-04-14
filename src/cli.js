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
      const editWord = edits === 1 ? 'edición' : 'ediciones';
      process.stderr.write('\n');
      process.stderr.write('╔══════════════════════════════════════════════════════╗\n');
      process.stderr.write('║  ⚠️  Claude está perdiendo el hilo de la conversación  ║\n');
      process.stderr.write('╠══════════════════════════════════════════════════════╣\n');
      process.stderr.write(`║  📊 ${edits} ${editWord}, ${reads} lecturas (ratio ${ratio.toFixed(1)}x)`.padEnd(55) + '║\n');
      process.stderr.write('╠══════════════════════════════════════════════════════╣\n');
      process.stderr.write('║  Qué hacer ahora:                                    ║\n');
      process.stderr.write('║                                                      ║\n');
      process.stderr.write('║  1️⃣  Escribe /compact  → Claude resume y continúa    ║\n');
      process.stderr.write('║  2️⃣  Escribe /new      → Nueva sesión desde cero     ║\n');
      process.stderr.write('╚══════════════════════════════════════════════════════╝\n');
      process.stderr.write('\n');
      process.exit(0);
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

function cmdStatusline() {
  // Reads JSON from stdin (Claude Code statusline format) and prints one line.
  const timeout = setTimeout(() => {
    process.exit(0);
  }, 2000);
  timeout.unref();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let contextPct = null;
    let transcriptPath = null;

    try {
      const data = JSON.parse(raw);
      if (data.transcript_path) transcriptPath = data.transcript_path;
      if (data.context_window && data.context_window.used_percentage != null) {
        contextPct = data.context_window.used_percentage;
      }
    } catch {
      // use defaults
    }

    const config = loadConfig();
    const { parseSession } = require('./monitor');

    // Use transcript_path directly if available — avoids cwd mismatch issues
    let result = null;
    if (transcriptPath) {
      const stats = parseSession(transcriptPath);
      if (stats) {
        const ratio = stats.edits === 0 ? null : stats.reads / stats.edits;
        result = Object.assign({ ratio, filePath: transcriptPath }, stats);
      }
    }

    // Fallback: find the most recently modified JSONL across all projects
    if (!result) {
      const projectsDir = require('path').join(require('os').homedir(), '.claude', 'projects');
      try {
        const fs = require('fs');
        let newest = null;
        let newestMtime = 0;
        for (const proj of fs.readdirSync(projectsDir)) {
          const projPath = require('path').join(projectsDir, proj);
          try {
            for (const f of fs.readdirSync(projPath)) {
              if (!f.endsWith('.jsonl')) continue;
              const fp = require('path').join(projPath, f);
              const mtime = fs.statSync(fp).mtimeMs;
              if (mtime > newestMtime) { newestMtime = mtime; newest = fp; }
            }
          } catch { /* skip */ }
        }
        if (newest) {
          const stats = parseSession(newest);
          if (stats) {
            const ratio = stats.edits === 0 ? null : stats.reads / stats.edits;
            result = Object.assign({ ratio, filePath: newest }, stats);
          }
        }
      } catch { /* no projects dir */ }
    }

    // ── build progress bar ──────────────────────────────────────────────────
    function makeBar(pct, width, colorFn) {
      const filled = Math.round((pct / 100) * width);
      const empty = width - filled;
      return colorFn('█'.repeat(filled)) + '\x1b[90m' + '░'.repeat(empty) + '\x1b[0m';
    }

    // ANSI color helpers
    const green  = (s) => `\x1b[32m${s}\x1b[0m`;
    const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
    const red    = (s) => `\x1b[31m${s}\x1b[0m`;

    function ratioColor(ratio, minRatio) {
      if (ratio === null) return green;
      const pct = Math.min(ratio / minRatio, 1); // 1.0 = perfect, 0 = fully degraded
      if (pct >= 0.75) return green;
      if (pct >= 0.4)  return yellow;
      return red;
    }

    // ── ratio bar ───────────────────────────────────────────────────────────
    let ratioLine = '';
    if (result) {
      const { reads, edits, ratio } = result;
      const colorFn = ratioColor(ratio, config.minReadToEditRatio);

      // ratio as percentage of healthy threshold (capped at 100%)
      const ratioPct = ratio === null ? 100 : Math.min((ratio / config.minReadToEditRatio) * 100, 100);
      const bar = makeBar(ratioPct, 10, colorFn);

      const ratioStr = ratio === null ? 'N/A' : `${ratio.toFixed(1)}x`;
      const label = colorFn(`🧠 Quality`);
      ratioLine = `${label} [${bar}] ratio:${ratioStr}  edits:${edits}  reads:${reads}`;

      if (ratio !== null && ratio < config.minReadToEditRatio && edits >= config.alertAfterEdits) {
        ratioLine += '  ' + red('⚠ /compact');
      }
    } else {
      ratioLine = `\x1b[90m🧠 Quality [${makeBar(100, 10, green)}] no data yet\x1b[0m`;
    }

    // ── context bar ─────────────────────────────────────────────────────────
    let contextLine = '';
    if (contextPct !== null) {
      const ctxColorFn = contextPct < 50 ? green : contextPct < 80 ? yellow : red;
      const bar = makeBar(contextPct, 10, ctxColorFn);
      contextLine = `📦 Context [${bar}] ${contextPct}%`;
    }

    const output = [ratioLine, contextLine].filter(Boolean).join('  ·  ');
    process.stdout.write(output + '\n');
    process.exit(0);
  });
}

function cmdHelp() {
  console.log('');
  console.log('Usage: claude-context-guard <command>');
  console.log('');
  console.log('Commands:');
  console.log('  status      Show session quality report for current directory');
  console.log('  check       Hook mode: read stdin JSON and alert if degraded');
  console.log('  statusline  Statusline mode: print one-line quality bar for Claude Code');
  console.log('  install     Add hooks and statusline to ~/.claude/settings.json');
  console.log('  uninstall   Remove hooks and statusline from ~/.claude/settings.json');
  console.log('  config      Show current configuration');
  console.log('  help        Show this help message');
  console.log('');
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const command = process.argv[2] || 'help';

switch (command) {
  case 'status':    cmdStatus();    break;
  case 'check':      cmdCheck();      break;
  case 'statusline': cmdStatusline(); break;
  case 'install':    cmdInstall();    break;
  case 'uninstall': cmdUninstall(); break;
  case 'config':    cmdConfig();    break;
  case 'help':
  default:
    cmdHelp();
    break;
}
