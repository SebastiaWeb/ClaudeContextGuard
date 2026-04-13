'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const EDIT_TOOLS = new Set(['Edit', 'Write']);

/**
 * Convert an absolute cwd path to the dirname format Claude uses.
 * e.g. /Users/foo/bar -> -Users-foo-bar
 */
function cwdToDirname(cwd) {
  // Normalise both Unix forward slashes and Windows backslashes to dashes.
  // Leading separator becomes a leading dash: /Users/foo -> -Users-foo
  return cwd.replace(/[/\\]/g, '-');
}

/**
 * Return the project directory for a given cwd.
 */
function projectDir(cwd) {
  const dirname = cwdToDirname(cwd);
  return path.join(os.homedir(), '.claude', 'projects', dirname);
}

/**
 * List all .jsonl session files for a cwd, sorted newest first.
 */
function listSessions(cwd) {
  const dir = projectDir(cwd);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
}

/**
 * Extract tool_use names from a content array.
 */
function extractToolNames(contentArray) {
  if (!Array.isArray(contentArray)) return [];
  return contentArray
    .filter((c) => c && c.type === 'tool_use' && typeof c.name === 'string')
    .map((c) => c.name);
}

/**
 * Parse a single JSONL file and return { reads, edits, totalToolCalls }.
 */
function parseSession(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let reads = 0;
  let edits = 0;
  let totalToolCalls = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Assistant entries: message.content[]
    if (entry.type === 'assistant' && entry.message && entry.message.content) {
      const names = extractToolNames(entry.message.content);
      for (const name of names) {
        totalToolCalls++;
        if (READ_TOOLS.has(name)) reads++;
        else if (EDIT_TOOLS.has(name)) edits++;
      }
    }

    // Progress entries (sub-agents): data.message.message.content[]
    if (
      entry.type === 'progress' &&
      entry.data &&
      entry.data.message &&
      entry.data.message.message &&
      entry.data.message.message.content
    ) {
      const names = extractToolNames(entry.data.message.message.content);
      for (const name of names) {
        totalToolCalls++;
        if (READ_TOOLS.has(name)) reads++;
        else if (EDIT_TOOLS.has(name)) edits++;
      }
    }
  }

  return { reads, edits, totalToolCalls };
}

/**
 * Analyse the most recent session for a given cwd.
 * Returns { reads, edits, totalToolCalls, ratio, filePath } or null.
 */
function analyseLatestSession(cwd) {
  const sessions = listSessions(cwd);
  if (sessions.length === 0) return null;

  const filePath = sessions[0];
  const stats = parseSession(filePath);
  if (!stats) return null;

  const ratio = stats.edits === 0 ? null : stats.reads / stats.edits;
  return Object.assign({ ratio, filePath }, stats);
}

module.exports = { analyseLatestSession, listSessions, parseSession, projectDir, cwdToDirname };
