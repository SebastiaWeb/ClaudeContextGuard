#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { analyseLatestSession, parseSessionDetailed } = require('./monitor');
const { analyse: runAnalysis } = require('./analysis');
const { install, uninstall } = require('./hooks');
const { load: loadConfig, configPath } = require('./config');

const cwd = process.cwd();
const CACHE_FILE = path.join(os.homedir(), '.claude', 'context-guard.cache.json');

// ── helpers ──────────────────────────────────────────────────────────────────

function getGitBranch(dir) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dir, timeout: 500, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { return null; }
}

function makeBar(pct, width, colorFn) {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return colorFn('█'.repeat(filled)) + '\x1b[90m' + '░'.repeat(empty) + '\x1b[0m';
}

const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const dim    = (s) => `\x1b[90m${s}\x1b[0m`;

function scoreColor(score) {
  if (score >= 75) return green;
  if (score >= 40) return yellow;
  return red;
}

// ── commands ──────────────────────────────────────────────────────────────────

function cmdStatus() {
  const config = loadConfig();
  const result = analyseLatestSession(cwd);

  if (!result) {
    console.log('');
    console.log('No session data found for this directory.');
    console.log('Make sure you have used Claude Code here first.');
    console.log('');
    process.exit(0);
  }

  const { edits, ratio } = result;
  const degraded = ratio !== null && ratio < config.minReadToEditRatio && edits >= config.alertAfterEdits;

  console.log('');
  if (!degraded) {
    console.log('🟢  Claude is working well in this session.');
  } else {
    console.log('🔴  Claude is losing context — errors may follow.');
    console.log('');
    console.log('    → Type /compact to bring Claude up to speed.');
    console.log('    → Or start a new session if the problem persists.');
  }
  console.log('');
}

function cmdCheck() {
  const config = loadConfig();

  const timeout = setTimeout(() => { process.exit(0); }, 2000);
  timeout.unref();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let hookCwd = cwd;
    let contextPct = null;
    let transcriptPath = null;

    try {
      const data = JSON.parse(raw);
      if (data.cwd) hookCwd = data.cwd;
      if (data.transcript_path) transcriptPath = data.transcript_path;
      if (data.context_window && data.context_window.used_percentage != null) {
        contextPct = data.context_window.used_percentage;
      }
    } catch { /* ignore */ }

    // Try transcript_path first, fallback to cwd-based lookup
    let detailed = null;
    if (transcriptPath) {
      detailed = parseSessionDetailed(transcriptPath);
    }
    if (!detailed) {
      const result = analyseLatestSession(hookCwd);
      if (!result) process.exit(0);
      detailed = parseSessionDetailed(result.filePath);
    }
    if (!detailed) process.exit(0);

    const analysis = runAnalysis(detailed, contextPct, config);
    const { slidingWindow, compositeScore, blindEdits, thrashing } = analysis;

    if (config.silent) process.exit(0);
    const totalMods = analysis.edits + analysis.writes;
    if (totalMods < config.alertAfterEdits) process.exit(0);

    if (compositeScore < 50) {
      const ratioStr = slidingWindow.ratio === null ? 'N/A' : slidingWindow.ratio.toFixed(1) + 'x';
      process.stderr.write('\n');
      process.stderr.write('╔═══════════════════════════════════════════════════════════╗\n');
      process.stderr.write('║  ⚠️  Claude is losing track of the conversation            ║\n');
      process.stderr.write('╠═══════════════════════════════════════════════════════════╣\n');
      process.stderr.write(`║  📊 Score: ${compositeScore}/100  ratio: ${ratioStr}  edits: ${totalMods}  reads: ${analysis.reads}`.padEnd(60) + '║\n');

      if (blindEdits.blindEditCount > 0) {
        process.stderr.write(`║  👁  ${blindEdits.blindEditCount} blind edits (no prior read)`.padEnd(60) + '║\n');
      }
      if (thrashing.thrashingFiles.length > 0) {
        process.stderr.write(`║  🔄 ${thrashing.thrashingFiles.length} file(s) edited 3+ times (thrashing)`.padEnd(60) + '║\n');
      }
      if (analysis.writes > 0) {
        process.stderr.write(`║  📝 ${analysis.writes} full rewrites (Write instead of Edit)`.padEnd(60) + '║\n');
      }

      process.stderr.write('╠═══════════════════════════════════════════════════════════╣\n');
      process.stderr.write('║  What to do now:                                          ║\n');
      process.stderr.write('║                                                           ║\n');
      process.stderr.write('║  1️⃣  Type /compact  → Claude summarizes and continues      ║\n');
      process.stderr.write('║  2️⃣  Type /new      → Start a fresh session                ║\n');
      process.stderr.write('╚═══════════════════════════════════════════════════════════╝\n');
      process.stderr.write('\n');
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
  // Clean up cache
  try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
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
  const timeout = setTimeout(() => { process.exit(0); }, 2000);
  timeout.unref();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let contextPct = null;
    let transcriptPath = null;
    let hookCwd = null;

    try {
      const data = JSON.parse(raw);
      if (data.transcript_path) transcriptPath = data.transcript_path;
      if (data.cwd) hookCwd = data.cwd;
      if (data.context_window && data.context_window.used_percentage != null) {
        contextPct = data.context_window.used_percentage;
      }
    } catch { /* use defaults */ }

    // Persist session data so refreshInterval calls (no stdin) can reuse it
    if (transcriptPath) {
      try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ transcriptPath, contextPct, hookCwd }), 'utf8');
      } catch { /* ignore */ }
    } else {
      try {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (cached.transcriptPath) transcriptPath = cached.transcriptPath;
        if (contextPct === null && cached.contextPct != null) contextPct = cached.contextPct;
        if (!hookCwd && cached.hookCwd) hookCwd = cached.hookCwd;
      } catch { /* ignore */ }
    }

    const config = loadConfig();

    // ── analyse session ─────────────────────────────────────────────────────
    let analysis = null;
    if (transcriptPath) {
      const detailed = parseSessionDetailed(transcriptPath);
      if (detailed) {
        analysis = runAnalysis(detailed, contextPct, config);
      }
    }

    // ── quality bar ─────────────────────────────────────────────────────────
    let qualityPart = '';
    if (analysis) {
      const { compositeScore, slidingWindow, blindEdits, thrashing, writes } = analysis;
      const colorFn = scoreColor(compositeScore);
      const bar = makeBar(compositeScore, 10, colorFn);
      const ratioStr = slidingWindow.ratio === null ? 'N/A' : `${slidingWindow.ratio.toFixed(1)}x`;
      const label = colorFn('🧠 Quality');

      qualityPart = `${label} [${bar}] ${compositeScore}/100  ratio:${ratioStr}`;

      // Extra indicators when problems detected
      const extras = [];
      if (blindEdits.blindEditCount > 0) extras.push(`blind:${blindEdits.blindEditCount}`);
      if (thrashing.thrashingFiles.length > 0) extras.push(`thrash:${thrashing.thrashingFiles.length}`);
      if (writes > 0) extras.push(`writes:${writes}`);
      if (extras.length > 0) qualityPart += '  ' + dim(extras.join(' '));

      if (compositeScore < 40) {
        qualityPart += '  ' + red('⚠ /compact');
      }
    } else {
      qualityPart = dim(`🧠 Quality [${makeBar(100, 10, green)}] no data yet`);
    }

    // ── context bar ─────────────────────────────────────────────────────────
    let contextPart = '';
    if (contextPct !== null) {
      const ctxColorFn = contextPct < 50 ? green : contextPct < 80 ? yellow : red;
      const bar = makeBar(contextPct, 10, ctxColorFn);
      contextPart = `📦 Context [${bar}] ${Math.round(contextPct)}%`;
    }

    // ── git branch + directory ──────────────────────────────────────────────
    let gitPart = '';
    const dir = hookCwd || cwd;
    const branch = getGitBranch(dir);
    if (branch) gitPart = `🌿 ${green(branch)}`;

    let dirPart = '';
    const dirName = path.basename(dir);
    if (dirName) dirPart = `📁 ${dirName}`;

    const output = [qualityPart, contextPart, gitPart, dirPart].filter(Boolean).join('  ·  ');
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
  console.log('  statusline  Print color progress bar for Claude Code statusline');
  console.log('  install     Add hooks and statusline to ~/.claude/settings.json');
  console.log('  uninstall   Remove hooks and statusline from ~/.claude/settings.json');
  console.log('  config      Show current configuration');
  console.log('  help        Show this help message');
  console.log('');
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const command = process.argv[2] || 'help';

switch (command) {
  case 'status':     cmdStatus();     break;
  case 'check':      cmdCheck();      break;
  case 'statusline': cmdStatusline(); break;
  case 'install':    cmdInstall();    break;
  case 'uninstall':  cmdUninstall();  break;
  case 'config':     cmdConfig();     break;
  case 'help':
  default:
    cmdHelp();
    break;
}
