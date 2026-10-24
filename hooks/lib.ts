// Pure logic of Command Deck: no engine calls, so every function here is unit-testable.

import { finalPass, guidelineExtras, UNITY_RULES } from './guidelines'
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
{"isClear":boolean,"questions":string[],"prompt":string,"tasks":[{"title":string,"tier":"haiku"|"sonnet"|"opus","why":string,"parallel":boolean}]}
Rules:
- Default to isClear=true. Read "Recent conversation" and "Questions already asked and the answers" first: they are the person's own words and count as answers, even short ones like "yes", "both" or "all three" (they answer the question just before them). Never ask again anything already answered or implied there.
- isClear=false only when one missing fact would change the work (target file, behaviour, scope, platform) and no sensible default exists. Then give at most 2 short, concrete questions and leave tasks empty. When the request is clear enough, skip questions and state any assumption inside "prompt".
- Never ask what the project files, git history or the conversation can answer. A thing you cannot open (a web page behind a login) is not a question: plan around local files and config instead.
- Work is in the project folder named in the request (code, editor tooling, or a Claude mod); do not assume a web app, browser or database unless the request says so.
- prompt: the request rewritten for an AI coding agent: goal, constraints, files or areas, definition of done, how to verify. Caveman style: short blunt sentences, no filler or articles, but keep every file name, number and rule exact so the task is clear at a glance. Under 140 words.
- tasks: 1-8 small steps in execution order. Pick the cheapest tier that will still be right:
  haiku  = precise, mechanical, one place: rename, text change, config value, comment, log line, simple fix with the exact spot named.
  sonnet = normal feature or bug work: several files, some planning, tests, UI wiring.
  opus   = hard reasoning only: architecture, subtle bugs with unknown cause, concurrency, security, large refactors.
- "title": terse caveman-style wording, short plain words, no filler or articles, under 9 words (for example "Fix null check in HideBannerAds", not "Fix the null reference check that happens in the HideBannerAds method").
- "why" is 6 words or fewer.
- parallel=true only when the task edits different files from the tasks next to it and needs nothing they produce; those run at the same time. Split mechanical edits per file so they can run in parallel on Haiku.`

export function plannerPrompt(ask: string, answers: string[], questions: string[] = [], recent: string[] = []): string {
  const chat = recent.length ? `\n\nRecent conversation (oldest first):\n${recent.map(r => `- ${r}`).join('\n')}` : ''
  const qa = questions.length
    ? `\n\nQuestions already asked and the answers (the answers below were sent in order, each one after the questions):\n${questions.map((q, i) => `- Q${i + 1}: ${q}`).join('\n')}\n${answers.map(a => `- Answer: ${a}`).join('\n')}`
    : answers.length
      ? `\n\nAnswers already given:\n${answers.map(a => `- ${a}`).join('\n')}`
      : ''
  return `Request:\n${ask}${chat}${qa}`
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
  return { isClear, questions, prompt: String(data.prompt ?? '').trim(), tasks }
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

/** Greedy word wrap, so a drawn line never runs past the box it sits in. */
export function wrapWords(text: string, width: number): string[][] {
  const lines: string[][] = []
  let line: string[] = []
  let len = 0
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const add = (line.length ? 1 : 0) + w.length
    if (line.length && len + add > width) {
      lines.push(line)
      line = []
      len = 0
    }
    line.push(w)
    len += (line.length > 1 ? 1 : 0) + w.length
  }
  if (line.length) lines.push(line)
  return lines
}

// ---------------------------------------------------------------- usage and bars

export type ModelUsageLike = {
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
}

export type ModelBucket = 'Haiku' | 'Sonnet' | 'Opus' | 'Other'

export function modelBucket(model: string | undefined): ModelBucket {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return 'Haiku'
  if (m.includes('sonnet')) return 'Sonnet'
  if (m.includes('opus')) return 'Opus'
  return 'Other'
}

/** Tokens that were actually worked on: fresh input, cache writes and output (cache reads excluded). */
export function billed(u: ModelUsageLike): number {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

export function shares(map: Record<string, number>): { name: ModelBucket; pct: number; tokens: number }[] {
  const names: ModelBucket[] = ['Haiku', 'Sonnet', 'Opus', 'Other']
  const total = names.reduce((sum, n) => sum + (map[n] ?? 0), 0)
  return names
    .filter(n => n !== 'Other' || (map.Other ?? 0) > 0)
    .map(name => ({ name, tokens: map[name] ?? 0, pct: total ? ((map[name] ?? 0) / total) * 100 : 0 }))
}

export function bar(pct: number, width: number): { full: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const filled = Math.round((clamped / 100) * width)
  return { full: '█'.repeat(filled), empty: '░'.repeat(Math.max(0, width - filled)) }
}

export function barColor(pct: number): string {
  return pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green'
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const spinner = (frame: number): string => SPINNER[Math.abs(frame) % SPINNER.length] ?? '·'

// one single-cell animation per model tier so a glance tells who is working: Opus pulses, Sonnet spins, Haiku bounces
const PULSE = ['·', '•', '●', '•']
const BOUNCE = ['▁', '▃', '▅', '▇', '▅', '▃']
export function tierSpinner(tier: string, frame: number): string {
  const f = Math.abs(frame)
  if (tier === 'opus') return PULSE[f % PULSE.length] ?? '·'
  if (tier === 'haiku') return BOUNCE[f % BOUNCE.length] ?? '▁'
  return spinner(f)
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

// A tool counts as available when its MCP server is connected or it already saved something. With no server data yet
// we assume available, so a missing breakdown never shows a false "not available". Caveman is a skill with no install
// signal, so it reads as missing only when the chat loaded no skills at all and nothing was saved.
export const toolAvailable = (
  tool: 'graft' | 'optimizer' | 'caveman' | 'ponytail' | 'graphify',
  servers: { server: string }[] | undefined,
  skillTokens: number | undefined,
  saved: number,
  skills?: string[],
): boolean => {
  if (saved > 0) return true
  // Ponytail and Graphify are skills: installed only when the chat lists one (Graphify also ships an MCP server)
  if (tool === 'ponytail' || tool === 'graphify') return Boolean(skills?.includes(tool) || servers?.some(sv => norm(sv.server) === tool))
  if (tool === 'caveman') return skillTokens === undefined || skillTokens > 0
  if (!servers) return true
  const want = tool === 'graft' ? 'graft' : 'token_optimizer'
  return servers.some(sv => norm(sv.server) === want)
}

export type ToolState = 'active' | 'inactive' | 'missing'
/** Installed and running, installed but off, or not installed. `isOn` is the tool's own switch (Caveman's toggle). */
export function toolState(
  tool: 'graft' | 'optimizer' | 'caveman' | 'ponytail' | 'graphify',
  servers: { server: string }[] | undefined,
  skillTokens: number | undefined,
  saved: number,
  skills?: string[],
  isOn = true,
): ToolState {
  const listed = Boolean(skills?.includes(tool))
  // with the skill list known, Caveman is installed only when it is listed
  if (tool === 'caveman' && skills?.length && !listed && saved === 0) return 'missing'
  if (!listed && !toolAvailable(tool, servers, skillTokens, saved, skills)) return 'missing'
  if (!isOn) return 'inactive'
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

/** clean (default on) adds the step-specific engineering rules and the final pass; the always-on core rides in the system prompt. */
export function planContext(plan: Plan, opts: { clean?: boolean; unity?: boolean } = {}): string {
  const clean = opts.clean !== false
  const steps = plan.tasks.map(
    (t, i) => `${i + 1}. [${TIER_LABEL[t.tier]}${t.parallel ? ' ∥' : ''}] ${t.title}`,
  )
  return [
    'Command Deck plan for this message (the person did not type this; follow it unless it is wrong):',
    `Brief: ${plan.prompt}`,
    'Steps:',
    ...steps,
    'How to run it: Sonnet and Opus steps you do yourself. Every [Haiku] step MUST go to its own subagent with model "haiku", never done in this chat: give it only the step title, the exact file or spot to change and the done condition, no project history. Start all ∥ Haiku steps in one message so they run at once, but only if they edit different files; steps on the same file go one after another. Read-heavy searching goes to an Explore subagent. Long builds and test runs go in the background. After each subagent returns, check its edit by reading the changed spot or running the existing checks. Report which steps ran on Haiku, which ran in parallel, and any failure. Keep the board in sync: give each subagent a step title word for word as its description; for steps you do yourself, call TodoWrite (or TaskCreate/TaskUpdate) with these step titles word for word, and if you have none of those tools, end the reply with a line `Done: <step title>` for each step verified done.',
    ...(opts.unity ? [UNITY_RULES] : []),
    ...(clean ? [guidelineExtras(plan)].filter(Boolean) : []),
    ...(clean && plan.tasks.length > 1 ? [finalPass(plan)] : []),
  ].join('\n')
}

export const HOUSE_SECTION = `Command Deck is active. Keep the main context small: send read-heavy exploration to an Explore subagent (it runs on Haiku), give precise mechanical edits to Haiku subagents (several at once when they touch different files), run long builds, tests and checks in the background, and keep replies short. Keep the board true: every subagent becomes a card named by its description, so give each a clear one. New work you plan and work you finish yourself goes on the board through TodoWrite or TaskCreate/TaskUpdate; if you have none of those tools, end the reply with a line "Todo: <title>" for each new task and "Done: <title>" for each task verified done.`

// ---------------------------------------------------------------- caveman

export const CAVEMAN_SECTION = `Caveman mode is ON: the person switched it on with the Command Deck toggle. Before your first reply, load the caveman:caveman skill with the Skill tool if it is not loaded yet, then follow it for every reply until the person turns it off. Short, blunt sentences in every reply, including the first. If that skill is not installed: short sentences, small words, no filler, code and names unchanged.`

// ---------------------------------------------------------------- files

export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
export const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, '')

const box = (s: Status): string => (s === 'done' ? '[x]' : s === 'failed' ? '[!]' : s === 'doing' ? '[~]' : '[ ]')

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

export function handoffMarkdown(args: {
  goal: string
  tasks: Task[]
  rules: string
  git: GitInfo | null
  date: string
  contextPct?: number
  summary?: string
}): string {
  const g = args.git
  return [
    `# Handoff ${args.date}`,
    '',
    'Start of the new chat: read this file, then continue with the first open task. Do not re-read old work unless a task needs it.',
    '',
    '## Goal',
    args.goal || '(none set)',
    '',
    ...(args.summary ? ['## Where things stand', args.summary.trim(), ''] : []),
    '## Rules',
    args.rules.trim(),
    '',
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
    ...(args.tasks.filter(t => t.status !== 'done').map(t => `- ${t.title}`) || []),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- tips

export const HANDOFF_ASK = `Write a handoff note for a fresh chat that continues this work. Plain markdown bullets, under 250 words: what was being built and why, decisions made, what is finished, what is half done (file:line where useful), known problems, and the very next step. Facts only; no greetings.`

/** The handoff prompt anchored on the current goal and the unfinished board cards, so the note describes this goal
 * (not an older topic from earlier in the chat) and what was mid-way when the chat ended. */
export function handoffAsk(goal: string, tasks: Pick<Task, 'title' | 'status'>[]): string {
  const open = tasks.filter(t => t.status !== 'done').map(t => `- ${t.title} (${t.status})`)
  return [
    HANDOFF_ASK,
    goal ? `Current goal: ${goal}` : '',
    open.length ? `Unfinished board tasks. Say which of these this chat really finished and checked, and which was mid-way:\n${open.join('\n')}` : '',
    'Lead with where THIS goal stands and the exact next action.',
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

export type Segment = { name: string; tokens: number; pct: number; cells: number; color: string }

// one coloured run per used category, each at least one cell wide, never wider than the bar
export function ctxSegments(parts: CtxPart[], window: number, width: number): Segment[] {
  const used = parts.filter(p => p.kind === 'used' && p.tokens > 0)
  if (!window || !used.length) return []
  const out = used.map((p, i) => ({
    name: p.name,
    tokens: p.tokens,
    pct: (p.tokens / window) * 100,
    cells: Math.max(1, Math.round((p.tokens / window) * width)),
    color: CTX_COLORS[i % CTX_COLORS.length] ?? 'white',
  }))
  let over = out.reduce((n, x) => n + x.cells, 0) - width
  for (let i = out.length - 1; over > 0 && i >= 0; i--) {
    const seg = out[i]
    if (seg && seg.cells > 1) {
      const cut = Math.min(over, seg.cells - 1)
      seg.cells -= cut
      over -= cut
    }
  }
  return out
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

export const serverOfTool = (tool: string): string | null => /^mcp__(.+?)__/.exec(tool)?.[1] ?? null

// what Handoff+/Clean does after the handoff is written: with Auto Clean on (the default) it clears the chat,
// otherwise it only compacts
export type CleanStep = 'clean' | 'compact'
export const cleanStep = (autoClean: boolean): CleanStep => (autoClean ? 'clean' : 'compact')

export const SMOKE_TITLE = 'Smoke test run: confirm the whole change works'
// every plan ends with a smoke test run, so the board is not done until the work is checked
export function withSmokeTask<T extends { title: string; tier: 'haiku' | 'sonnet' | 'opus'; why: string; parallel: boolean }>(tasks: T[]): (T | { title: string; tier: 'haiku'; why: string; parallel: boolean })[] {
  if (tasks.some(t => /smoke/i.test(t.title))) return tasks
  return [...tasks, { title: SMOKE_TITLE, tier: 'haiku', why: 'Run the project smoke test and report the result', parallel: false }]
}

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
  return { ...rest, status: to, startedAt: startedAt ?? now, ...(to === 'done' ? { endedAt: now } : {}) }
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
  const named = tasks.find(t => t.status !== 'done' && t.status !== 'failed' && hints.some(h => sameTitle(t.title, h)))
  if (named) return { id: named.id, tasks: tasks.map(t => (t.id === named.id ? setCard(t, 'doing', now) : t)) }
  const title = hints.map(h => h.replace(/\s+/g, ' ').trim()).find(Boolean)?.slice(0, 80) || 'Subagent'
  const id = Math.max(0, ...tasks.map(t => t.id)) + 1
  return { id, tasks: [...tasks, { id, title, tier, why: 'Subagent', parallel: false, status: 'doing', tokens: 0, startedAt: now }] }
}

/** `Todo: <title>` and `Done: <title>` lines in a reply, the board marks for a chat that has no task tools. */
export function boardMarks(answer: unknown): { todo: string[]; done: string[] } {
  const out = { todo: [] as string[], done: [] as string[] }
  for (const line of String(answer ?? '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?`?(todo|done):\s*(.+?)`?\s*$/i.exec(line)
    if (m) out[m[1]!.toLowerCase() as 'todo' | 'done'].push(m[2]!.trim())
  }
  return out
}

/** Applies reply marks: a Todo title not on the board is added, a Done title closes its card (or is added as done). */
export function applyMarks(tasks: Task[], marks: { todo: string[]; done: string[] }, now: number): Task[] {
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
  return out
}

/** The card status a TaskUpdate status means (`deleted` and unknown values change nothing). */
export const statusOfTask = (status: unknown): Status | undefined => TODO_STATUS[String(status)]
