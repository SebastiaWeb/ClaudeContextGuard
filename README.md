# claude-context-guard

[![npm version](https://img.shields.io/npm/v/claude-context-guard.svg)](https://www.npmjs.com/package/claude-context-guard)
[![license](https://img.shields.io/npm/l/claude-context-guard.svg)](LICENSE)
[![node](https://img.shields.io/node/v/claude-context-guard.svg)](package.json)

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

When the ratio drops below a safe threshold, you get an alert:

```
WARNING: claude-context-guard: Context quality dropping
    Read-to-edit ratio: 1.8 (healthy: >4.0)
    Claude is editing without reading enough context.
    Consider running /compact or starting a fresh session.
```

You can also run it manually at any time:

```bash
claude-context-guard status
```

Output:

```
Session Quality Report
──────────────────────────
Read-to-edit ratio:  2.1  !!  (degraded)
Total tool calls:    87
File edits:          23
Files read:          48
Recommendation:      Run /compact now or start a new session
```

---

## Installation

One command:

```bash
npx claude-context-guard install
```

Installs a background watcher that monitors your active session and alerts when quality drops. Doesn't touch your existing hooks.

Manual install (optional):

Add to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-context-guard check"
          }
        ]
      }
    ]
  }
}
```

Uninstall:

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
  install     Add PostToolUse hook to ~/.claude/settings.json
  uninstall   Remove the hook from ~/.claude/settings.json
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
| Claude degrades silently | Real-time alert when quality drops |
| Bugs appear out of nowhere | Catch degradation before damage |
| Wasted time fixing AI-introduced bugs | Know exactly when to reset the session |
| No visibility into session health | Live read-to-edit ratio |

---

## License

MIT — free forever.
