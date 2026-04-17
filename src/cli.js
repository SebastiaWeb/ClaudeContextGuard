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
const { generateHandoff } = require('./handoff');

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
      transcriptPath = result.filePath;
      detailed = parseSessionDetailed(transcriptPath);
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

    // Handoff trigger: at critical degradation, generate a session-handoff MD that
    // the next /new session will auto-load via the SessionStart hook.
    if (compositeScore < 20 && transcriptPath) {
      const handoffPath = path.join(hookCwd, '.claude', 'handoff.md');
      let skip = false;
      try {
        const stat = fs.statSync(handoffPath);
        // Don't regenerate if a fresh handoff already exists (< 5 min old).
        if (Date.now() - stat.mtimeMs < 5 * 60 * 1000) skip = true;
      } catch { /* no existing handoff, proceed */ }

      if (!skip) {
        const result = generateHandoff({
          transcriptPath,
          cwd: hookCwd,
          analysis,
          sessionId: path.basename(transcriptPath, '.jsonl'),
        });
        if (result && result.path) {
          process.stderr.write('\n');
          process.stderr.write('📄 \x1b[33mHandoff saved for fresh-session recovery:\x1b[0m\n');
          process.stderr.write(`   ${result.path}\n`);
          process.stderr.write('   Type /new — context will auto-load into the fresh session.\n');
          process.stderr.write('\n');
        }
      }
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

    // ── quality bar ─────────────────────────────────────────────────────────
    let qualityPart = '';
    if (analysis) {
      const { compositeScore, slidingWindow, blindEdits, thrashing, bashFailures, writes } = analysis;
      const colorFn = scoreColor(compositeScore);
      const bar = makeBar(compositeScore, 10, colorFn);
      const ratioStr = slidingWindow.ratio === null ? 'N/A' : `${slidingWindow.ratio.toFixed(1)}x`;
      const label = colorFn('🧠 Quality');

      qualityPart = `${label} [${bar}] ${compositeScore}/100  ratio:${ratioStr}`;

      // Extra indicators when problems detected
      const extras = [];
      if (blindEdits.blindEditCount > 0) extras.push(`blind:${blindEdits.blindEditCount}`);
      if (thrashing.thrashingFiles.length > 0) extras.push(`thrash:${thrashing.thrashingFiles.length}`);
      if (bashFailures.maxConsecutive >= 3) extras.push(`bash-fail:${bashFailures.maxConsecutive}`);
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

function cmdHandoff() {
  // Manual trigger: generate a handoff MD from the latest session in this cwd.
  const result = analyseLatestSession(cwd);
  if (!result) {
    console.log('');
    console.log('No session data found for this directory.');
    console.log('Make sure you have used Claude Code here first.');
    console.log('');
    process.exit(0);
  }

  const config = loadConfig();
  const detailed = parseSessionDetailed(result.filePath);
  if (!detailed) {
    console.log('Could not parse transcript.');
    process.exit(1);
  }

  const analysis = runAnalysis(detailed, null, config, {});
  const out = generateHandoff({
    transcriptPath: result.filePath,
    cwd,
    analysis,
    sessionId: path.basename(result.filePath, '.jsonl'),
  });

  if (out.error) {
    console.error('Handoff failed:', out.error);
    process.exit(1);
  }

  console.log('');
  console.log(`📄 Handoff saved: ${out.path}`);
  console.log(`   Size: ${out.bytes} bytes`);
  console.log('');
  console.log('   Type /new in Claude Code — the SessionStart hook will auto-load it.');
  console.log('');
}

function cmdSessionStart() {
  // Runs as Claude Code's SessionStart hook. If a .claude/handoff.md exists,
  // emit its contents as `additionalContext` in the documented JSON format so
  // the fresh session ingests the handoff before processing any user input.
  const timeout = setTimeout(() => { process.exit(0); }, 2000);
  timeout.unref();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let hookCwd = cwd;
    try {
      const data = JSON.parse(raw);
      if (data.cwd) hookCwd = data.cwd;
    } catch { /* ignore */ }

    // One-shot semantics via filesystem: the handoff.md only exists if a prior
    // degraded session generated it. After injection we rename it, so any
    // subsequent SessionStart (startup / clear / resume / compact) is a no-op
    // until a new handoff is written. This keeps the hook source-agnostic.
    const handoffPath = path.join(hookCwd, '.claude', 'handoff.md');
    let content;
    try { content = fs.readFileSync(handoffPath, 'utf8'); } catch { process.exit(0); }

    const payload = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: content,
      },
    };
    process.stdout.write(JSON.stringify(payload));

    // One-shot consumption: move to a .consumed suffix so a later session
    // doesn't re-inject the same handoff, but the user can still inspect it.
    try {
      fs.renameSync(handoffPath, path.join(hookCwd, '.claude', 'handoff.consumed.md'));
    } catch { /* ignore */ }

    process.exit(0);
  });
}

function cmdHelp() {
  console.log('');
  console.log('Usage: claude-context-guard <command>');
  console.log('');
  console.log('Commands:');
  console.log('  status         Show session quality report for current directory');
  console.log('  check          Hook mode: read stdin JSON and alert if degraded');
  console.log('  statusline     Print color progress bar for Claude Code statusline');
  console.log('  handoff        Generate a handoff MD from the current session (manual trigger)');
  console.log('  session-start  Hook mode: read stdin and inject .claude/handoff.md if present');
  console.log('  install        Add hooks and statusline to ~/.claude/settings.json');
  console.log('  uninstall      Remove hooks and statusline from ~/.claude/settings.json');
  console.log('  config         Show current configuration');
  console.log('  help           Show this help message');
  console.log('');
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const command = process.argv[2] || 'help';

switch (command) {
  case 'handoff':       cmdHandoff();      break;
  case 'session-start': cmdSessionStart(); break;
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
