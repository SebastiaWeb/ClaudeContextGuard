'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── skill discovery ──────────────────────────────────────────────────────────
//
// Three sources of truth:
//
//   1. Disk — SKILL.md files under ~/.claude/skills/ (user) and
//      ~/.claude/plugins/marketplaces/.../skills/ (plugin marketplaces).
//      The frontmatter gives us name + description; the filesystem path
//      tells us whether it is a user skill or belongs to a plugin.
//
//   2. Settings — ~/.claude/settings.json → enabledPlugins map.
//      Plugin skills are only active when their plugin key is true.
//
//   3. Transcript — Claude Code injects a "<system-reminder> The following
//      skills are available ..." block at session start / on /clear, listing
//      exactly what loaded. This is the ground truth for validation and
//      catches built-in skills that don't exist as SKILL.md on disk.

const HOME = os.homedir();
const USER_SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const MARKETPLACES_DIR = path.join(HOME, '.claude', 'plugins', 'marketplaces');
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const NAME_RE = /^name:\s*(.+?)\s*$/m;
const DESC_RE = /^description:\s*([\s\S]+?)(?:\n[a-zA-Z]+:|$)/m;

function readFrontmatter(skillMdPath) {
  let raw;
  try { raw = fs.readFileSync(skillMdPath, 'utf8'); } catch { return null; }
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  const body = m[1];
  const nameM = body.match(NAME_RE);
  const descM = body.match(DESC_RE);
  if (!nameM) return null;
  return {
    name: nameM[1].trim(),
    description: descM ? descM[1].replace(/\s+/g, ' ').trim() : '',
  };
}

function listDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

function scanUserSkills() {
  const skills = [];
  for (const skillDir of listDirs(USER_SKILLS_DIR)) {
    const meta = readFrontmatter(path.join(skillDir, 'SKILL.md'));
    if (!meta) continue;
    skills.push({
      name: meta.name,
      description: meta.description,
      source: 'user',
      plugin: null,
      marketplace: null,
      active: true, // user skills are always loaded
    });
  }
  return skills;
}

function readEnabledPlugins() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return settings.enabledPlugins || {};
  } catch { return {}; }
}

function scanPluginSkills(enabledPlugins) {
  const skills = [];
  for (const marketDir of listDirs(MARKETPLACES_DIR)) {
    const marketName = path.basename(marketDir);
    // Official marketplace layout: <market>/plugins/<plugin>/skills/<skill>/SKILL.md
    // External plugins:           <market>/external_plugins/<plugin>/skills/<skill>/SKILL.md
    for (const groupDir of [path.join(marketDir, 'plugins'), path.join(marketDir, 'external_plugins')]) {
      for (const pluginDir of listDirs(groupDir)) {
        const pluginName = path.basename(pluginDir);
        const pluginKey = `${pluginName}@${marketName}`;
        const active = enabledPlugins[pluginKey] === true;
        const skillsDir = path.join(pluginDir, 'skills');
        for (const skillDir of listDirs(skillsDir)) {
          const meta = readFrontmatter(path.join(skillDir, 'SKILL.md'));
          if (!meta) continue;
          skills.push({
            name: meta.name,
            description: meta.description,
            source: 'plugin',
            plugin: pluginName,
            marketplace: marketName,
            pluginKey,
            active,
          });
        }
      }
    }
  }
  return skills;
}

function discoverFromDisk() {
  const enabledPlugins = readEnabledPlugins();
  return [...scanUserSkills(), ...scanPluginSkills(enabledPlugins)];
}

// ── transcript validation ────────────────────────────────────────────────────
//
// Claude Code records a skill_listing attachment on session start / /clear.
// Shape: { type: "attachment", attachment: { type: "skill_listing",
//          content: "- name: description\n- name: description\n..." } }
// We parse the content into skill names and pick the most recent listing by
// timestamp.

const SKILL_ITEM_RE = /^-\s+([a-zA-Z0-9_:-]+):/gm;

/**
 * Parse a transcript JSONL and return the most recent list of skill names
 * that Claude Code reported as loaded. Returns null if no skill_listing
 * attachment exists in the file.
 */
function parseLoadedSkills(transcriptPath) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }

  let latestList = null;
  let latestTs = null;

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (e.type !== 'attachment') continue;
    const att = e.attachment;
    if (!att || att.type !== 'skill_listing') continue;
    const content = typeof att.content === 'string' ? att.content : '';
    if (!content) continue;

    const names = [];
    SKILL_ITEM_RE.lastIndex = 0;
    let mm;
    while ((mm = SKILL_ITEM_RE.exec(content)) !== null) names.push(mm[1]);
    if (names.length === 0) continue;

    const ts = e.timestamp || '';
    if (latestTs === null || ts > latestTs) {
      latestTs = ts;
      latestList = names;
    }
  }
  return latestList;
}

// ── composition ──────────────────────────────────────────────────────────────

/**
 * Combine disk discovery with transcript validation. Each skill gets a
 * `loaded` flag (true when the name appeared in the latest session-start
 * system-reminder). Built-in skills that exist only in the transcript
 * (no SKILL.md on disk) are surfaced as source='builtin'.
 */
// Loaded names can appear either bare (`review`) or plugin-namespaced
// (`frontend-design:frontend-design`). For a skill on disk we accept
// either form as "loaded".
function matchLoaded(skill, loadedSet) {
  if (loadedSet.has(skill.name)) return true;
  if (skill.plugin && loadedSet.has(`${skill.plugin}:${skill.name}`)) return true;
  return false;
}

function discoverSkills({ transcriptPath } = {}) {
  const fromDisk = discoverFromDisk();
  const loaded = transcriptPath ? parseLoadedSkills(transcriptPath) : null;
  const loadedSet = loaded ? new Set(loaded) : null;

  const out = fromDisk.map((s) => ({
    ...s,
    loaded: loadedSet ? matchLoaded(s, loadedSet) : null,
  }));

  if (loadedSet) {
    // Build set of names already accounted for (bare + namespaced).
    const accountedFor = new Set();
    for (const s of fromDisk) {
      accountedFor.add(s.name);
      if (s.plugin) accountedFor.add(`${s.plugin}:${s.name}`);
    }
    for (const name of loadedSet) {
      if (accountedFor.has(name)) continue;
      out.push({
        name,
        description: '',
        source: 'builtin',
        plugin: null,
        marketplace: null,
        active: true,
        loaded: true,
      });
    }
  }

  return {
    skills: out,
    loadedNames: loaded,
    validation: buildValidation(out, loaded, loadedSet),
  };
}

function buildValidation(skills, loaded, loadedSet) {
  if (!loaded) {
    return { available: false, reason: 'no transcript or no skill reminder found in transcript' };
  }
  const activeDisk = skills.filter((s) => s.source !== 'builtin' && s.active);
  const missing = activeDisk.filter((s) => !matchLoaded(s, loadedSet)).map((s) => s.name);
  const recognized = new Set();
  for (const s of skills) {
    if (loaded.includes(s.name)) recognized.add(s.name);
    if (s.plugin && loaded.includes(`${s.plugin}:${s.name}`)) recognized.add(`${s.plugin}:${s.name}`);
  }
  const extra = loaded.filter((n) => !recognized.has(n));
  return {
    available: true,
    loadedCount: loaded.length,
    activeOnDiskCount: activeDisk.length,
    missing, // active on disk but not reported as loaded → possible config issue
    extra,   // loaded but not identified on disk → built-in or undiscovered
  };
}

/**
 * Summary counts for the statusline. `total` only counts disk-discovered
 * skills (user + plugin) so the fraction is meaningful: loading built-ins
 * is out of the user's control and would just inflate the denominator.
 */
function summarize(result) {
  const diskSkills = result.skills.filter((s) => s.source !== 'builtin');
  const active = diskSkills.filter((s) => s.active).map((s) => s.name);
  const inactive = diskSkills.filter((s) => !s.active).map((s) => s.name);
  return {
    active,
    inactive,
    total: diskSkills.length,
    builtinCount: result.skills.length - diskSkills.length,
  };
}

module.exports = {
  discoverSkills,
  discoverFromDisk,
  parseLoadedSkills,
  summarize,
};
