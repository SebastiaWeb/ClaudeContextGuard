# claude-context-guard

[![npm version](https://img.shields.io/npm/v/claude-context-guard.svg)](https://www.npmjs.com/package/claude-context-guard)
[![npm downloads](https://img.shields.io/npm/dw/claude-context-guard.svg)](https://www.npmjs.com/package/claude-context-guard)
[![license](https://img.shields.io/npm/l/claude-context-guard.svg)](LICENSE)
[![node](https://img.shields.io/node/v/claude-context-guard.svg)](package.json)
[![GitHub](https://img.shields.io/badge/repo-GitHub-blue)](https://github.com/SebastiaWeb/ClaudeContextGuard)

> Know when Claude is degrading — before the damage is done.

---

## The Problem

In long sessions, Claude silently starts editing files without reading enough context first. The output looks normal. Claude still responds. But the quality has dropped dramatically.

A documented analysis of real Claude Code sessions found that Claude's thinking depth can collapse **75% within a single session** — and the worst part is you have no way to see it happening.

The signal that gives it away: the **read-to-edit ratio**. During high-quality operation, Claude reads ~6.6 files before each edit. When degraded, that number falls below 2. It's basically editing blind.

The result: bugs introduced, working code broken, architectural decisions ignored — all because Claude lost track of context and nobody noticed.

---

## What This Does

Reads the JSONL session files Claude Code already saves in `~/.claude/projects/` and calculates your session's **read-to-edit ratio in real time**.

### Live statusline bar

A color-coded bar appears at the bottom of Claude Code after every response, showing quality and context usage at a glance:

```
🧠 Quality [██████████] ratio:6.2x  edits:5  reads:31  ·  📦 Context [███░░░░░░░] 30%
```

The bars change color as the session progresses:

| Color | Meaning |
|---|---|
| 🟢 Green | Healthy — Claude is reading enough context |
| 🟡 Yellow | Starting to degrade — watch out |
| 🔴 Red + `⚠ /compact` | Degraded — take action now |

### Alert when it gets bad

When the ratio drops below the safe threshold, you also get a full alert after every Claude response or file edit:

```
╔══════════════════════════════════════════════════════╗
║  ⚠️  Claude is losing track of the conversation       ║
╠══════════════════════════════════════════════════════╣
║  📊 15 edits, 8 reads (ratio 0.5x)                   ║
╠══════════════════════════════════════════════════════╣
║  What to do now:                                     ║
║                                                      ║
║  1️⃣  Type /compact  → Claude summarizes and continues ║
║  2️⃣  Type /new      → Start a fresh session          ║
╚══════════════════════════════════════════════════════╝
```

You can also check manually at any time:

```bash
claude-context-guard status
```

---

## Installation

One command — hooks are configured automatically:

```bash
npm install -g claude-context-guard
```

That's it. No extra setup needed. The hook is added to `~/.claude/settings.json` automatically during install.

To remove it:

```bash
npx claude-context-guard uninstall
```

---

## How It Works

Claude Code writes every session event to a JSONL file at:

```
~/.claude/projects/<cwd-as-dirname>/<session-uuid>.jsonl
```

Where `cwd-as-dirname` is the working directory path with slashes replaced by dashes (e.g. `/Users/foo/bar` → `-Users-foo-bar`).

Each line is a JSON object. `claude-context-guard` parses:

- **`assistant` entries** — `message.content[]` items with `type: "tool_use"` represent direct tool calls
- **`progress` entries** — `data.message.message.content[]` represents sub-agent tool calls

Tool calls are classified as:

| Category | Tools |
|---|---|
| Read | `Read`, `Glob`, `Grep` |
| Edit | `Edit`, `Write` |

The **read-to-edit ratio** is `reads / edits`. A ratio below 4.0 indicates Claude may be operating with insufficient context.

The check runs automatically in three moments:
- **Statusline** — live bar at the bottom of Claude Code after every response
- After every **Edit or Write** tool use (`PostToolUse` hook)
- After every **Claude response** (`Stop` hook)

---

## Requirements

- Claude Code CLI installed
- Node.js 18+

---

## Configuration

Customize thresholds in `~/.claude/context-guard.json`:

```json
{
  "minReadToEditRatio": 4.0,
  "alertAfterEdits": 10,
  "silent": false
}
```

| Option | Default | Description |
|---|---|---|
| `minReadToEditRatio` | `4.0` | Alert when ratio drops below this |
| `alertAfterEdits` | `10` | Start monitoring after N edits |
| `silent` | `false` | Suppress terminal alerts |

---

## CLI Reference

```
Usage: claude-context-guard <command>

Commands:
  status      Show session quality report for current directory
  check       Hook mode: read stdin JSON and alert if degraded
  statusline  Print color progress bar for Claude Code statusline
  install     Add hooks and statusline to ~/.claude/settings.json
  uninstall   Remove hooks and statusline from ~/.claude/settings.json
  config      Show current configuration
  help        Show this help message
```

---

## Programmatic API

```js
const guard = require('claude-context-guard');

// Analyse the current session
const result = guard.analyse('/path/to/project');
// => { reads: 48, edits: 23, totalToolCalls: 87, ratio: 2.08, filePath: '...' }
// => null  (no session data found)

// Install/uninstall the hook
guard.installHook();
guard.uninstallHook();

// Read current config
const config = guard.getConfig();
// => { minReadToEditRatio: 4.0, alertAfterEdits: 10, silent: false }
```

---

## The Pain It Cures

| Before | After |
|---|---|
| Claude degrades silently | Live color bar shows quality at all times |
| Bugs appear out of nowhere | Catch degradation before damage |
| Wasted time fixing AI-introduced bugs | Know exactly when to reset the session |
| No visibility into session health | Live read-to-edit ratio + context % |

---

## License

MIT — free forever.
