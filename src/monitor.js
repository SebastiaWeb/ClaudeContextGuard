'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const READ_TOOLS  = new Set(['Read', 'Glob', 'Grep']);
const EDIT_TOOLS  = new Set(['Edit']);
const WRITE_TOOLS = new Set(['Write']);

/**
 * Convert an absolute cwd path to the dirname format Claude uses.
 * e.g. /Users/foo/bar -> -Users-foo-bar
 */
function cwdToDirname(cwd) {
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
 * Get the file path from a tool_use input object.
 */
function getFilePath(_toolName, input) {
  if (!input) return null;
  if (input.file_path) return input.file_path;   // Read, Edit, Write
  if (input.path) return input.path;               // Glob, Grep
  return null;
}

/**
 * Classify a tool name into a category.
 */
function categorize(name) {
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (WRITE_TOOLS.has(name)) return 'write';
  return 'other';
}

/**
 * Extract structured tool events from a content array.
 * Returns [{ name, category, filePath }]
 */
function extractToolEvents(contentArray) {
  if (!Array.isArray(contentArray)) return [];
  return contentArray
    .filter((c) => c && c.type === 'tool_use' && typeof c.name === 'string')
    .map((c) => ({
      name: c.name,
      category: categorize(c.name),
      filePath: getFilePath(c.name, c.input) || null,
    }));
}

/**
 * Parse a single JSONL file and return detailed event data.
 * Returns { events, reads, edits, writes, totalToolCalls } or null.
 */
function parseSessionDetailed(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const events = [];
  let reads = 0;
  let edits = 0;
  let writes = 0;
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

    let contentArray = null;

    // Assistant entries: message.content[]
    if (entry.type === 'assistant' && entry.message && entry.message.content) {
      contentArray = entry.message.content;
    }

    // Progress entries (sub-agents): data.message.message.content[]
    if (
      entry.type === 'progress' &&
      entry.data &&
      entry.data.message &&
      entry.data.message.message &&
      entry.data.message.message.content
    ) {
      contentArray = entry.data.message.message.content;
    }

    if (contentArray) {
      const toolEvents = extractToolEvents(contentArray);
      for (const evt of toolEvents) {
        evt.index = totalToolCalls;
        events.push(evt);
        totalToolCalls++;
        if (evt.category === 'read') reads++;
        else if (evt.category === 'edit') edits++;
        else if (evt.category === 'write') writes++;
      }
    }
  }

  return { events, reads, edits, writes, totalToolCalls };
}

/**
 * Backward-compatible wrapper. Returns { reads, edits, totalToolCalls } or null.
 */
function parseSession(filePath) {
  const detailed = parseSessionDetailed(filePath);
  if (!detailed) return null;
  return {
    reads: detailed.reads,
    edits: detailed.edits + detailed.writes,
    totalToolCalls: detailed.totalToolCalls,
  };
}

/**
 * Analyse the most recent session for a given cwd.
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

module.exports = {
  analyseLatestSession,
  listSessions,
  parseSession,
  parseSessionDetailed,
  projectDir,
  cwdToDirname,
};
