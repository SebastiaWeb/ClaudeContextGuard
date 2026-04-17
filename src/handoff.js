'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── transcript parsing ───────────────────────────────────────────────────────

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const MAX_PROMPT_CHARS = 500;
const MAX_BASH_CMD_CHARS = 120;
const MAX_RECENT_PROMPTS = 8;
const MAX_RECENT_TOOLS = 15;
const MAX_ASSISTANT_TEXT_CHARS = 1500;

// Tool calls that are internal progress/bookkeeping — not useful as handoff context.
const NOISY_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput',
  'TodoWrite',
]);

function readJsonlLines(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return entries;
}

function extractUserText(entry) {
  const c = entry && entry.message && entry.message.content;
  if (!c) return null;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const texts = c.filter(x => x && x.type === 'text' && typeof x.text === 'string').map(x => x.text);
    return texts.join('\n') || null;
  }
  return null;
}

function cleanPrompt(text) {
  if (!text) return '';
  return text.replace(SYSTEM_REMINDER_RE, '').trim();
}

function isRealPrompt(text) {
  if (!text) return false;
  if (text.startsWith('<') && text.includes('</')) return false;  // wrapped tag
  if (text.startsWith('Caveat:') || text.startsWith('[Request interrupted')) return false;
  return text.length > 0;
}

function extractToolCalls(assistantEntry) {
  const c = assistantEntry && assistantEntry.message && assistantEntry.message.content;
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const item of c) {
    if (!item || item.type !== 'tool_use') continue;
    out.push({ name: item.name, input: item.input || {} });
  }
  return out;
}

function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const c = e.message && e.message.content;
    if (!Array.isArray(c)) continue;
    const textItems = c.filter(x => x && x.type === 'text' && typeof x.text === 'string');
    if (textItems.length === 0) continue;
    return textItems.map(x => x.text).join('\n').trim();
  }
  return null;
}

// ── summarisation helpers ────────────────────────────────────────────────────

function summarizeTool(tool) {
  const { name, input } = tool;
  if (name === 'Bash' && input.command) {
    const cmd = input.command.length > MAX_BASH_CMD_CHARS
      ? input.command.slice(0, MAX_BASH_CMD_CHARS) + '…'
      : input.command;
    return `\`Bash\` — \`${cmd}\``;
  }
  if ((name === 'Read' || name === 'Edit' || name === 'Write') && input.file_path) {
    return `\`${name}\` — \`${input.file_path}\``;
  }
  if (name === 'Glob' && input.pattern) {
    return `\`Glob\` — \`${input.pattern}\``;
  }
  if (name === 'Grep' && input.pattern) {
    return `\`Grep\` — \`${input.pattern}\``;
  }
  if (name === 'Agent' && input.subagent_type) {
    return `\`Agent\` (${input.subagent_type}) — ${(input.description || '').slice(0, 80)}`;
  }
  if (name === 'TaskCreate' && input.subject) {
    return `\`TaskCreate\` — ${input.subject}`;
  }
  return `\`${name}\``;
}

function aggregateFileActivity(entries) {
  const files = new Map();
  const bump = (fp, kind) => {
    if (!fp) return;
    const key = fp;
    const cur = files.get(key) || { reads: 0, edits: 0, writes: 0 };
    cur[kind]++;
    files.set(key, cur);
  };
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    for (const tool of extractToolCalls(e)) {
      const fp = tool.input.file_path || tool.input.path;
      if (tool.name === 'Read' || tool.name === 'Glob' || tool.name === 'Grep') bump(fp, 'reads');
      else if (tool.name === 'Edit') bump(fp, 'edits');
      else if (tool.name === 'Write') bump(fp, 'writes');
    }
  }
  return files;
}

function getGitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, timeout: 500, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { return null; }
}

// ── markdown builder ─────────────────────────────────────────────────────────

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function buildMarkdown({ entries, cwd, analysis, sessionId }) {
  const lines = [];
  const branch = getGitBranch(cwd);
  const timestamp = new Date().toISOString();

  // Collect real user prompts (newest last)
  const userPrompts = [];
  for (const e of entries) {
    if (e.type !== 'user') continue;
    const cleaned = cleanPrompt(extractUserText(e));
    if (isRealPrompt(cleaned)) userPrompts.push(cleaned);
  }
  const originalGoal = userPrompts[0] || '(no clear original prompt captured)';
  const recentPrompts = userPrompts.slice(-MAX_RECENT_PROMPTS);

  // File activity
  const files = aggregateFileActivity(entries);
  const fileEntries = [...files.entries()]
    .sort((a, b) => (b[1].edits + b[1].writes) - (a[1].edits + a[1].writes))
    .slice(0, 20);

  // Recent substantive tool calls (last N), excluding noisy bookkeeping tools
  const recentTools = [];
  for (let i = entries.length - 1; i >= 0 && recentTools.length < MAX_RECENT_TOOLS; i--) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const tools = extractToolCalls(e);
    for (let j = tools.length - 1; j >= 0 && recentTools.length < MAX_RECENT_TOOLS; j--) {
      if (NOISY_TOOLS.has(tools[j].name)) continue;
      recentTools.unshift(tools[j]);
    }
  }

  const lastText = lastAssistantText(entries);

  // ── Header ──
  lines.push('# Claude Code Session Handoff');
  lines.push('');
  lines.push(`> Generated by \`claude-context-guard\` at ${timestamp}`);
  if (sessionId) lines.push(`> Previous session: \`${sessionId}\``);
  lines.push(`> Project: \`${cwd}\``);
  if (branch) lines.push(`> Git branch: \`${branch}\``);
  if (analysis && typeof analysis.compositeScore === 'number') {
    lines.push(`> Trigger: quality score dropped to **${analysis.compositeScore}/100**`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**You are a fresh Claude session continuing work from a previous, degraded session.** The human has not retyped the context below — it is being injected automatically so you can pick up where the prior session left off. Read it, then ask the user what they want to do next if anything is ambiguous.');
  lines.push('');

  // ── Original goal ──
  lines.push('## Original goal');
  lines.push('');
  lines.push('> ' + truncate(originalGoal, MAX_PROMPT_CHARS).replace(/\n/g, '\n> '));
  lines.push('');

  // ── Recent conversation ──
  if (recentPrompts.length > 1) {
    lines.push(`## Recent user prompts (last ${recentPrompts.length})`);
    lines.push('');
    for (const p of recentPrompts) {
      const t = truncate(p, MAX_PROMPT_CHARS).replace(/\n/g, ' ');
      lines.push(`- ${t}`);
    }
    lines.push('');
  }

  // ── Files touched ──
  if (fileEntries.length > 0) {
    lines.push('## Files touched');
    lines.push('');
    for (const [fp, counts] of fileEntries) {
      const parts = [];
      if (counts.reads) parts.push(`${counts.reads} read${counts.reads > 1 ? 's' : ''}`);
      if (counts.edits) parts.push(`${counts.edits} edit${counts.edits > 1 ? 's' : ''}`);
      if (counts.writes) parts.push(`${counts.writes} write${counts.writes > 1 ? 's' : ''}`);
      lines.push(`- \`${fp}\` — ${parts.join(', ')}`);
    }
    lines.push('');
  }

  // ── Recent tool activity ──
  if (recentTools.length > 0) {
    lines.push(`## Recent tool activity (last ${recentTools.length})`);
    lines.push('');
    for (const t of recentTools) {
      lines.push('- ' + summarizeTool(t));
    }
    lines.push('');
  }

  // ── Last assistant response ──
  if (lastText) {
    lines.push('## Last assistant response (for continuity)');
    lines.push('');
    lines.push('```');
    lines.push(truncate(lastText, MAX_ASSISTANT_TEXT_CHARS));
    lines.push('```');
    lines.push('');
  }

  // ── Why this handoff ──
  if (analysis) {
    lines.push('## Why this handoff was generated');
    lines.push('');
    const reasons = [];
    if (analysis.blindEdits && analysis.blindEdits.blindEditCount > 0) reasons.push(`- ${analysis.blindEdits.blindEditCount} blind edits (edits without prior read)`);
    if (analysis.thrashing && analysis.thrashing.thrashingFiles && analysis.thrashing.thrashingFiles.length > 0) reasons.push(`- ${analysis.thrashing.thrashingFiles.length} file(s) thrashing (edited 3+ times)`);
    if (analysis.writes > 0) reasons.push(`- ${analysis.writes} full rewrites (Write instead of Edit)`);
    if (analysis.bashFailures && analysis.bashFailures.maxConsecutive >= 3) reasons.push(`- ${analysis.bashFailures.maxConsecutive} consecutive Bash failures`);
    if (reasons.length > 0) lines.push(reasons.join('\n'));
    else lines.push('- Composite quality score crossed the critical threshold.');
    lines.push('');
  }

  // ── Footer guidance ──
  lines.push('## How to continue');
  lines.push('');
  lines.push('1. Acknowledge that you read this handoff to the user in one short sentence.');
  lines.push('2. If the original goal still applies, resume the work. If recent prompts changed direction, follow the newer intent.');
  lines.push('3. This handoff file (`.claude/handoff.md`) is one-shot — delete it after you have internalised the context so it does not pollute future sessions.');
  lines.push('');

  return lines.join('\n');
}

// ── main entry ───────────────────────────────────────────────────────────────

/**
 * Generate a handoff markdown file from a session transcript.
 *
 * @param {object}  opts
 * @param {string}  opts.transcriptPath - absolute path to the JSONL transcript
 * @param {string}  opts.cwd            - project directory
 * @param {object}  [opts.analysis]     - result from analysis.analyse() for trigger context
 * @param {string}  [opts.outputPath]   - where to write the MD (default `<cwd>/.claude/handoff.md`)
 * @param {string}  [opts.sessionId]
 * @returns {{ path: string, bytes: number } | { error: string }}
 */
function generateHandoff(opts) {
  const { transcriptPath, cwd } = opts;
  if (!transcriptPath || !cwd) return { error: 'transcriptPath and cwd are required' };

  const entries = readJsonlLines(transcriptPath);
  if (entries.length === 0) return { error: 'transcript is empty or unreadable' };

  const md = buildMarkdown({
    entries,
    cwd,
    analysis: opts.analysis || null,
    sessionId: opts.sessionId || null,
  });

  const outputPath = opts.outputPath || path.join(cwd, '.claude', 'handoff.md');
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, md, 'utf8');
    return { path: outputPath, bytes: Buffer.byteLength(md, 'utf8') };
  } catch (e) {
    return { error: `failed to write handoff: ${e.message}` };
  }
}

module.exports = {
  generateHandoff,
  // exported for testing
  readJsonlLines,
  extractUserText,
  cleanPrompt,
  isRealPrompt,
  extractToolCalls,
  buildMarkdown,
};
