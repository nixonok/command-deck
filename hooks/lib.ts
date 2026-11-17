// Pure logic of Command Deck: no engine calls, so every function here is unit-testable.

import { finalPass, guidelineExtras, unityRules } from './guidelines'
import type { CtxPart, GitInfo, Plan, Savings, Status, Task, Tier } from '../types'

export const TIER_MODEL: Record<Tier, string> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
}

export const TIER_LABEL: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
export const TIER_COLOR: Record<Tier, string> = { haiku: 'green', sonnet: 'cyan', opus: 'magenta' }

// ---------------------------------------------------------------- routing

const OPUS_WORDS =
  /\b(architect|architecture|design (a|the) (system|schema)|root cause|race condition|deadlock|security|vulnerab|migrat|rewrite|across (the )?(whole|entire)|algorithm|concurren|performance regression|ambiguous|trade-?off)\b/i
const HAIKU_WORDS =
  /\b(rename|typo|spelling|comment|docstring|format|lint|bump|version|add (a )?log|remove (the )?log|change (the )?text|label|copy|translate|move file|delete file|gitignore|readme|changelog|constant|one[- ]line|trivial|simple)\b/i

/** Fallback when the planner gives no tier: short and mechanical goes to Haiku, risky and open-ended to Opus. */
export function tierOf(title: string): Tier {
  if (OPUS_WORDS.test(title)) return 'opus'
  if (HAIKU_WORDS.test(title) && title.length < 140) return 'haiku'
  return 'sonnet'
}

export function asTier(value: unknown, title: string): Tier {
  const v = String(value ?? '').toLowerCase()
  return v === 'haiku' || v === 'sonnet' || v === 'opus' ? v : tierOf(title)
}

export const PLANNER_SYSTEM = `You turn a developer's rough request into a precise brief and a task list.
Return ONLY one JSON object, no prose, no code fence:
{"isClear":boolean,"questions":string[],"prompt":string,"code":boolean,"csharp":boolean,"effort":"low"|"medium"|"high"|"xhigh","tasks":[{"title":string,"tier":"haiku"|"sonnet"|"opus","why":string,"parallel":boolean}]}
Rules:
- A question (why, what, how, which is best, explain, compare, advice) is answered in chat, never built: code=false and exactly one task, "Answer in chat" on sonnet. Do not turn a question into build steps.
- Code pasted into the message with no file named ("fix this function", "what is wrong here"), and a request for one small piece of code to be given in the reply ("write a function that..."), are answered in chat too: code=false and exactly one task, "Answer in chat" on sonnet. There is no file to edit, so there are no steps, no test step and nothing to delegate.
- A request that points back at the chat ("fix it", "do that", "the fixes above", "fix the X") means the work the last Assistant message proposed or named; plan exactly that. If the cut chat lines do not show what it means, keep the person's own words in "prompt" and plan one sonnet step; never invent a different task.
- Default to isClear=true. Read "Recent conversation" and "Questions already asked and the answers" first: they are the person's own words and count as answers, even short ones like "yes", "both" or "all three" (they answer the question just before them). Never ask again anything already answered or implied there.
- isClear=false only when one missing fact would change the work (target file, behaviour, scope, platform) and no sensible default exists. Then give at most 2 short, concrete questions and leave tasks empty. When the request is clear enough, skip questions and state any assumption inside "prompt".
- Never ask what the project files, git history or the conversation can answer. A thing you cannot open (a web page behind a login) is not a question: plan the step with the tools the notes name, else around local files and config.
- "Known about this person and project" holds their rules, tools and habits. Plan with them and never ask what they answer. A tool or site they say the person uses (a signed-in browser, an image or design tool, an editor bridge) is there to use: never write that it cannot be used, and never plan around it.
- Work is in the project folder named in the request (code, editor tooling, or a Claude mod); do not assume a web app, browser or database unless the request says so.
- prompt: the request rewritten for an AI coding agent: goal, constraints, files or areas, definition of done, how to verify. Caveman style: short blunt sentences, no filler or articles, but keep every file name, number and rule exact so the task is clear at a glance. Under 140 words.
- tasks: 1-8 small steps in execution order. Pick the cheapest tier that will still be right:
  haiku  = precise, mechanical, one place: rename, text change, config value, comment, log line, simple fix with the exact spot named.
  sonnet = normal feature or bug work: several files, some planning, tests, UI wiring.
  opus   = hard reasoning only: architecture, subtle bugs with unknown cause, concurrency, security, large refactors.
- A bug fix in a project that has tests gets a step just before it, on the same tier: "Write failing test for <the bug>". No such step for a text, config or layout change.
- "title": terse caveman-style wording, short plain words, no filler or articles, under 9 words (for example "Fix null check in HideBannerAds", not "Fix the null reference check that happens in the HideBannerAds method").
- "why" is 6 words or fewer.
- code=true when any step changes code, tests, scenes, assets or build config; false when the work is only writing, research or an answer in chat.
- csharp=true only when a step writes or edits a C# (.cs) file; false for every other kind of work, even inside a game project.
- effort: how hard the main model must think for the whole request, judged by scope, not topic. low = an answer or a pick that needs no tools and no planning. medium = one known place, cause known. high = several files, an unknown cause, or a review of much code. xhigh = architecture, concurrency, security, a migration, or a retry after a failed attempt. A "yes" or "option B" that starts a build is judged as that build.
- parallel=true only when the task edits different files from the tasks next to it and needs nothing they produce; those run at the same time. Split mechanical edits per file so they can run in parallel on Haiku.`

export function plannerPrompt(ask: string, answers: string[], questions: string[] = [], recent: string[] = [], media = 0, known = ''): string {
  const chat = recent.length ? `\n\nRecent conversation (oldest first):\n${recent.map(r => `- ${r}`).join('\n')}` : ''
  const qa = questions.length
    ? `\n\nQuestions already asked and the answers (the answers below were sent in order, each one after the questions):\n${questions.map((q, i) => `- Q${i + 1}: ${q}`).join('\n')}\n${answers.map(a => `- Answer: ${a}`).join('\n')}`
    : answers.length
      ? `\n\nAnswers already given:\n${answers.map(a => `- ${a}`).join('\n')}`
      : ''
  const seen = media > 0
    ? `\n\nThe person attached ${media} image(s) or file(s) you cannot see; the agent doing the work sees them. Assume they show whatever the request points at (layout, text, the wanted result): never ask about them or about anything they could answer.`
    : ''
  const notes = known.trim() ? `\n\nKnown about this person and project (their own rules, memory and instruction files):\n${known.trim()}` : ''
  return `Request:\n${ask}${seen}${chat}${qa}${notes}`
}

/**
 * What the planner is told about the person and project. The planner is a separate cheap call that sees none of the
 * chat's instruction files, so without this it plans against what the person has already said they use.
 * Contract: empty files are left out, each is cut to `each` characters and the whole to `max`.
 */
export function plannerKnown(files: { label: string; text: string }[], each = 9000, max = 14000): string {
  const parts = files.filter(f => f.text.trim()).map(f => `[${f.label}]\n${clip(f.text.trim(), each)}`)
  return clip(parts.join('\n\n'), max)
}

/**
 * Whether the planner's questions may hold the message back. Never with attachments: a held message loses its
 * images (a plugin's own prompt cannot carry them), so the agent would never see them. One round at most.
 */
export function mayAsk(plan: Plan, isPending: boolean, media: number): boolean {
  return !plan.isClear && !isPending && media === 0 && plan.questions.length > 0
}

export function parsePlan(raw: string): Plan | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: any
  try {
    data = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  const questions = Array.isArray(data.questions) ? data.questions.map(String).filter(Boolean).slice(0, 4) : []
  const tasks = Array.isArray(data.tasks)
    ? data.tasks
        .map((t: any) => {
          const title = String(t?.title ?? '').trim()
          return { title, tier: asTier(t?.tier, title), why: String(t?.why ?? '').trim(), parallel: t?.parallel === true }
        })
        .filter((t: { title: string }) => t.title)
        .slice(0, 8)
    : []
  const isClear = data.isClear !== false && questions.length === 0 && tasks.length > 0
  return { isClear, questions, prompt: String(data.prompt ?? '').trim(), code: data.code !== false, csharp: typeof data.csharp === 'boolean' ? data.csharp : undefined, effort: asEffort(data.effort), tasks }
}

export function taskPrompt(goalPrompt: string, task: Task, done: Task[]): string {
  const before = done.length
    ? `\nAlready done:\n${done.map(t => `- ${t.title}${t.note ? ` (${t.note})` : ''}`).join('\n')}`
    : ''
  return `Overall goal:\n${goalPrompt}\n${before}\n\nYour task now: ${task.title}\nDo only this task. Keep the change minimal and match the surrounding code. Finish with a 2-line summary: what changed, what to check.`
}

/** The next group to run: a run of consecutive parallel tasks (up to `max`), else the single next task. */
export function nextWave(tasks: Task[], max = 4): Task[] {
  const todo = tasks.filter(t => t.status === 'todo')
  const first = todo[0]
  if (!first) return []
  if (!first.parallel) return [first]
  const wave: Task[] = []
  for (const t of todo) {
    if (!t.parallel || wave.length >= max) break
    wave.push(t)
  }
  return wave
}

// ---------------------------------------------------------------- usage and bars

export type ModelUsageLike = {
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
}

export type ModelBucket = 'Haiku' | 'Sonnet' | 'Opus' | 'Fable' | 'Other'

export function modelBucket(model: string | undefined): ModelBucket {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return 'Haiku'
  if (m.includes('sonnet')) return 'Sonnet'
  if (m.includes('opus')) return 'Opus'
  if (m.includes('fable')) return 'Fable'
  return 'Other'
}

/** Tokens that were actually worked on: fresh input, cache writes and output (cache reads excluded). */
export function billed(u: ModelUsageLike): number {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

export function shares(map: Record<string, number>): { name: ModelBucket; pct: number; tokens: number }[] {
  const names: ModelBucket[] = ['Haiku', 'Sonnet', 'Opus', 'Fable', 'Other']
  const total = names.reduce((sum, n) => sum + (map[n] ?? 0), 0)
  // Fable and Other get a row only once they have tokens: not every account has them
  return names
    .filter(n => (n !== 'Other' && n !== 'Fable') || (map[n] ?? 0) > 0)
    .map(name => ({ name, tokens: map[name] ?? 0, pct: total ? ((map[name] ?? 0) / total) * 100 : 0 }))
}

export function barColor(pct: number): string {
  return pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green'
}

// A bar is a row of cells. Each cell is a Box the layout sizes, holding one block glyph, so a bar is always one line
// and always spans its room; filled and empty cells share the glyph, so nothing sits apart. Only the number of cells
// comes from the pane's column count, and a wrong count costs seams between cells or overlap, never a broken bar.
export const BAR_GLYPH = '█'

// one colour per meter, so each bar is told apart at a glance; the level (near a limit) shows on the percent instead
export const METER_COLORS: Record<string, string> = {
  '5-hour': '#3b82f6',
  Week: '#f97316',
  Context: '#a855f7',
  Haiku: '#22c55e',
  Sonnet: '#06b6d4',
  Opus: '#ec4899',
  Fable: '#eab308',
  Other: '#9ca3af',
}

/** Cells for a bar with `columns` of room: one per column in a terminal; elsewhere a block glyph is about 1.5 columns wide (measured in the desktop app: 1.47). 6 to 60. */
export function cellCount(columns: number, isTerminal: boolean): number {
  const n = Math.floor((Number.isFinite(columns) ? columns : 0) / (isTerminal ? 1 : 1.5))
  return Math.max(6, Math.min(60, n))
}

/** The colour of each of `n` cells: the fills in order, each its share (any real share keeps one cell, never past the bar), then empty cells. */
export function barCells(fills: { pct: number; color: string }[], n: number): (string | undefined)[] {
  const out: (string | undefined)[] = []
  for (const f of fills) {
    const k = f.pct > 0 ? Math.min(n - out.length, Math.max(1, Math.round((f.pct / 100) * n))) : 0
    for (let i = 0; i < k; i++) out.push(f.color)
  }
  while (out.length < n) out.push(undefined)
  return out
}

// one little bot per model tier so a glance tells who is working: Haiku hums, Sonnet sparkles, Opus powers up. Each blinks
// now and then; its sparkle cycles the rainbow. Every face is five cells, so the card title never jitters. Only glyphs
// of narrow East Asian width: ambiguous ones (• ° ◎ ♪ ☆ ★) draw two cells in some terminals and shift the title.
const BOTS: Record<string, { faces: string[]; sparks: string[] }> = {
  haiku: { faces: ['(ᵔᴗᵔ)', '(ᵔᴗᵔ)', '(ᵔᴗᵔ)', '(-ᴗ-)', '(ᵔᴗᵔ)', '(ᵔᴗᵔ)', '(oᴗo)', '(ᵔᴗᵔ)'], sparks: ['♫', '~', '♫', '~', '♫', '~', '♫', '~'] },
  sonnet: { faces: ['[◕ᴗ◕]', '[◕ᴗ◕]', '[◕ᴗ◕]', '[◕ᴗ◕]', '[-ᴗ-]', '[◕ᴗ◕]', '[◕▿◕]', '[◕ᴗ◕]'], sparks: ['✧', '✦', '✶', '✦', '✧', '✦', '✶', '✦'] },
  opus: { faces: ['<◉ᗜ◉>', '<◉ᗜ◉>', '<◉_◉>', '<◉ᗜ◉>', '<-ᗜ->', '<◉ᗜ◉>', '<◕ᗜ◕>', '<◉ᗜ◉>'], sparks: ['✺', '✹', '✸', '✷', '✺', '✹', '✸', '✷'] },
}
const RAINBOW = ['magenta', 'red', 'yellow', 'green', 'cyan', 'blue']
/** The bot for a Doing card at this frame; `still` (the reducedMotion option) holds the first frame. */
export function workingBot(tier: string, frame: number, still = false): { face: string; spark: string; sparkColor: string } {
  const f = still ? 0 : Math.abs(frame)
  const bot = BOTS[tier] ?? BOTS.sonnet!
  return { face: bot.faces[f % bot.faces.length]!, spark: bot.sparks[f % bot.sparks.length]!, sparkColor: RAINBOW[f % RAINBOW.length]! }
}

// ---------------------------------------------------------------- board progress

// one color per card, reused on its row and its stretch of the bar, so a glance links the two
const CARD_COLORS = ['#3b82f6', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#eab308', '#06b6d4', '#84cc16']
export const FAILED_COLOR = '#ef4444'
export const cardColor = (i: number): string => CARD_COLORS[Math.abs(Math.trunc(i)) % CARD_COLORS.length]!

// a skipped card was dropped on purpose: neither work left nor work done, so it leaves the count
const counted = (tasks: Task[]) => tasks.map((t, i) => ({ t, i })).filter(x => x.t.status !== 'skipped')

/** Done counts 1, doing 0.5, todo and failed 0. An empty or all-skipped board is 0, never NaN. */
export function boardProgress(tasks: Task[]): { done: number; total: number; ratio: number } {
  const list = counted(tasks)
  const done = list.filter(x => x.t.status === 'done').length
  const doing = list.filter(x => x.t.status === 'doing').length
  return { done, total: list.length, ratio: list.length ? (done + doing / 2) / list.length : 0 }
}

export type BoardSlice = { card: number; status: Status; cells: number }
/** One stretch of the bar per counted card, in board order; `card` is its index in `tasks` (its color). The cells add up to `cells`: every cell of the bar is used, so no room is left to spread out as gaps. */
export function boardSlices(tasks: Task[], cells: number): BoardSlice[] {
  const list = counted(tasks)
  const n = Number.isFinite(cells) ? Math.max(0, Math.floor(cells)) : 0
  const edge = (k: number) => Math.round((k / list.length) * n)
  return list.map((x, k) => ({ card: x.i, status: x.t.status, cells: edge(k + 1) - edge(k) }))
}

/**
 * Lit cells of a running stretch on this frame. A two-cell highlight sweeps across the stretch, then rests for two
 * frames, so the stretch shimmers instead of blinking. Contract: one boolean per cell, a pure function of
 * (cells, frame). Invariants: the highlight stays inside the stretch; the sweep repeats every cells + 2 frames; an
 * empty stretch has no cells. `still` (reducedMotion) lights every cell and never moves.
 */
export function shimmerMask(cells: number, frame: number, still = false): boolean[] {
  const n = Number.isFinite(cells) ? Math.max(0, Math.floor(cells)) : 0
  if (still) return Array.from({ length: n }, () => true)
  const period = n + 2
  const head = ((Math.trunc(frame) % period) + period) % period
  return Array.from({ length: n }, (_, i) => i === head || i === head - 1)
}

// red → amber → green, so the percent warms up as cards close
const STOPS = [
  [0xef, 0x44, 0x44],
  [0xf5, 0x9e, 0x0b],
  [0x22, 0xc5, 0x5e],
] as const
export function gradientAt(t: number): string {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(x))
  const a = STOPS[i]!
  const b = STOPS[i + 1]!
  return `#${a.map((c, k) => Math.round(c + (b[k]! - c) * (x - i)).toString(16).padStart(2, '0')).join('')}`
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function resetsIn(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return 'soon'
  const mins = Math.round(ms / 60000)
  if (mins < 90) return `${mins}m`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

// ---------------------------------------------------------------- savings (estimates, labelled as such)

/** Graft prints "[graft] tokens saved ≈ 12k" at the top of every answer; read it when it is there. */
export function parseGraftSaved(text: string | undefined): number {
  if (!text) return 0
  const m = /tokens saved\s*[≈~=:]*\s*([\d.,]+)\s*([kKmM]?)/.exec(text)
  if (!m) return 0
  const n = Number((m[1] ?? '').replace(/,/g, ''))
  if (!Number.isFinite(n)) return 0
  const unit = (m[2] ?? '').toLowerCase()
  return Math.round(unit === 'k' ? n * 1000 : unit === 'm' ? n * 1_000_000 : n)
}

/** Output tokens a terse reply spared, from the output actually produced while Caveman was on. */
export function cavemanSaved(outputTokens: number, ratio: number): number {
  const r = Math.max(0, Math.min(0.9, ratio))
  return Math.round((outputTokens * r) / (1 - r))
}

/** True when a Bash command asks Graphify a question (query, path or explain); the build and install commands save nothing. */
export const isGraphifyQuery = (command: unknown): boolean => /\bgraphify\s+(query|path|explain)\b/.test(String(command ?? ''))

/** Names the chat lists for its skills (skill and providing plugin, lowercase), to tell which optional tools are installed. */
export function skillNames(list: { name?: unknown; pluginName?: unknown }[] | undefined): string[] {
  const out = new Set<string>()
  for (const s of list ?? []) {
    out.add(String(s.name ?? '').toLowerCase().split(':')[0] ?? '')
    if (s.pluginName) out.add(String(s.pluginName).toLowerCase())
  }
  out.delete('')
  return [...out]
}

export type ToolName = 'graft' | 'optimizer' | 'caveman' | 'ponytail' | 'graphify' | 'tokeneconomizer'

// A tool counts as available when its MCP server is connected or it already saved something. With no server data yet
// we assume available, so a missing breakdown never shows a false "not available". Caveman is a skill with no install
// signal, so it reads as missing only when the chat loaded no skills at all and nothing was saved.
export const toolAvailable = (
  tool: ToolName,
  servers: { server: string }[] | undefined,
  skillTokens: number | undefined,
  saved: number,
  skills?: string[],
): boolean => {
  if (saved > 0) return true
  // Ponytail and Graphify are skills: installed only when the chat lists one (Graphify also ships an MCP server)
  if (tool === 'ponytail' || tool === 'graphify' || tool === 'tokeneconomizer') return Boolean(skills?.includes(tool) || servers?.some(sv => norm(sv.server) === tool))
  if (tool === 'caveman') return skillTokens === undefined || skillTokens > 0
  if (!servers) return true
  const want = tool === 'graft' ? 'graft' : 'token_optimizer'
  return servers.some(sv => norm(sv.server) === want)
}

/** What each installable tool is, where it lives, and the steps any Claude can follow to install it. */
export const TOOL_INFO: Partial<Record<ToolName, { label: string; what: string; link: string; steps: string }>> = {
  graft: {
    label: 'Graft',
    what: 'indexes the repo into a graph so Claude finds code with exact file:line instead of grepping',
    link: 'https://www.npmjs.com/package/@nanonets/graft',
    steps: 'Run `npm i -g @nanonets/graft@latest`, then read the package README for how to register its MCP server and skill. Restart Claude Code.',
  },
  graphify: {
    label: 'Graphify',
    what: 'turns code, docs and papers into a knowledge graph Claude can query (/graphify)',
    link: 'https://github.com/Graphify-Labs/graphify',
    steps: 'Run `uv tool install graphifyy` (PyPI name has two y; or `pipx install graphifyy`), then `graphify install` to register the skill. Restart Claude Code.',
  },
  tokeneconomizer: {
    label: 'TokenEconomizer',
    what: 'Microsoft plugin that cuts agent cost: repo facts, tool pruning and loop guards',
    link: 'https://github.com/microsoft/TokenEconomizer',
    steps:
      'Python 3.10+ is needed. In a folder to keep the clone: `git clone https://github.com/microsoft/TokenEconomizer.git`, `claude plugin marketplace add "$PWD/TokenEconomizer"`, `claude plugin install tokeneconomizer@tokeneconomizer`. Leave the clone in place. Start claude, trust the folder, run `/tokeneconomizer:status`.',
  },
}

/** One prompt a fresh Claude can act on to install the given tools. Never invents commands: unknown steps point at the link. */
export function installPrompt(tools: ToolName[]): string {
  const rows = tools.flatMap(t => {
    const i = TOOL_INFO[t]
    return i ? [`- ${i.label}: ${i.what}.\n  Source: ${i.link}\n  Install: ${i.steps}`] : []
  })
  return `Install these tools for me. Read each source page first and use its own install steps; ask before anything that needs a password.\n${rows.join('\n')}\nWhen done, tell me to restart Claude Code.`
}

export type ToolState = 'active' | 'inactive' | 'missing'
/** Installed and running, installed but not running, or not installed. */
export function toolState(
  tool: ToolName,
  servers: { server: string }[] | undefined,
  skillTokens: number | undefined,
  saved: number,
  skills?: string[],
): ToolState {
  const listed = Boolean(skills?.includes(tool))
  // with the skill list known, Caveman is installed only when it is listed
  if (tool === 'caveman' && skills?.length && !listed && saved === 0) return 'missing'
  if (!listed && !toolAvailable(tool, servers, skillTokens, saved, skills)) return 'missing'
  // the Graft skill is listed but its MCP server is not connected
  if (tool === 'graft' && saved === 0 && servers && !servers.some(sv => norm(sv.server) === 'graft')) return 'inactive'
  return 'active'
}

/** Tokens RTK saved on `day` (YYYY-MM-DD), from `rtk gain -d -f json`; 0 when the day or the JSON is missing. */
export function rtkSaved(json: unknown, day: string): number {
  try {
    const row = (JSON.parse(String(json)) as { daily?: { date?: unknown; saved_tokens?: unknown }[] }).daily?.find(d => d.date === day)
    const n = Number(row?.saved_tokens ?? 0)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  } catch {
    return 0
  }
}

/** True when `rtk verify` reports its hook registered with Claude Code, so commands really go through RTK. */
export const rtkHooked = (verify: unknown): boolean => /^PASS\b.*hook registered/im.test(String(verify ?? ''))

export const ZERO_SAVINGS: Savings = { graft: 0, optimizer: 0, caveman: 0, ponytail: 0, graphify: 0, keepwarm: 0, fresh: 0, routing: 0, tools: 0 }

// everything Command Deck saved, one figure: keep-warm, fresh chat, routing and tool deferral
export const deckSaved = (s: Savings): number => s.keepwarm + s.fresh + s.routing + s.tools

// a guess, like each row: everything the deck and the tools it shows spared, RTK's own count included
export const totalSaved = (s: Savings, rtk = 0): number => s.graft + s.optimizer + s.graphify + s.caveman + s.ponytail + deckSaved(s) + rtk

export function dollars(s: Savings, inPerM: number, outPerM: number): number {
  return ((s.graft + s.optimizer + s.graphify + deckSaved(s)) * inPerM + (s.caveman + s.ponytail) * outPerM) / 1_000_000
}

// ---------------------------------------------------------------- git

export function parseGit(branchLine: string, porcelain: string, refs: string): GitInfo {
  const head = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/m.exec(branchLine) ?? []
  const track = head[3] ?? ''
  const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
  const dirty = porcelain
    .split('\n')
    .filter(l => l && !l.startsWith('##'))
    .map(l => l.trim())
  const branches = refs
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [name, upstream, t] = l.split('|')
      return { name: name ?? '', upstream: upstream ?? '', track: (t ?? '').trim() }
    })
  return { branch: head[1] ?? '?', upstream: head[2] ?? '', ahead, behind, branches, dirty }
}

// ---------------------------------------------------------------- auto-plan

/** Words that mean "skip the questions, just do it" when the planner asked something. */
export const GO_WORDS = /^(go|skip|just do it|proceed|continue)\b/i

/** A plan worth attaching: more than one step, or one step meant for another model than the main one. */
export function isWorthAttaching(plan: Plan): boolean {
  return plan.tasks.length > 1 || plan.tasks.some(t => t.tier !== 'sonnet')
}

/**
 * The plan the model reads with the message: steps, how to run them, the step-specific engineering rules and the final
 * pass. The Unity C# rules ride only in a Unity project and only when a step writes C# (an unknown answer keeps them).
 */
export function planContext(plan: Plan, opts: { unity?: boolean; unityVersion?: string; first?: { title: string; tier: Tier; parallel: boolean }[]; added?: { title: string; tier: Tier; parallel: boolean }[] } = {}): string {
  const added = opts.added ?? []
  const first = opts.first ?? []
  // a step that comes before the plan's own is numbered 0, so the plan's step numbers (the rules below name them) hold
  const steps = [
    ...first.map(t => `0. [${TIER_LABEL[t.tier]}] ${t.title}`),
    ...[...plan.tasks, ...added].map((t, i) => `${i + 1}. [${TIER_LABEL[t.tier]}${t.parallel ? ' ∥' : ''}] ${t.title}`),
  ]
  return [
    'Command Deck plan for this message (the person did not type this; follow it unless it is wrong):',
    `Brief: ${plan.prompt}`,
    'Steps:',
    ...steps,
    'How to run it: do Sonnet and Opus steps yourself. Each [Haiku] step goes to its own subagent with model "haiku", given only its title, the exact spot to change and its done condition, no project history. Start the ∥ Haiku steps together only when they edit different files; steps on one file run in order. Read-heavy search goes to an Explore subagent; long builds and tests run in the background. Check each subagent edit before the next step. Report which steps ran on Haiku, which ran in parallel and any failure. Board: give each subagent its step title word for word as its description; log your own steps with TodoWrite (or TaskCreate/TaskUpdate) under the same titles, or, without those tools, end the reply with `Done: <step title>` for each step verified and `Skip: <step title>` for each step dropped on purpose.',
    ...(opts.unity && plan.csharp !== false ? [unityRules(plan.tasks.map(t => `${t.title} ${t.why}`).join(' '), opts.unityVersion)] : []),
    ...(first.some(t => t.title === PLAN_REVIEW_TITLE) ? [PLAN_REVIEW_HOW] : []),
    ...(added.some(t => t.title === REVIEW_TITLE) ? [REVIEW_HOW] : []),
    ...[guidelineExtras(plan)].filter(Boolean),
    ...(plan.tasks.length > 1 ? [finalPass(plan)] : []),
  ].join('\n')
}

export const HOUSE_SECTION = `Command Deck is active. Keep the main context small: send read-heavy exploration to an Explore subagent (it runs on Haiku), give precise mechanical edits to Haiku subagents (several at once when they touch different files), run long builds, tests and checks in the background, and keep replies short. Wait for every background subagent before the final answer; never redo work one was given. Keep the board true: every subagent becomes a card named by its description, so give each a clear one. New work you plan and work you finish yourself goes on the board through TodoWrite or TaskCreate/TaskUpdate; without those tools, end a reply that changed files with a line "Todo: <title>" for each new task, "Done: <title>" for each task verified done and "Skip: <title>" for each task dropped on purpose, so no card stays in Todo once nothing will work on it.`

// rides only in a repo graft has indexed; fixed for the whole chat, so the cached system prompt never changes
export const GRAFT_LINE = 'Code search in this repo: graft first (`graft ask "<task>" --source` for how or where, `graft grep "<literal>"` for every hit, `graft callers <symbol>` before changing a symbol). Plain grep only for text graft does not index.'

export const houseSection = (o: { graft?: boolean } = {}): string => (o.graft ? `${HOUSE_SECTION}\n${GRAFT_LINE}` : HOUSE_SECTION)

// said once after a plain text search while graft sat unused: the reminder costs tokens only when graft was skipped
export const GRAFT_NUDGE = 'Graft indexes this repo. For the next code search use `graft ask "<task>" --source` or `graft grep "<literal>"`: exact file:line for fewer tokens than grep.'
export const GRAFT_NUDGE_MAX = 3

/** A graft CLI question run through Bash; its answer opens with the same "tokens saved" line as the MCP tools. */
export const isGraftCli = (command: unknown): boolean => /\bgraft\s+(ask|grep|skeleton|callers|map)\b/.test(String(command ?? ''))

/** A text search as the command's own job: the Grep tool, or grep/rg leading a Bash command. A `| grep` filter on other output is not one. */
export const isTextSearch = (tool: string, command?: unknown): boolean =>
  tool === 'Grep' || (tool === 'Bash' && /(^|&&|;)\s*(rtk\s+)?(grep|rg|ag|ack)\s/.test(String(command ?? '')))

// ---------------------------------------------------------------- caveman

// The rules are written out here, not left to a skill: a skill has to be installed, listed and loaded with a tool call,
// and each of those failed in some chats. Inline text is in every chat from the first reply and costs no round trip.
export const CAVEMAN_SECTION = `Caveman mode is ON: Command Deck keeps it on in every chat. Every reply, the first included: short blunt sentences, small words, no filler, no praise, no preamble, no recap of the request. Drop articles where it still reads smooth. Long reports and summaries too. Three bullets at most per list. Code, commands, paths, numbers, error text and names stay exact. "stop caveman" or "normal mode" from the person turns it off.`

// the section promises these words turn it off, so the deck stops reminding and counting for the rest of the chat
export const CAVEMAN_OFF = /\b(stop caveman|normal mode)\b/i

// Rides with every typed message. A rule that sits once in the system prompt fades as a chat grows and gives way in
// long reports; a line beside the newest message does not. About 20 tokens a message, far less than one wordy reply.
export const CAVEMAN_REMINDER = 'Caveman mode is on for this reply, long reports and summaries included: short blunt sentences, small words, no filler, drop articles. Code and names stay exact.'

// ---------------------------------------------------------------- effort routing
// The planner's Haiku pass already reads every real request, so it also says how hard the main model must think; the
// level is sent with the turn's own requests (turn.step). Nothing is added to the prompt and no skill is loaded.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const asEffort = (v: unknown): Effort | undefined => EFFORTS.find(x => x === String(v ?? '').toLowerCase())
const rank = (e: Effort): number => EFFORTS.indexOf(e)

/** A level the person named in the message ("effort: low", "max effort"): it is used as named. */
export function namedEffort(text: string): Effort | undefined {
  const m = /\b(?:effort\s*[:=]?\s*(low|medium|high|xhigh|max)|(low|medium|high|xhigh|max)\s+effort)\b/i.exec(text)
  return m ? asEffort(m[1] ?? m[2]) : undefined
}

/**
 * The level a turn is sent with, or undefined to leave the request alone. Contract: nothing without a session level (a
 * model with no effort, or auto); a named level wins; mode 1 never goes above the session's level, mode 2 may; while
 * saving (a usage limit nearly spent) nothing goes above medium; a result equal to the session's level is undefined.
 */
export function routedEffort(a: { want?: Effort; named?: Effort; session?: unknown; mode: number; isSaving?: boolean }): Effort | undefined {
  const session = asEffort(a.session)
  if (a.mode <= 0 || !session) return undefined
  let out = a.named ?? a.want ?? session
  if (!a.named && a.mode === 1 && rank(out) > rank(session)) out = session
  if (!a.named && a.isSaving && rank(out) > rank('medium')) out = 'medium'
  return out === session ? undefined : out
}

// Some models cannot take a new effort level without writing the whole prefix to the cache again. The deck cannot ask
// which, so it watches the first request it sends at a changed level. Until a model family is proven, the level changes
// only while the context is under EFFORT_PROBE_MAX, so finding out costs one bounded cache write, once per family.
// One bad reading is only a suspicion (a compaction or a lapsed entry reads the same); a second one settles it.
export type EffortTrust = 'ok' | 'suspect' | 'bad' | undefined
export const EFFORT_PROBE_MAX = 80_000
export const mayRouteEffort = (trust: EffortTrust, ctxTokens: number): boolean => trust === 'ok' || (trust !== 'bad' && ctxTokens < EFFORT_PROBE_MAX)
export const nextTrust = (prev: EffortTrust, verdict: 'ok' | 'bad' | undefined): EffortTrust =>
  verdict === 'ok' ? 'ok' : verdict === 'bad' ? (prev === 'suspect' || prev === 'bad' ? 'bad' : 'suspect') : prev

/**
 * The level one main request goes out at. `routed` is routedEffort's answer (undefined = the session's own level),
 * `prev` what this model family was last sent and the session level it had then. Contract: a proven family, or an
 * unproven one in a small chat, gets the routed level; a refuted one the session's; an unproven one in a big chat
 * keeps the level it had, since a change there is the very cost the probe limit bounds, unless the person changed
 * their own level meanwhile, which is theirs to pay for.
 */
export function stepEffort(a: { routed?: Effort; session?: string; trust: EffortTrust; ctxTokens: number; prev?: { sent?: string; session?: string } }): string | undefined {
  if (mayRouteEffort(a.trust, a.ctxTokens)) return a.routed ?? a.session
  if (a.trust !== 'bad' && a.prev && a.prev.session === a.session) return a.prev.sent
  return a.session
}

/**
 * What a request sent at a changed level proves. `bad`: almost nothing was read from the cache, so the prefix was paid
 * for again. `ok`: most of it was read. Undefined: a prefix too small to tell, or a share in between (a big new message).
 */
export function effortVerdict(u: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined, minTokens = 20_000): 'ok' | 'bad' | undefined {
  const read = u?.cache_read_input_tokens ?? 0
  const total = read + (u?.cache_creation_input_tokens ?? 0)
  if (total < minTokens) return undefined
  return read < total * 0.1 ? 'bad' : read > total * 0.5 ? 'ok' : undefined
}

// ---------------------------------------------------------------- planner gate
const ASKS = /^(why|what|how|which|when|where|who|is|are|was|were|does|do|did)\b/i
const BUILDS = /\b(fix|add|make|build|implement|change|update|create|remove|delete|write|refactor|rename|move|run|deploy|install|commit|push|can you|could you|would you|please)\b/i

/** A one-line question with no build word: it is answered in chat, so the planner call (and its wait) is skipped. */
export function isPlainQuestion(text: string): boolean {
  const t = text.trim()
  return t.length < 240 && !t.includes('\n') && t.endsWith('?') && ASKS.test(t) && !BUILDS.test(t)
}

// ---------------------------------------------------------------- project memory
const BULLET = /^\s*[-*]\s+(\S.*)$/
/** Splits a handoff note from the lasting facts listed under it: bullet lines only, up to 3, and "none" in any wording gives none. */
export function splitFacts(note: string): { note: string; facts: string[] } {
  const at = note.search(/^#+\s*Lasting facts\b.*$/im)
  if (at < 0) return { note: note.trim(), facts: [] }
  const facts = note
    .slice(at)
    .split('\n')
    .slice(1)
    .flatMap(l => BULLET.exec(l)?.[1]?.trim() ?? [])
    .filter(f => !/^none\b/i.test(f))
    .slice(0, 3)
  return { note: note.slice(0, at).trim(), facts }
}

const factKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** The memory's bullets, oldest first. */
export const memoryFacts = (memory: string): string[] => memory.split('\n').flatMap(l => BULLET.exec(l)?.[1]?.trim() ?? [])

export const MEMORY_HEAD = '# Project memory\nLasting facts Command Deck gathers at each handoff. Edit or delete lines freely.\n'
/**
 * Project memory with new facts appended as bullets. Contract: a fact already there (case and punctuation ignored) is
 * not added; past `max` bullets the oldest bullets go; every other line (the person's own notes and headings) stays.
 */
export function mergeFacts(memory: string, facts: string[], max = 40): string {
  const have = memoryFacts(memory)
  const add = facts.map(f => f.trim()).filter((f, i, all) => f && !have.some(h => factKey(h) === factKey(f)) && all.findIndex(g => factKey(g) === factKey(f)) === i)
  if (!add.length) return memory
  const lines = `${(memory.trim() ? memory : MEMORY_HEAD).replace(/\n+$/, '')}\n${add.map(f => `- ${f}`).join('\n')}`.split('\n')
  for (let over = have.length + add.length - max; over > 0; over--) lines.splice(lines.findIndex(l => BULLET.test(l)), 1)
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------- files

export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
export const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, '')

const box = (s: Status): string => (s === 'done' ? '[x]' : s === 'failed' ? '[!]' : s === 'skipped' ? '[-]' : s === 'doing' ? '[~]' : '[ ]')

export function progressMarkdown(goal: string, tasks: Task[], date: string): string {
  const next = tasks.filter(t => t.status === 'todo' || t.status === 'doing')
  return [
    `# Progress ${date}`,
    '',
    `Goal: ${goal || '(none set)'}`,
    '',
    '## Tasks',
    ...tasks.map(t => `- ${box(t.status)} ${t.title} — ${TIER_LABEL[t.tier]}${t.note ? ` — ${t.note}` : ''}`),
    '',
    '## Next steps',
    ...(next.length ? next.map(t => `- ${t.title}`) : ['- nothing open']),
    '',
  ].join('\n')
}

export function finalLogMarkdown(
  goal: string,
  tasks: Task[],
  usage: Record<string, number>,
  savings: Savings,
  cost: number | undefined,
  date: string,
): string {
  const rows = tasks.map(
    t =>
      `| ${box(t.status)} | ${t.title} | ${TIER_LABEL[t.tier]} | ${compact(t.tokens)} | ${t.why || ''} |`,
  )
  const mix = shares(usage).map(s => `- ${s.name}: ${s.pct.toFixed(0)}% (${compact(s.tokens)} tokens)`)
  return [
    `# Run log ${date}`,
    '',
    `Goal: ${goal || '(none)'}`,
    '',
    '| Done | Task | Model | Tokens | Why this model |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Model mix today',
    ...mix,
    '',
    `Estimated tokens saved: Graft ${compact(savings.graft)}, Context Optimizer ${compact(savings.optimizer)}, Caveman ${compact(savings.caveman)}, Ponytail ${compact(savings.ponytail)}, Graphify ${compact(savings.graphify)}`,
    cost === undefined ? '' : `Session cost so far: $${cost.toFixed(2)}`,
    '',
  ].join('\n')
}

export const DEFAULT_RULES = `# Rules every new chat must follow
- Keep answers short; say what changed and what to check.
- Commit finished changes locally with only your own files; do not push unless asked.
- Add your own rules here: edit .claude/deck/rules.md in the project.
`

/** Long text cut to head and tail: the end of an answer is where its offer or fix list usually sits. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.max(1, Math.floor((max - 3) / 2))
  return `${text.slice(0, half)} … ${text.slice(-half)}`
}

/** The first prompt of a fresh chat: the person's own message when there is one, otherwise read and wait. */
export function freshPrompt(path: string, carry?: string): string {
  return carry
    ? `Read ${path} for context from the previous chat. Then do this:\n\n${carry}`
    : `Read ${path}. In a few lines, give me the main points of the last answer and where things stand, then wait for me. Do not start any task.`
}

/** A due fresh chat starts only on a typed message while nothing runs, so it never cuts work or an unread answer. */
export function freshGate(a: { isDue: boolean; isHuman: boolean; text: string; isBusy: boolean }): boolean {
  return a.isDue && a.isHuman && !a.isBusy && !a.text.trim().startsWith('/') && a.text.trim().length > 0
}

export function handoffMarkdown(args: {
  goal: string
  tasks: Task[]
  rules: string
  git: GitInfo | null
  date: string
  contextPct?: number
  summary?: string
  lastAnswer?: string
  memory?: string
}): string {
  const g = args.git
  return [
    `# Handoff ${args.date}`,
    '',
    "Start of the new chat: read this file, then do only what the person's message asks. Goal and Tasks are the deck's plan and may be stale: never start them on your own, and if they disagree with Where things stand or the Last answer, trust those and ask.",
    '',
    ...(args.summary ? ['## Where things stand', args.summary.trim(), ''] : []),
    ...(args.lastAnswer?.trim() ? ['## Last answer (the person read this just before the clear)', args.lastAnswer.trim(), ''] : []),
    '## Goal',
    args.goal || '(none set)',
    '',
    '## Rules',
    args.rules.trim(),
    '',
    ...(args.memory && memoryFacts(args.memory).length ? ['## Project memory', ...memoryFacts(args.memory).map(f => `- ${f}`), ''] : []),
    '## Repo state',
    g
      ? `Branch ${g.branch}${g.upstream ? ` → ${g.upstream}` : ' (no upstream)'}${g.ahead ? `, ahead ${g.ahead}` : ''}${g.behind ? `, behind ${g.behind}` : ''}; ${g.dirty.length} changed files`
      : 'unknown',
    ...(g && g.dirty.length ? ['Changed files:', ...g.dirty.slice(0, 20).map(f => `- ${f}`)] : []),
    '',
    '## Tasks',
    ...args.tasks.map(t => `- ${box(t.status)} ${t.title} (${TIER_LABEL[t.tier]})${t.note ? ` — ${t.note}` : ''}`),
    '',
    '## Next steps',
    ...(args.tasks.filter(t => t.status !== 'done' && t.status !== 'skipped').map(t => `- ${t.title}`) || []),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- tips

export const HANDOFF_ASK = `Write a handoff note for a fresh chat that continues this work. Plain markdown bullets, under 250 words: what was being built and why, decisions made, what is finished, what is half done (file:line where useful), known problems, and the very next step. Facts only; no greetings.`

/** The handoff prompt anchored on the current goal and the unfinished board cards, so the note describes this goal
 * (not an older topic from earlier in the chat) and what was mid-way when the chat ended. */
export function handoffAsk(goal: string, tasks: Pick<Task, 'title' | 'status'>[], known: string[] = []): string {
  const open = tasks.filter(t => t.status !== 'done' && t.status !== 'skipped').map(t => `- ${t.title} (${t.status})`)
  return [
    HANDOFF_ASK,
    goal ? `Current goal: ${goal}` : '',
    open.length ? `Unfinished board tasks. Say which of these this chat really finished and checked, and which was mid-way:\n${open.join('\n')}` : '',
    'Lead with where THIS goal stands and the exact next action.',
    `After the note add a section "## Lasting facts": up to 3 bullets that stay true after this task and that a new chat could not read from the code (a command that works, a trap, a decision and its reason). One line each. Write "none" when there is nothing new.${known.length ? ` Already known, do not repeat:\n${known.slice(-40).map(k => `- ${k}`).join('\n')}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const TIPS: string[] = [
  'Run a second Claude in a git worktree: one builds, one reviews, no stepping on each other.',
  'A Stop hook that runs your tests turns "done" into "done and passing".',
  'Keep the start of every prompt stable: a steady prefix keeps prompt caching working.',
  'Ask for file:line references instead of pasted code; answers shrink and stay checkable.',
  'Name the exact file or symbol in the ask; a precise ask is faster and cheaper.',
  'Use /rewind after a wrong turn rather than arguing the model back on track.',
  'Docs MCPs (library docs on demand) beat guessing an API from memory.',
  'Paste the exact error text or stack trace, not a description of it.',
  'End a request with how to verify it ("the build passes", "this test goes green"); Claude checks its own work.',
  'Commit after each finished change so any wrong turn is one revert away.',
  'Keep CLAUDE.md short and specific; every line is paid for on every turn.',
  'Read the diff before you accept a big change; /code-review catches what a skim misses.',
  'Put build output, logs and generated folders in your ignore files so searches skip them.',
  'Set a verify command (/command-deck verify <your test or build command>): the deck runs it after each change and sends failures back to the model.',
  'Put a "never do this" in .claude/deck/guards.md as pattern => reason (plain text, * for anything between): the deck refuses the command and tells the model why.',
]

/** How often the Random Tips card moves on to another tip. */
export const TIP_ROTATE_MS = 10 * 60_000

export const TUTOR_SYSTEM = `You are a patient senior engineer teaching one idea about working with AI coding assistants (Claude Code and similar).
Explain the idea in the tip in depth, independent of any particular project: what it is, why it saves time or tokens, how to do it step by step, one concrete example, common mistakes, and when not to use it.
Markdown, headings and short paragraphs, under 600 words. No preamble.`

export const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tip'

export const TIP_COLORS = ['magenta', 'cyan', 'green', 'yellow', 'blue']

// ------------------------------------------------------------ prompt cache (cold guard and keep-warm)
// The server's cache is never queried: coldness is estimated from the time since the last model call.
export type ColdCheck = { isCold: boolean; idleMin: number }
export function coldCheck(now: number, lastTouch: number, ttlMin: number, tokens: number, minTokens: number): ColdCheck {
  if (!lastTouch || tokens < minTokens) return { isCold: false, idleMin: 0 }
  const idleMin = Math.floor((now - lastTouch) / 60_000)
  return { isCold: idleMin >= ttlMin, idleMin }
}

// a cold write bills the whole prefix at the cache-write rate (about 2x input for the one-hour cache)
export function rewriteDollars(tokens: number, inPerM: number): number {
  return (tokens / 1_000_000) * inPerM * 2
}

// after a ping: keep going only while it read the prefix and wrote little (cache-tax's own rule)
export function warmVerdict(u: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): 'ok' | 'stop' {
  const read = u?.cache_read_input_tokens ?? 0
  const wrote = u?.cache_creation_input_tokens ?? 0
  if (read <= 0) return 'stop'
  return wrote >= read * 0.1 ? 'stop' : 'ok'
}

export const WARM_PING = 'Cache keep-warm ping. Reply with the single word: ok'

// ------------------------------------------------------------ context breakdown
export const CTX_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red', 'white', 'gray']

// readable text on each band colour
export const ctxInk = (color: string): string => (['blue', 'red', 'magenta'].includes(color) ? 'white' : 'black')

export type Segment = { name: string; tokens: number; pct: number; color: string }

// one coloured run per used category, as its share of the window
export function ctxSegments(parts: CtxPart[], window: number): Segment[] {
  const used = parts.filter(p => p.kind === 'used' && p.tokens > 0)
  if (!window || !used.length) return []
  return used.map((p, i) => ({ name: p.name, tokens: p.tokens, pct: (p.tokens / window) * 100, color: CTX_COLORS[i % CTX_COLORS.length] ?? 'white' }))
}

// ------------------------------------------------------------ smart tool deferral
export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

export const TOOLS_SYSTEM = `You decide which connected MCP servers a developer's next prompt could need.
Return ONLY one JSON object, no prose: {"need":["server",...]}
Rules:
- List a server if the prompt could plausibly use any of its tools. When unsure, include it: a missing server is worse than a loaded one.
- Servers named or clearly implied in the prompt, and ones the work obviously touches (a browser for web pages, a game engine for scene work), are needed.
- A plain code or text question needs none of the servers except code-search ones.`

export function toolsPrompt(text: string, servers: { server: string; tokens: number; names: string[] }[]): string {
  const list = servers.map(s => `- ${s.server} (${s.tokens} tokens): ${s.names.slice(0, 6).join(', ')}`).join('\n')
  return `Prompt:\n${text.slice(0, 1500)}\n\nConnected servers:\n${list}`
}

export function parseNeed(raw: string): string[] | null {
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const d = JSON.parse(raw.slice(a, b + 1))
    return Array.isArray(d.need) ? d.need.map((x: unknown) => String(x)) : null
  } catch {
    return null
  }
}

// the token-saving tools stay in front whatever the chooser says: behind search they are skipped, not used
export const KEEP_SERVERS = ['graft', 'token_optimizer', 'graphify']

export const serverOfTool = (tool: string): string | null => /^mcp__(.+?)__/.exec(tool)?.[1] ?? null

export const SMOKE_TITLE = 'Smoke test run: confirm the whole change works'
// a Unity plan that writes C# is checked where Unity can check it: its own compiler and its EditMode tests
export const SMOKE_TITLE_UNITY = 'Smoke test run: Unity compiles clean, EditMode tests pass (Unity MCP)'
// a plan that changes code ends with a smoke test run, so the board is not done until the work is checked; a plan
// with no code (release notes, research) gets none, or its card would sit in Todo with nothing to test
type Step = { title: string; tier: Tier; why: string; parallel: boolean }
export function withSmokeTask<T extends Step>(tasks: T[], code = true, isUnityCs = false): (T | Step)[] {
  if (!code || tasks.some(t => /smoke/i.test(t.title))) return tasks
  return [...tasks, { title: isUnityCs ? SMOKE_TITLE_UNITY : SMOKE_TITLE, tier: 'haiku', why: 'Run the project smoke test and report the result', parallel: false }]
}

// ------------------------------------------------------------ fresh-eyes review
export const REVIEW_TITLE = 'Fresh-eyes review: subagent reads only the diff'
export const REVIEW_HOW = `How to run "${REVIEW_TITLE}": start one subagent with model "sonnet" that gets no history, only the output of \`git diff\` and two lines on what the change is meant to do. Ask it for correctness bugs ranked by severity, each with file:line and a failing case, no style notes. Fix the real ones, say which you rejected and why.`
const RISKY_WORDS = /\b(secur\w*|auth\w*|token|password|payment|purchase|migrat\w*|delet\w*|concurren\w*|race|encrypt\w*)\b/i

/** A plan worth a second pair of eyes: it changes code and is big (5 steps or more), hard (an Opus step) or touches something costly to get wrong. */
export function isRiskyPlan(plan: Pick<Plan, 'code' | 'tasks'>): boolean {
  return plan.code !== false && (plan.tasks.length >= 5 || plan.tasks.some(t => t.tier === 'opus' || RISKY_WORDS.test(t.title)))
}

/** The plan's steps with the review step added after the work, for a risky plan only; a plan that already has one is left alone. */
export function withReviewTask<T extends Step>(tasks: T[], plan: Pick<Plan, 'code' | 'tasks'>, isOn = true): (T | Step)[] {
  if (!isOn || !isRiskyPlan(plan) || tasks.some(t => /review/i.test(t.title))) return tasks
  return [...tasks, { title: REVIEW_TITLE, tier: 'sonnet', why: 'Catch bugs before the smoke test', parallel: false }]
}

// ------------------------------------------------------------ plan review
// A wrong plan costs every step built on it, so a risky plan is read once before any code is written. The reviewer
// gets the brief and the steps only: it judges the plan, it does not start the work.
export const PLAN_REVIEW_TITLE = 'Plan review: subagent reads the plan before any code'
export const PLAN_REVIEW_HOW = `How to run "${PLAN_REVIEW_TITLE}": before step 1, start one subagent with model "sonnet" that gets no history, only the brief and the step list above. Ask it, as a staff engineer, for at most 5 points: a wrong assumption, a missing step, a simpler route, a step that can break something. It may read the files the plan names and nothing else, and it writes no code. Change the plan where it is right, and say in one line what you changed and what you rejected.`

/** The step a risky plan starts with, or none: a small plan, a plan with no code, and one that already has a plan review are left alone. */
export function planReviewSteps(plan: Pick<Plan, 'code' | 'tasks'>, isOn = true): Step[] {
  if (!isOn || !isRiskyPlan(plan) || plan.tasks.some(t => /plan review/i.test(t.title))) return []
  return [{ title: PLAN_REVIEW_TITLE, tier: 'sonnet', why: 'Catch a wrong plan early', parallel: false }]
}

/**
 * What "done" means in a brief ("Done when: ...", "Definition of done: ..."), as one line; '' when the brief names
 * none. The line ends at the next "Label:" or blank line, and one too short to be a condition is not a goal.
 */
export function doneWhen(brief: string): string {
  const m = /(?:^|[\s.;])(?:[Dd]one when|[Dd]efinition of done)\s*[:=]\s*([\s\S]+?)(?=\s+[A-Z][A-Za-z ]{0,24}:\s|\n\s*\n|$)/.exec(brief)
  const text = (m?.[1] ?? '').replace(/\s+/g, ' ').trim()
  return text.length >= 12 && text.includes(' ') ? clip(text, 400) : ''
}

// ------------------------------------------------------------ verify gate
// After a turn that changed files the deck runs the project's own check in the background. A pass costs no tokens; a
// failure goes back to the model with the end of the output. The command is the person's: read from
// .claude/deck/verify.txt and run only once they allowed that exact text, so a cloned repo cannot run anything.
/** The verify command in a verify.txt: its first line that is not blank or a # comment. */
export const verifyCommand = (file: string): string => file.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? ''

// how often one request may be sent back to the model before the deck only reports: the same fix failing twice means stop
export const VERIFY_MAX_SENDS = 2

/** What the model reads when the check fails: the command, its exit code and the end of its output (where the failure is). */
export function verifyFailText(what: string, exitCode: number | undefined, output: string): string {
  const tail = output.trim().split('\n').slice(-60).join('\n').slice(-4000)
  return `Command Deck verify failed after your last change: ${what}${exitCode === undefined ? '' : ` (exit ${exitCode})`}.\n${tail || '(no output)'}\nFind the cause and fix it. Do not weaken the check.`
}

/** A file edit that should trigger the check: a tool that writes a file, answered without error. */
export const isFileEdit = (tool: string): boolean => tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit'

/** The lowercase extension of a path ("cs", "tsx"), or "" when it has none. */
export const extOf = (path: unknown): string => /\.([a-z0-9]+)$/i.exec(String(path ?? ''))?.[1]?.toLowerCase() ?? ''

// ------------------------------------------------------------ Unity editor state (through the Unity MCP's own tools)
export const UNITY_STATE_TOOL = 'mcp__unity__unity_editor_state'
export const UNITY_ERRORS_TOOL = 'mcp__unity__unity_get_compilation_errors'
const dataOf = (text: unknown): Record<string, unknown> | null => {
  try {
    const d = (JSON.parse(String(text)) as { data?: unknown }).data
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null
  } catch {
    return null
  }
}
/** True only when the editor's own answer says it is in Play mode; an answer that cannot be read is not Play. */
export const unityIsPlaying = (text: unknown): boolean => dataOf(text)?.isPlaying === true
/** The compile check's answer: still compiling, or the errors as text ('' when there are none or the answer cannot be read). */
export function unityCompile(text: unknown): { isCompiling: boolean; errors: string } {
  const d = dataOf(text)
  const entries = Array.isArray(d?.entries) ? d.entries : []
  return { isCompiling: d?.isCompiling === true, errors: entries.length ? entries.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : '' }
}
// the compile gate asks for the compile itself: an editor in the background has not looked at the changed files yet
export const UNITY_MENU_TOOL = 'mcp__unity__unity_execute_menu_item'
export const UNITY_REFRESH_MENU = 'Assets/Refresh'
/** True when the editor's own answer says it is compiling; an answer that cannot be read is not. */
export const unityIsCompiling = (text: unknown): boolean => dataOf(text)?.isCompiling === true
/** True when the Unity MCP's answer says the call it was given worked. */
export const unityOk = (text: unknown): boolean => {
  try {
    return (JSON.parse(String(text)) as { success?: unknown }).success === true
  } catch {
    return false
  }
}
/** The editor version a project is made with, from its ProjectSettings/ProjectVersion.txt ('' when it names none). */
export const unityVersionOf = (file: string): string => /m_EditorVersion:\s*(\S+)/.exec(file)?.[1] ?? ''
export const UNITY_PLAY_DENY = 'Unity is in Play mode. A C# edit now recompiles under the running game and can hang the editor. Ask the person to stop Play (or stop it yourself if they already agreed), then make this edit again.'

// ------------------------------------------------------------ guards
// .claude/deck/guards.md: one rule a line, "pattern => reason". A Bash command the pattern matches is refused with the
// reason. The pattern is plain text with * for "anything between", matched without case: never a regular expression,
// because a project file must not be able to hang or crash the hook. A guard can only refuse, so the worst a cloned
// repo's guards can do is refuse commands and say why.
export type Guard = { parts: string[]; reason: string }
export function parseGuards(file: string): Guard[] {
  return file.split('\n').flatMap(line => {
    const m = /^\s*(?:[-*]\s+)?(.+?)\s*=>\s*(.+?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) return []
    const parts = m[1]!.toLowerCase().split('*').map(x => x.trim()).filter(Boolean)
    // a pattern with next to nothing in it would refuse everything
    return parts.join('').length >= 4 ? [{ parts, reason: m[2]! }] : []
  })
}
/** The first guard whose parts all appear in the command, in order. Linear in the command's length, which is capped. */
export function guardFor(guards: Guard[], command: unknown): Guard | undefined {
  const text = String(command ?? '').slice(0, 8000).toLowerCase()
  return guards.find(g => {
    let at = 0
    for (const part of g.parts) {
      const i = text.indexOf(part, at)
      if (i < 0) return false
      at = i + part.length
    }
    return true
  })
}
export const guardDeny = (g: Guard): string => `Blocked by this project's guard (.claude/deck/guards.md): ${g.reason}`

// ------------------------------------------------------------ corrections
// A message that corrects the model may hold a lasting rule. The words only hint at it: nothing is kept until the
// person presses Save in the pane, and what is kept is theirs to edit (.claude/deck/conventions.md).
const CORRECTION_START = /^(no\b|nope\b|wrong\b|not (like )?(that|this)\b|don'?t\b|do not\b|never\b|always\b|stop\b|i (said|told you|asked)\b|that'?s (not|wrong)\b|you (forgot|missed|ignored|broke|should(n'?t)?|must)\b|why did you\b)/i
// a stated habit ("I always use X for Y") is kept the same way a correction is
const CORRECTION_ANY = /\b(from now on|next time|in future|not what i asked|i (already )?(said|told you)|as i said|i (always|never|only) [a-z]+|i prefer\b|remember (that|this)|keep in mind)\b/i
/** True when a typed message reads like a correction: short, not a command, and worded as one. A hint, never proof. */
export function isCorrection(text: string): boolean {
  const t = text.trim()
  if (t.length < 12 || t.length > 400 || t.startsWith('/')) return false
  return CORRECTION_START.test(t) || CORRECTION_ANY.test(t)
}
export const RULE_SYSTEM = `You turn a developer's correction of an AI coding assistant into one lasting project rule. Reply with the rule only: one line, under 25 words, an instruction that holds next time too, in plain words, with every file name, tool name and number kept exact. No "this time", no quotes, no bullet. If the correction is a one-off with nothing to keep, reply with the single word NONE.`
export const rulePrompt = (correction: string, before: string): string => `What the assistant last said (end of it):\n${before.slice(-500) || '(nothing)'}\n\nThe correction:\n${correction}`
/** The rule to keep: the model's one line, or the person's own words when it gave none. */
export function parseRule(raw: unknown, own: string): string {
  const line = String(raw ?? '').split('\n').map(l => l.replace(/^[\s>*-]+/, '').replace(/^["'`]+|["'`]+$/g, '').trim()).find(Boolean) ?? ''
  return clip((/^none\b/i.test(line) || line.length < 8 ? own : line).replace(/\s+/g, ' ').trim(), 240)
}
/** The conventions file with the rule added as a bullet; a rule it already holds leaves it as it was. */
export function addRule(file: string, rule: string): string {
  const text = rule.replace(/\s+/g, ' ').trim()
  if (!text || file.toLowerCase().includes(text.toLowerCase())) return file
  return `${file.trim() ? `${file.trimEnd()}\n` : ''}- ${text}\n`
}

// ------------------------------------------------------------ dead weight
// A skill's listing and a server's loaded tools are paid for in every chat, used or not. The deck keeps a book per
// project: when each was last called, what each costs, and the person's own choices. At the start of a chat the ones
// nothing called for a while are left out of that chat (a skill's line leaves the listing, a server's tools go behind
// search). Nothing is uninstalled: a skill still runs when typed, a tool still loads when asked for, and a call puts
// the item back from the next chat on.
export type WeightKind = 'skill' | 'mcp'
export type WeightBook = {
  /** when the deck began watching this project: nothing is called dead on less than `days` of watching */
  since: number
  /** key -> when it was last called here */
  last: Record<string, number>
  /** key -> its name as listed and what it costs in every chat */
  cost: Record<string, { name: string; tokens: number }>
  /** keys the person removed by hand: left out whatever the record says */
  off: string[]
  /** keys the person put back: never left out */
  keep: string[]
  /** the person's own on/off for removing by itself; absent means the plugin setting decides */
  auto?: boolean
}
export const newBook = (now: number): WeightBook => ({ since: now, last: {}, cost: {}, off: [], keep: [] })
/** A stored book made whole: one written by hand or by an older version may lack parts. */
export function asBook(raw: unknown, now: number): WeightBook {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Partial<WeightBook>
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    since: typeof b.since === 'number' ? b.since : now,
    last: b.last && typeof b.last === 'object' ? b.last : {},
    cost: b.cost && typeof b.cost === 'object' ? b.cost : {},
    off: list(b.off),
    keep: list(b.keep),
    ...(typeof b.auto === 'boolean' ? { auto: b.auto } : {}),
  }
}
/** The name a use is filed under. A skill is called with or without its plugin's prefix ("ponytail:ponytail-audit", "ponytail-audit"), so only its own name counts; a server's whole name does. */
export const useKey = (kind: WeightKind, name: unknown): string => `${kind}:${norm(kind === 'skill' ? (String(name ?? '').split(':').pop() ?? '') : String(name ?? ''))}`
const DAY_MS = 86_400_000
/** Listed items nothing called within `days` (or since the watch began), dearest first; the person's kept ones and crumbs under `min` tokens are left out. */
export function idleKeys(book: WeightBook, now: number, days: number, min = 30): string[] {
  const since = now - days * DAY_MS
  return Object.keys(book.cost)
    .filter(k => book.cost[k]!.tokens >= min && (book.last[k] ?? 0) < since && !book.keep.includes(k))
    .sort((a, b) => book.cost[b]!.tokens - book.cost[a]!.tokens)
}
/**
 * The keys a new chat starts without. By hand: every key the person removed. By itself (`isAuto`): the idle ones,
 * and only once the project was watched for `days`, so an item is never dropped on no evidence.
 */
export function pruneKeys(book: WeightBook, now: number, days: number, isAuto: boolean, min = 30): string[] {
  const byHand = book.off.filter(k => !book.keep.includes(k))
  const isWatched = now - book.since >= days * DAY_MS
  const bySelf = isAuto && isWatched ? idleKeys(book, now, days, min) : []
  return [...new Set([...byHand, ...bySelf])]
}
/** The keys the chat's first message names (the item's whole name, or a word of it four letters or longer): those stay in. */
export function namedKeys(keys: string[], text: string): string[] {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const flat = norm(text)
  return keys.filter(k => {
    const name = k.replace(/^(skill|mcp):/, '')
    return (name.length >= 4 && flat.includes(name)) || name.split('_').some(w => w.length >= 4 && words.has(w))
  })
}
/**
 * The skill listing without the removed skills. An entry is a line that starts "- name: " and runs to the next such
 * line; text before the first entry is kept. A listing in another shape matches nothing and comes back as it was.
 */
export function pruneListing(text: string, removed: ReadonlySet<string>): string {
  if (!removed.size) return text
  const out: string[] = []
  let isDropping = false
  for (const line of text.split('\n')) {
    const name = /^- (\S+?): /.exec(line)?.[1]
    if (name !== undefined) isDropping = removed.has(useKey('skill', name))
    if (!isDropping) out.push(line)
  }
  return out.join('\n')
}

// ------------------------------------------------------------ stuck detector
export const STUCK_AFTER = 3
export const STUCK_NUDGE = 'The same call has failed three times with the same error. Stop repeating it: say what the error means, check the assumption behind the call, and try a different approach.'
/** A short name for a failed call, so the same failure can be counted: the tool and the start of its error. */
export const failureKey = (tool: string, text: unknown): string => `${tool}|${String(text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`

// ------------------------------------------------------------ subagent briefs
// what a subagent writes back is read by the main chat at full price, so every brief asks for a tight report
export const BRIEF_SUFFIX = '\n\nKeep your final report tight: findings and changes with file:line, what to check, nothing about the steps you took.'

// ------------------------------------------------------------ what a new chat is told about the project
export const CONVENTIONS_ASK = `Scan this project and write .claude/deck/conventions.md, under 200 words, bullets only: the test, build and lint commands that really work here (run --help or read the config, do not guess), the naming and file layout the code follows, the libraries it uses for common jobs, and anything a newcomer would get wrong. Use an Explore subagent for the reading. If the project has a fast test or build command, also offer to put it in .claude/deck/verify.txt.`
/** The project notes a new chat starts with: lasting facts and conventions, cut to a size worth paying for on every turn. */
export function projectSection(memory: string, conventions: string, max = 1600): string {
  const facts = memoryFacts(memory).slice(-12)
  const parts = [
    ...(conventions.trim() ? [`Conventions:\n${conventions.trim()}`] : []),
    ...(facts.length ? [`Lasting facts:\n${facts.map(f => `- ${f}`).join('\n')}`] : []),
  ]
  return parts.length ? clip(`Project notes kept by Command Deck (.claude/deck/):\n${parts.join('\n')}`, max) : ''
}

// ------------------------------------------------------------ effort record
// what each effort level really cost today, so a wrong pick shows: a "low" turn that wrote far more than low turns do
export type EffortStat = { turns: number; out: number; flailed: number }
export function addEffortStat(stats: Record<string, EffortStat>, level: string, out: number): Record<string, EffortStat> {
  const s = stats[level] ?? { turns: 0, out: 0, flailed: 0 }
  // judged against the level's own mean so far, and only once there are enough turns to have one
  const isFlail = (level === 'low' || level === 'medium') && s.turns >= 3 && out > (s.out / s.turns) * 4
  return { ...stats, [level]: { turns: s.turns + 1, out: s.out + Math.max(0, out), flailed: s.flailed + (isFlail ? 1 : 0) } }
}
export const effortLine = (stats: Record<string, EffortStat>): string =>
  EFFORTS.filter(l => stats[l]?.turns)
    .map(l => `${l} ${stats[l]!.turns}× ${compact(stats[l]!.out / stats[l]!.turns)}${stats[l]!.flailed ? ` (${stats[l]!.flailed} ran long)` : ''}`)
    .join(' · ')

// titles from a TodoWrite call that are not on the board yet (compared case-insensitively)
export function newTodoTitles(todos: unknown, have: string[]): string[] {
  if (!Array.isArray(todos)) return []
  const known = [...have]
  const out: string[] = []
  for (const t of todos) {
    const title = String((t as { content?: unknown })?.content ?? '').trim()
    if (!title || known.some(h => sameTitle(h, title))) continue
    known.push(title)
    out.push(title)
  }
  return out
}

/** Same card title, ignoring case; a long title also matches one that contains it, so a reworded step is not added twice. */
export function sameTitle(a: string, b: string): boolean {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 12 && long.includes(short)
}

const TODO_STATUS: Record<string, Status> = { pending: 'todo', in_progress: 'doing', completed: 'done' }
/** Sets a card to the status the model's own task list gives it. That list is the authority, so it can also reopen
 * a card the board moved too early. */
export function setCard(t: Task, to: Status | undefined, now: number): Task {
  if (!to || to === t.status) return t
  const { startedAt, endedAt: _ended, ...rest } = t
  if (to === 'todo') return { ...rest, status: to }
  return { ...rest, status: to, startedAt: startedAt ?? now, ...(to === 'done' || to === 'skipped' ? { endedAt: now } : {}) }
}

/** Sets board cards to the statuses of a TodoWrite list (cards are found by title). */
export function syncTodos(tasks: Task[], todos: unknown, now: number): Task[] {
  if (!Array.isArray(todos)) return tasks
  const wanted = todos.map(t => ({ title: String((t as { content?: unknown })?.content ?? ''), to: TODO_STATUS[String((t as { status?: unknown })?.status)] }))
  return tasks.map(card => setCard(card, wanted.find(w => w.to && sameTitle(w.title, card.title))?.to, now))
}

/** The todo card a starting agent takes: one its description or prompt names (matched, so its end may close the card),
 * else the first of its model tier, else the first non-Haiku card, else the first. */
export function pickCard(tasks: Task[], tier: Task['tier'] | null, hints: string[] = []): { id: number; matched: boolean } | null {
  const todo = tasks.filter(t => t.status === 'todo')
  const named = todo.find(t => hints.some(h => sameTitle(t.title, h)))
  if (named) return { id: named.id, matched: true }
  const t = (tier ? todo.find(x => x.tier === tier) : todo.find(x => x.tier !== 'haiku')) ?? todo[0]
  return t ? { id: t.id, matched: false } : null
}

/** The card a starting subagent works: the todo or doing card its description or prompt names, else a new Doing card
 * titled by its description, so every agent the chat shows is on the board. */
export function agentCard(tasks: Task[], hints: string[], tier: Task['tier'], now: number): { tasks: Task[]; id: number } {
  const named = tasks.find(t => t.status !== 'done' && t.status !== 'failed' && t.status !== 'skipped' && hints.some(h => sameTitle(t.title, h)))
  if (named) return { id: named.id, tasks: tasks.map(t => (t.id === named.id ? setCard(t, 'doing', now) : t)) }
  const title = hints.map(h => h.replace(/\s+/g, ' ').trim()).find(Boolean)?.slice(0, 80) || 'Subagent'
  const id = Math.max(0, ...tasks.map(t => t.id)) + 1
  return { id, tasks: [...tasks, { id, title, tier, why: 'Subagent', parallel: false, status: 'doing', tokens: 0, startedAt: now }] }
}

/** `Todo: <title>`, `Done: <title>` and `Skip: <title>` lines in a reply, the board marks for a chat that has no task
 * tools. Skip closes work that was dropped on purpose, so it leaves Todo without counting as done. */
export function boardMarks(answer: unknown): { todo: string[]; done: string[]; skip: string[] } {
  const out = { todo: [] as string[], done: [] as string[], skip: [] as string[] }
  for (const line of String(answer ?? '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?`?(todo|done|skip|skipped):\s*(.+?)`?\s*$/i.exec(line)
    if (m) out[m[1]!.toLowerCase().startsWith('skip') ? 'skip' : (m[1]!.toLowerCase() as 'todo' | 'done')].push(m[2]!.trim())
  }
  return out
}

/** Applies reply marks: a Todo title not on the board is added, a Done title closes its card (or is added as done),
 * a Skip title closes its card as skipped (a Skip for a card not on the board changes nothing). */
export function applyMarks(tasks: Task[], marks: { todo: string[]; done: string[]; skip?: string[] }, now: number): Task[] {
  let out = tasks
  const add = (title: string, status: Status) => {
    const id = Math.max(0, ...out.map(t => t.id)) + 1
    out = [...out, { id, title, tier: 'sonnet', why: 'Found while working', parallel: false, status, tokens: 0, ...(status === 'done' ? { startedAt: now, endedAt: now } : {}) }]
  }
  for (const title of marks.todo) if (!out.some(t => sameTitle(t.title, title))) add(title, 'todo')
  for (const title of marks.done) {
    if (out.some(t => sameTitle(t.title, title))) out = out.map(t => (sameTitle(t.title, title) ? setCard(t, 'done', now) : t))
    else add(title, 'done')
  }
  for (const title of marks.skip ?? []) out = out.map(t => (sameTitle(t.title, title) && t.status !== 'done' ? setCard(t, 'skipped', now) : t))
  return out
}

// the main chat often forgets its Done:/Skip: lines, so a cheap model reads the answer and closes the cards it settles
export const JUDGE_SYSTEM = `You keep a task board true. You get the assistant's final answer and the open cards (one per line, "id: title").
Return ONLY one JSON object, no prose: {"done":number[],"skip":number[]}
- done: the answer says this card's work is finished (done, fixed, pushed, deployed, verified, answered).
- skip: the answer says this card's work was not done and is not being done now (blocked, denied, dropped, left to the person, not needed).
- Leave out any card the answer does not settle, or that work still running will settle. When unsure, leave it out.`

export const judgePrompt = (answer: string, cards: Task[]): string =>
  `Open cards:\n${cards.map(t => `${t.id}: ${t.title}`).join('\n')}\n\nFinal answer:\n${answer.slice(-6000)}`

/** The judge's reply as board marks (titles), keeping only ids of the cards it was asked about; a broken reply marks nothing. */
export function parseJudge(raw: string, cards: Task[]): { todo: string[]; done: string[]; skip: string[] } {
  const out = { todo: [] as string[], done: [] as string[], skip: [] as string[] }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  try {
    const data = JSON.parse(raw.slice(start, end + 1))
    const titles = (ids: unknown) => (Array.isArray(ids) ? cards.filter(c => ids.includes(c.id)).map(c => c.title) : [])
    out.done = titles(data?.done)
    out.skip = titles(data?.skip).filter(t => !out.done.includes(t))
  } catch {
    // not JSON: nothing is marked, the cards stay as they are
  }
  return out
}

/** The card status a TaskUpdate status means (`deleted` and unknown values change nothing). */
export const statusOfTask = (status: unknown): Status | undefined => TODO_STATUS[String(status)]

// ------------------------------------------------------------ carry on
// Contract: when a turn ends with open cards and nothing waits on the person, the deck sends the next message itself.
// Invariants: never past `max` sends for one typed request, never after two sends that closed no card, never in save
// mode, never while other work runs; a typed message starts the count over. Each turn's answer is kept in a notes
// file, and the run ends with one report written from it.
export const CONTINUE_SYSTEM = `You decide whether an AI coding agent that just stopped should keep going without its person. You get its final answer and the board's open cards (one per line, "id: title").
Return ONLY one JSON object, no prose: {"go":boolean,"why":string}
- go=true only when the open cards name work that is left, the next step is plain from the answer and the cards, and nothing in the answer waits on the person.
- go=false when the answer asks the person anything, offers a choice, waits for a yes, needs something only they can do or give (a login, a password, a screenshot, a device, a decision), or reports a blocker it could not get past.
- go=false when the next step would push, publish, release, send, delete, pay, or otherwise go live or be hard to undo, unless the person already asked for exactly that.
- go=false when the open cards are checks only the person can make, and whenever unsure.
- why: 8 words or fewer.`

/** The judge's reply; a broken or missing reply stops the run. */
export function parseContinue(raw: unknown): { go: boolean; why: string } {
  const text = String(raw ?? '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { go: false, why: 'no verdict' }
  try {
    const data = JSON.parse(text.slice(start, end + 1))
    return { go: data?.go === true, why: clip(String(data?.why ?? ''), 80) }
  } catch {
    return { go: false, why: 'no verdict' }
  }
}

/** Why the deck may not send the next message itself, or '' when it may ask the judge. */
export function continueBlock(a: { open: number; sent: number; max: number; stalled: number; isSaving: boolean; isBusy: boolean }): string {
  if (!a.open) return 'board empty'
  if (a.isBusy) return 'other work still running'
  if (a.sent >= a.max) return `${a.max} automatic steps reached`
  if (a.stalled >= 2) return 'two steps closed no card'
  if (a.isSaving) return 'usage limit near'
  return ''
}

export const continuePrompt = (open: string[], notes: string, n: number, max: number): string =>
  [
    `Command Deck (automatic step ${n} of ${max}): nothing in your last answer waits on the person, so carry on with the open cards:`,
    ...open.map(t => `- ${t}`),
    'Work through as many as you can in this turn. End with a "Done: <title>" line for each card finished and "Skip: <title>" for each dropped on purpose.',
    'Stop and ask before anything that pushes, publishes, releases, sends, deletes, pays or cannot be undone, and when only the person can answer.',
    `Your earlier answers in this run are kept in ${notes}; do not repeat them.`,
  ].join('\n')

export const wrapUpPrompt = (notes: string, why: string): string =>
  [
    `Command Deck: the run stopped (${why}). Write one final report for the whole run, not only the last step. The answer of each step is in ${notes}; read it if any is no longer in view.`,
    'Sections, in this order, each left out when empty: Done (what changed, with files). Checked (what was run and what it showed). Not checked. Needs you (every open question or decision, in full, and each thing only the person can do). Left (open cards and why).',
    'Do no new work in this turn.',
  ].join('\n')

/** One turn's answer as a section of the run's notes file. */
export const runNote = (n: number, at: string, closed: string[], answer: string): string =>
  `## Step ${n} (${at})${closed.length ? `\nClosed: ${closed.join('; ')}` : ''}\n\n${clip(answer.trim(), 6000)}\n\n`
