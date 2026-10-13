# Command Deck

A Claude Code mod that plans work, sends each task to the cheapest model that can do it, and keeps a live board of usage, git state and handoffs.

Needs Claude Code 2.1.280 or later (mods, `CLAUDE_CODE_PLUGIN_DIRS`). MIT licensed.

## Features

- **Auto-plan.** Each message is checked. Big or vague ones are split into small steps, each tagged Haiku, Sonnet or Opus. Parallel steps are marked `∥`.
- **Kanban board.** Tasks, status, tokens per task, a history of the last 200 finished tasks that survives `/clear`.
- **Usage and git panel.** Context bar, daily usage, branch, ahead/behind, changed files.
- **Clean code toggle.** Engineering rules added to every chat. Step-specific rules (bug, feature, refactor, design, perf, security, risky, test) are picked per task and model by plain keywords, with one final review pass at the end. No extra model call.
- **Caveman toggle.** Short, blunt replies to save output tokens.
- **Handoff memory.** Writes a handoff note and starts a fresh chat at a context % you choose, or on a new topic.
- **Cache guard and keep-warm.** Warns before an expensive cold-cache rewrite and can ping to keep the cache warm.
- **Smart tool deferral.** Moves MCP servers the work does not need behind tool search.
- **Savings counter.** Estimated tokens and dollars saved.

## Install

Pick one.

### 1. From the marketplace (recommended)

```
/plugin marketplace add nixonok/command-deck
/plugin install command-deck@command-deck-market
```

One step (Claude Code 2.1.275 or later):

```
/plugin install command-deck --marketplace nixonok/command-deck
```

### 2. From git, no marketplace

```bash
git clone https://github.com/nixonok/command-deck.git ~/command-deck
```

Load it for one session:

```bash
claude --plugin-dir ~/command-deck
```

Or load it every time. Add to `~/.claude/settings.json` (absolute path or `~/...`; separate several folders with `:` on macOS and Linux, `;` on Windows):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/command-deck" } }
```

After any install, run `/reload-plugins` (or start a new chat). The pane opens by itself, or open it with `/command-deck`.

## Use

| Command | What it does |
|---|---|
| `/command-deck` | Open the board |
| `/command-deck-plan <what you want>` | Sharpen a request, ask what is unclear, split it into tasks per model |
| `/command-deck-cave [on\|off]` | Caveman mode |
| `/command-deck clean [on\|off]` | Clean code rules |
| `/command-deck auto [on\|off]` | Auto-plan every message |
| `/command-deck run` | Run the open tasks, each on its own model |
| `/command-deck fresh` | Handoff, then a new chat |
| `/command-deck handoff` · `compact` | Write a handoff note · compact the chat |
| `/command-deck done N` · `clear` | Mark task N done · clear the board |
| `/command-deck warm [on\|off] [hours]` | Keep the prompt cache warm |
| `/command-deck tools [on\|off]` | Smart MCP tool deferral |

The pane header has buttons for Caveman, Clean code and Auto-plan. Press them before a prompt to switch the feature on or off. The choice is remembered.

## How clean code picks rules

1. A short core (about 150 words) goes into the system prompt once. Cheap to keep, covered by the prompt cache.
2. For each plan step, keywords in the title choose up to 2 extra sections for a Sonnet step, up to 4 for Opus, none for Haiku. A rename gets core only. A "design the module layout" step gets the design rules.
3. A plan with more than one step ends with one final review of the whole diff. It never runs per step.
4. Each plan appends its picks to `.claude/deck/rules-log.md` so you can see what was chosen.

Turn it off with the button or `/command-deck clean off`.

## Settings and thresholds

Every option is a `userConfig` entry with a default in `.claude-plugin/plugin.json`.

Change a value in any of these ways:

- Ask Claude: *"set Command Deck autoFreshPct to 60"* (it edits the setting for you).
- In a session: `/plugin configure command-deck`.
- Shell: `claude plugin configure command-deck`, or on install `claude plugin install command-deck --config autoFreshPct=60`.

| Option | Default | Meaning |
|---|---|---|
| `autoFreshPct` | 50 | Write a handoff and clear the chat at this context %. 0 is off. |
| `autoCompactPct` | 0 | Compact at this context % when handoff is off. |
| `autoFresh` | 1 | Move to a new chat when a long chat starts a new topic. |
| `handoffTurns` | 12 | Suggest a handoff after this many prompts. |
| `plannerChatMessages` | 5 | Latest chat messages the planner reads. 0 sends none. |
| `plannerChatChars` | 500 | Characters kept per message sent to the planner. |
| `autoStart` | 1 | Open the pane and enable auto-plan in every new chat. |
| `coldGuard` | 1 | 0 off, 1 warn, 2 also hold the first send. |
| `cacheTtlMin` | 60 | Prompt cache lifetime. Use 5 for API-key billing. |
| `coldMinTokens` | 50000 | Below this context size the guard does nothing. |
| `autoKeepWarm` · `warmPingMin` · `warmHours` | 1 · 50 · 6 | Keep-warm switch, idle minutes before a ping, and how long it stays on. |
| `smartTools` | 1 | Defer unneeded MCP servers. |
| `cavemanRatio` · `routingSaveRatio` · `optimizerTokensPerCall` | 0.35 · 0.67 · 1200 | Assumptions behind the savings estimate. |
| `inputDollarsPerMTok` · `outputDollarsPerMTok` | 3 · 15 | Prices for the dollar figure. |

## Edit the mod

Source is plain TypeScript. Edit, then `/reload-plugins`.

| File | Holds |
|---|---|
| `hooks/register.tsx` | Commands, hooks, the pane and its buttons |
| `hooks/lib.ts` | Pure logic: planner prompt, handoff text, defaults, tips |
| `hooks/guidelines.ts` | Clean code core, tagged sections and the keyword picker |
| `hooks/deck.test.ts` | Tests |
| `.claude-plugin/plugin.json` | Name, version, settings |

To change the clean code rules, edit `CORE` and `SECTIONS` in `hooks/guidelines.ts`. A section is an id, a keyword regex, the lowest model tier that gets it, and its text.

Or just ask Claude: *"in the command-deck folder, add a database section to guidelines.ts"*. Then check your work:

```bash
claude plugin test .
claude plugin validate .
```

## Files it writes

Only under `.claude/deck/` in your project: `rules.md` (your rules for new chats, edit freely), handoffs, progress notes and `rules-log.md`. Nothing leaves your machine except the model calls Claude Code already makes.

## Optional tools

Savings rows for Graft and token-optimizer show only if those MCP servers are installed. Otherwise they stay at 0.

## Versioning

Semantic versioning. The version lives in `.claude-plugin/plugin.json`. Bump it on every release. A user only receives an update when the version changes.

## Publishing (maintainers)

See [PUBLISHING.md](PUBLISHING.md).

## License

MIT. See [LICENSE](LICENSE).
