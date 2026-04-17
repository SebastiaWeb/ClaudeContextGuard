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

// ── responsive layout ────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;
// Emoji ranges covering glyphs used in this file (🧠 📦 🌿 📁 ⚠)
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu;

// Measure visible terminal columns: strip ANSI, count codepoints, treat emoji as 2 cols.
function visibleLength(s) {
  const noAnsi = s.replace(ANSI_RE, '');
  const emojiCount = (noAnsi.match(EMOJI_RE) || []).length;
  return Array.from(noAnsi).length + emojiCount;
}

function getTerminalWidth() {
  // Interactive stdout (direct CLI usage) — fastest path.
  if (process.stdout.isTTY && process.stdout.columns) return process.stdout.columns;

  // Claude Code pipes stdin/stdout, so /dev/tty is the only reliable source of
  // the real terminal size. `tput cols` falls back to 80 when stdout is piped.
  try {
    const result = execSync('stty size < /dev/tty', {
      timeout: 300, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const cols = parseInt(result.split(/\s+/)[1], 10);
    if (!isNaN(cols) && cols > 0) return cols;
  } catch { /* ignore */ }

  const envCols = parseInt(process.env.COLUMNS, 10);
  if (!isNaN(envCols) && envCols > 0) return envCols;

  try {
    const cols = parseInt(execSync('tput cols', {
      timeout: 300, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim(), 10);
    if (!isNaN(cols) && cols > 0) return cols;
  } catch { /* ignore */ }

  return 80;
}

function getBreakpoint(width) {
  if (width >= 100) return 'full';
  if (width >= 80) return 'medium';
  if (width >= 60) return 'narrow';
  return 'tiny';
}

const BAR_WIDTHS = { full: 10, medium: 8, narrow: 6, tiny: 4 };

function buildQualityCore(analysis, bp) {
  const barW = BAR_WIDTHS[bp];

  if (!analysis) {
    return dim(`🧠 Quality [${makeBar(100, barW, green)}] no data yet`);
  }

  const { compositeScore } = analysis;
  const colorFn = scoreColor(compositeScore);
  const bar = makeBar(compositeScore, barW, colorFn);
  const label = bp === 'tiny' ? colorFn('🧠') : colorFn('🧠 Quality');

  let core = `${label} [${bar}] ${compositeScore}/100`;
  // Critical alert stays glued to the core — must never be separated from the score.
  if (compositeScore < 40) {
    core += '  ' + red(bp === 'tiny' ? '⚠' : '⚠ /compact');
  }
  return core;
}

// Pack chunks greedily into lines of `width`, wrapping when a chunk doesn't fit.
// Nothing is dropped — narrow terminals show everything across multiple lines.
function packLines(chunks, width, sep) {
  const sepLen = visibleLength(sep);
  const lines = [];
  let current = '';
  let currentLen = 0;
  for (const chunk of chunks) {
    const chunkLen = visibleLength(chunk);
    const addedLen = current ? sepLen + chunkLen : chunkLen;
    if (current && currentLen + addedLen > width) {
      lines.push(current);
      current = chunk;
      currentLen = chunkLen;
    } else {
      current += (current ? sep : '') + chunk;
      currentLen += addedLen;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function renderStatusline({ analysis, contextPct, hookCwd, width }) {
  const bp = getBreakpoint(width);
  const barW = BAR_WIDTHS[bp];
  const sep = '  ·  ';
  const compact = bp === 'narrow' || bp === 'tiny';

  const chunks = [buildQualityCore(analysis, bp)];

  if (analysis) {
    const { slidingWindow, blindEdits, thrashing, bashFailures, writes } = analysis;

    const ratioStr = slidingWindow.ratio === null ? 'N/A' : `${slidingWindow.ratio.toFixed(1)}x`;
    chunks.push(dim(compact ? `r:${ratioStr}` : `ratio:${ratioStr}`));

    const extras = [];
    if (blindEdits.blindEditCount > 0) extras.push(compact ? `b${blindEdits.blindEditCount}` : `blind:${blindEdits.blindEditCount}`);
    if (thrashing.thrashingFiles.length > 0) extras.push(compact ? `t${thrashing.thrashingFiles.length}` : `thrash:${thrashing.thrashingFiles.length}`);
    if (bashFailures.maxConsecutive >= 3) extras.push(compact ? `f${bashFailures.maxConsecutive}` : `bash-fail:${bashFailures.maxConsecutive}`);
    if (writes > 0) extras.push(compact ? `w${writes}` : `writes:${writes}`);
    if (extras.length > 0) chunks.push(dim(extras.join(' ')));
  }

  if (contextPct !== null) {
    const ctxColorFn = contextPct < 50 ? green : contextPct < 80 ? yellow : red;
    const bar = makeBar(contextPct, barW, ctxColorFn);
    const label = bp === 'tiny' ? '📦' : '📦 Context';
    chunks.push(`${label} [${bar}] ${Math.round(contextPct)}%`);
  }

  const dir = hookCwd || cwd;
  const branch = getGitBranch(dir);
  if (branch) chunks.push(`🌿 ${green(branch)}`);

  const dirName = path.basename(dir);
  if (dirName) chunks.push(`📁 ${dirName}`);

  return packLines(chunks, width, sep);
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

    // Load cache for EMA continuity
    let cached = {};
    try { cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* ignore */ }
    const analysisCache = {
      emaRatio: cached.emaRatio != null ? cached.emaRatio : null,
      prevScore: cached.prevScore != null ? cached.prevScore : null,
      prevContextPct: cached.prevContextPct != null ? cached.prevContextPct : null,
    };
    const analysis = runAnalysis(detailed, contextPct, config, analysisCache);

    // Persist updated cache
    Object.assign(cached, analysis._cache);
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cached), 'utf8'); } catch { /* ignore */ }
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

    // Load previous cache (EMA state, score, session data)
    let cached = {};
    try { cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* ignore */ }

    // Restore from cache when refreshInterval fires without stdin
    if (transcriptPath) {
      cached.transcriptPath = transcriptPath;
      cached.contextPct = contextPct;
      cached.hookCwd = hookCwd;
    } else {
      if (cached.transcriptPath) transcriptPath = cached.transcriptPath;
      if (contextPct === null && cached.contextPct != null) contextPct = cached.contextPct;
      if (!hookCwd && cached.hookCwd) hookCwd = cached.hookCwd;
    }

    const config = loadConfig();

    // ── analyse session ─────────────────────────────────────────────────────
    let analysis = null;
    if (transcriptPath) {
      const detailed = parseSessionDetailed(transcriptPath);
      if (detailed) {
        // Pass previous EMA/score state from cache
        const analysisCache = {
          emaRatio: cached.emaRatio != null ? cached.emaRatio : null,
          prevScore: cached.prevScore != null ? cached.prevScore : null,
          prevContextPct: cached.prevContextPct != null ? cached.prevContextPct : null,
        };
        analysis = runAnalysis(detailed, contextPct, config, analysisCache);

        // Persist updated cache
        Object.assign(cached, analysis._cache);
      }
    }

    // Save cache
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cached), 'utf8'); } catch { /* ignore */ }

    // ── render with adaptive width ──────────────────────────────────────────
    const width = getTerminalWidth();
    const output = renderStatusline({ analysis, contextPct, hookCwd, width });
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
