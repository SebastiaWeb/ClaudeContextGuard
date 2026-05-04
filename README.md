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

Monitors Claude Code sessions using **7 degradation signals** with EMA smoothing to give you a stable composite quality score (0-100) in real time.

### Live statusline bar

A responsive, color-coded bar at the bottom of Claude Code shows your session health at a glance. It adapts to your terminal width:

```
🧠 Quality [████████░░] 82/100  ·  ratio:5.2x  ·  📦 Context [███░░░░░░░] 30%  ·  🌿 main  ·  📁 my-project
```

When things start to degrade, extra indicators appear:

```
🧠 Quality [███░░░░░░░] 28/100  ⚠ /compact  ·  ratio:1.2x  ·  blind:5 thrash:2 writes:3  ·  📦 Context [███████░░░] 68%  ·  🌿 feat/auth  ·  📁 my-project
```

On narrow terminals, labels shorten and lines wrap automatically.

| Color | Score | Meaning |
|---|---|---|
| 🟢 Green | 75-100 | Healthy — Claude is reading enough context |
| 🟡 Yellow | 40-74 | Starting to degrade — watch out |
| 🔴 Red + `⚠ /compact` | 0-39 | Degraded — take action now |

### 7 degradation signals

| Signal | What it detects |
|---|---|
| **EMA-smoothed ratio** | Read-to-edit ratio using exponential moving average — no more score jumps |
| **Blind edits** | Edits made without reading the file first (windowed, ignores new file creation) |
| **Thrashing** | Same file edited 3+ times in a short window |
| **Write frequency** | Full file rewrites (`Write`) instead of surgical edits (`Edit`) |
| **Context pressure** | Sigmoid curve — degrades smoothly from 40%, drops steeply after 65% |
| **Bash failures** | Same command failing 3+ times consecutively |
| **Autocompact detection** | Resets score smoothing when context drops suddenly (>30%) |

### Alert when it gets bad

When the composite score drops below 50, you get a full alert:

```
╔═══════════════════════════════════════════════════════════╗
║  ⚠️  Claude is losing track of the conversation            ║
╠═══════════════════════════════════════════════════════════╣
║  📊 Score: 28/100  ratio: 1.2x  edits: 15  reads: 8      ║
║  👁  5 blind edits (no prior read)                         ║
║  🔄 2 file(s) edited 3+ times (thrashing)                  ║
║  📝 3 full rewrites (Write instead of Edit)                ║
╠═══════════════════════════════════════════════════════════╣
║  What to do now:                                          ║
║                                                           ║
║  1️⃣  Type /compact  → Claude summarizes and continues      ║
║  2️⃣  Type /new      → Start a fresh session                ║
╚═══════════════════════════════════════════════════════════╝
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
| Edit | `Edit` |
| Write | `Write` (full file rewrite) |

A **composite quality score** (0-100) is computed from: sliding window ratio, blind edits, thrashing, write frequency, and context pressure.

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
  "silent": false,
  "slidingWindowSize": 40,
  "blindEditLookback": 10,
  "thrashingThreshold": 3
}
```

| Option | Default | Description |
|---|---|---|
| `minReadToEditRatio` | `4.0` | Target ratio for healthy sessions |
| `alertAfterEdits` | `10` | Start monitoring after N edits |
| `silent` | `false` | Suppress terminal alerts |
| `slidingWindowSize` | `20` | Number of recent tool calls to evaluate |
| `blindEditLookback` | `10` | How many tool calls back to check for prior reads |
| `thrashingThreshold` | `3` | Edits on same file before flagging thrashing |

---

## CLI Reference

```
Usage: claude-context-guard <command>

Commands:
  status         Show session quality report for current directory
  check          Hook mode: read stdin JSON and alert if degraded
  statusline     Print color progress bar for Claude Code statusline
  skills         List active/inactive skills and validate last-session load
  handoff        Generate a handoff MD from the current session (manual trigger)
  session-start  Hook mode: read stdin and inject .claude/handoff.md if present
  install        Add hooks and statusline to ~/.claude/settings.json
  uninstall      Remove hooks and statusline from ~/.claude/settings.json
  config         Show current configuration
  help           Show this help message
```

### Skills visibility

The statusline includes a `🧩` chunk summarising which Claude Code skills are
active vs. inactive in your setup, and `claude-context-guard skills` prints a
full report including which skills were actually loaded into the most recent
session (so you can catch a plugin that silently stopped loading).

---

## Programmatic API

```js
const guard = require('claude-context-guard');

// Analyse the current session
const result = guard.analyse('/path/to/project');
// => {
//   reads: 48, edits: 18, writes: 5, totalToolCalls: 87,
//   compositeScore: 72,
//   slidingWindow: { reads: 12, edits: 4, writes: 1, ratio: 2.4, total: 20 },
//   blindEdits: { blindEditCount: 3, blindEditFiles: [...] },
//   thrashing: { thrashingFiles: [], maxEditsOnOneFile: 2 },
//   filePath: '...'
// }

// Install/uninstall hooks and statusline
guard.installHook();
guard.uninstallHook();

// Read current config
const config = guard.getConfig();
```

---

## The Pain It Cures

| Before | After |
|---|---|
| Claude degrades silently | Live quality score (0-100) with 7 degradation signals |
| Bugs appear out of nowhere | Catch blind edits and thrashing before damage |
| Wasted time fixing AI-introduced bugs | Know exactly when to reset the session |
| No visibility into session health | Ratio, context %, git branch, and directory at a glance |

---

## License

MIT — free forever.
