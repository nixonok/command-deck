import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import * as L from './lib'
import * as G from './guidelines'
import type { CtxPart, CtxServer, Draft, GitInfo, Hist, Learn, Limits, Pending, Plan, Savings, Task } from '../types'

const PANE = 'command-deck'
// absolute once load() has run: a relative path would follow the shell's working directory and scatter .claude folders through the project
let DIR = '.claude/deck'

const tasksA = atom({ plugin: 'command-deck', key: 'tasks' } as const, [] as Task[])
const goalA = atom({ plugin: 'command-deck', key: 'goal' } as const, '')
const pendingA = atom({ plugin: 'command-deck', key: 'pending' } as const, null as Pending | null)
const usageA = atom({ plugin: 'command-deck', key: 'usage' } as const, {} as Record<string, number>)
const savingsA = atom({ plugin: 'command-deck', key: 'savings' } as const, L.ZERO_SAVINGS)
const caveA = atom({ plugin: 'command-deck', key: 'cave' } as const, true)
const gitA = atom({ plugin: 'command-deck', key: 'git' } as const, null as GitInfo | null)
// RTK runs outside the chat, so its state and today's savings come from its own CLI; null until first checked
const rtkA = atom({ plugin: 'command-deck', key: 'rtk' } as const, null as { state: L.ToolState; saved: number } | null)
const limitsA = atom({ plugin: 'command-deck', key: 'limits' } as const, { ctxWindow: 0, ctxPct: 0 } as Limits)
const frameA = atom({ plugin: 'command-deck', key: 'frame' } as const, 0)
const tipA = atom({ plugin: 'command-deck', key: 'tip' } as const, 0)
const autoA = atom({ plugin: 'command-deck', key: 'auto' } as const, true)
const cleanA = atom({ plugin: 'command-deck', key: 'clean' } as const, true)
// Auto Clean is on by default: off means Handoff+/Clean only compacts; the choice is stored and survives restarts
const autoCleanA = atom({ plugin: 'command-deck', key: 'autoClean' } as const, true)
// a clean waiting for the person's yes or skip; the handoff is already written when this is set
type CleanAsk = { path: string; first: string; carry?: string; shed: number }
const learnA = atom({ plugin: 'command-deck', key: 'learn' } as const, null as Learn | null)
const draftA = atom({ plugin: 'command-deck', key: 'draft' } as const, {} as Record<string, Draft>)
const answeredA = atom({ plugin: 'command-deck', key: 'answered' } as const, false)
const histA = atom({ plugin: 'command-deck', key: 'history' } as const, [] as Hist[])
const orderA = atom({ plugin: 'command-deck', key: 'order' } as const, null as string[] | null)
// Git and History start minimized; the person can open them and the choice is kept
const minA = atom({ plugin: 'command-deck', key: 'min' } as const, { GIT: true, HISTORY: true } as Record<string, boolean>)
// History shows the newest 15 entries; true shows every stored entry
const LEARN = 'command-deck-learn'
const CHOICES = ['Yes', 'No', 'Not sure']
let fromPanel = false

type Done = { answer: string; tokens: number }

let isRunning = false
let isNudged = false
let isCompacting = false
// prompt cache: estimated from the clock (the server is never asked), see lib.ts coldCheck
let lastTouch = 0
let lastReal = 0
// smart tool deferral: servers whose tools sit behind ToolSearch for this chat (reversible with /command-deck tools off)
let deferServers = new Set<string>()
const usedServers = new Set<string>()
let toolsOn = true
let warmUntil = 0
let isPinging = false
let isTurnLive = false
let coldWarned = false
let spin: { cancel: () => void } | null = null
const completions = new Map<string, Done>()
const waiters = new Map<string, (d: Done) => void>()
let cfg: Record<string, unknown> = {}

function opt(name: string, fallback: number): number {
  const v = Number(cfg[name])
  return Number.isFinite(v) ? v : fallback
}

// ------------------------------------------------------------ persistence
// finished tasks are copied into a log that survives /clear, a new plan and /command-deck clear
async function archive($: any) {
  try {
    const now = await $.clock.now()
    const done = (await read($, tasksA)).filter(t => t.status === 'done' || t.status === 'failed')
    if (!done.length) return
    const have = await read($, histA)
    const seen = new Set(have.map(h => `${h.at}|${h.title}`))
    const add = done
      .map(t => ({ at: t.endedAt ?? t.startedAt ?? now, title: t.title, tier: t.tier, status: t.status as string, tokens: t.tokens }))
      .filter(h => !seen.has(`${h.at}|${h.title}`))
    if (!add.length) return
    const next = [...have, ...add].slice(-200)
    await update($, histA, () => next)
    await $.store.set('deck.history', next)
    await appendHistoryFile($, add)
  } catch {
    /* history is a convenience */
  }
}

// the full history (the store keeps only the latest 200) is appended to a file so it can be opened as a whole
const histFile = () => `${DIR}/history.md`
async function appendHistoryFile($: any, items: { at: number; title: string; tier: string; status: string }[]) {
  try {
    const prev = (await $.fs.exists(histFile())) ? String(await $.fs.read(histFile())) : '# Command Deck history\n\n'
    const lines = items.map(h => `- ${new Date(h.at).toISOString().slice(0, 16).replace('T', ' ')} [${h.tier}] ${h.status}: ${h.title}`)
    await $.fs.write(histFile(), `${prev.endsWith('\n') ? prev : `${prev}\n`}${lines.join('\n')}\n`)
  } catch {
    /* history is a convenience */
  }
}

async function openHistoryFolder($: any) {
  try {
    if (!(await $.fs.exists(histFile()))) await $.fs.write(histFile(), '# Command Deck history\n')
    const dir = DIR
    // macOS, Linux, then Windows: the first opener that exits cleanly wins
    let ok = false
    for (const opener of ['open', 'xdg-open', 'explorer']) {
      const r = await $.process.run([opener, dir]).catch(() => null)
      if (r && (r.exitCode === 0 || opener === 'explorer')) {
        ok = true
        break
      }
    }
    if (!ok) throw new Error('no folder opener found')
    $.ui.toast('Opened the history folder')
  } catch (err) {
    $.ui.toast(`Could not open the folder: ${String((err as Error)?.message ?? err)}`)
  }
}

async function save($: any) {
  await archive($)
  try {
    await $.store.set('deck.tasks', await read($, tasksA))
    await $.store.set('deck.goal', await read($, goalA))
    await $.store.set('deck.pending', await read($, pendingA))
    await $.store.set(await savingsKey($), await read($, savingsA))
    await $.store.set('deck.cave', await read($, caveA))
    await $.store.set('deck.clean', await read($, cleanA))
    await $.store.set('deck.autoClean', await read($, autoCleanA))
  } catch {
    /* the store is a convenience; the dated files are the record */
  }
}

const DEFAULT_ORDER = ['BOARD', 'BRIEF', 'USAGE', 'MODELS', 'SAVED', 'GIT', 'TIPS', 'HISTORY']

// the saved order, healed: unknown ids dropped, new ids appended, so an old layout never hides a section
function fullOrder(saved: string[] | null): string[] {
  const kept = (saved ?? []).filter(id => DEFAULT_ORDER.includes(id))
  return [...kept, ...DEFAULT_ORDER.filter(id => !kept.includes(id))]
}

// savings are kept per day, so the section shows today only; a new day starts from zero
let savingsDay = ''
async function savingsKey($: any) {
  savingsDay = L.dayKey(await $.clock.now())
  return `deck.savings.${savingsDay}`
}

async function todayKey($: any) {
  return `deck.usage.${L.dayKey(await $.clock.now())}`
}

async function load($: any) {
  try {
    DIR = `${String(await $.session.root()).replace(/\/$/, '')}/.claude/deck`
  } catch {
    /* keep the relative default */
  }
  const tasks = ((await $.store.get('deck.tasks')) as Task[] | undefined) ?? []
  const goal = ((await $.store.get('deck.goal')) as string | undefined) ?? ''
  // questions are never carried into a new session: they would cling to the pane and ask what was answered
  const pending = null as Pending | null
  await $.store.set('deck.pending', null).catch(() => undefined)
  const savings = { ...L.ZERO_SAVINGS, ...((await $.store.get(await savingsKey($))) as Partial<Savings> | undefined) }
  const caveStored = await $.store.get('deck.cave')
  const cave = caveStored === undefined ? true : Boolean(caveStored)
  const cleanStored = await $.store.get('deck.clean')
  const clean = cleanStored === undefined ? true : Boolean(cleanStored)
  const autoCleanStored = await $.store.get('deck.autoClean')
  const autoClean = autoCleanStored === undefined ? true : Boolean(autoCleanStored)
  const autoStored = await $.store.get('deck.auto')
  const auto = autoStored === undefined ? true : Boolean(autoStored)
  const usage = ((await $.store.get(await todayKey($))) as Record<string, number> | undefined) ?? {}
  const order = ((await $.store.get('deck.order')) as string[] | null | undefined) ?? null
  await update($, orderA, () => order)
  const hist = ((await $.store.get('deck.history')) as Hist[] | undefined) ?? []
  await update($, histA, () => hist)
  // a task that was running when the session ended goes back to the queue
  await update($, tasksA, () => tasks.map(t => (t.status === 'doing' ? { ...t, status: 'todo' as const } : t)))
  await update($, goalA, () => goal)
  await update($, pendingA, () => pending)
  await update($, savingsA, () => savings)
  await update($, caveA, () => cave)
  await update($, autoA, () => auto)
  await update($, cleanA, () => clean)
  await update($, autoCleanA, () => autoClean)
  await update($, usageA, () => usage)
}

// ------------------------------------------------------------ data refresh
async function refreshGit($: any) {
  try {
    const status = await $.process.run(['git', 'status', '--porcelain=v1', '-b'])
    if (status.exitCode !== 0) return
    const refs = await $.process.run([
      'git',
      'for-each-ref',
      '--format=%(refname:short)|%(upstream:short)|%(upstream:track)',
      'refs/heads',
    ])
    const lines = String(status.stdout)
    const first = lines.split('\n').find(l => l.startsWith('##')) ?? ''
    await update($, gitA, () => L.parseGit(first, lines, String(refs.stdout)))
  } catch {
    /* not a repo, or git is missing */
  }
}

async function refreshRtk($: any, checkHook = false) {
  try {
    const gain = await $.process.run(['rtk', 'gain', '-d', '-f', 'json'])
    if (gain.exitCode !== 0) throw new Error('rtk gain failed')
    const d = new Date(await $.clock.now())
    // RTK keys its days by local date
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const prev = await read($, rtkA)
    let state: L.ToolState = prev?.state ?? 'active'
    if (checkHook || !prev) state = L.rtkHooked((await $.process.run(['rtk', 'verify'])).stdout) ? 'active' : 'inactive'
    await update($, rtkA, () => ({ state, saved: L.rtkSaved(gain.stdout, day) }))
  } catch {
    await update($, rtkA, () => ({ state: 'missing' as const, saved: 0 }))
  }
}

async function applyUsage($: any, u: any) {
  const five = u.rateLimits?.find((r: any) => r.kind === 'five_hour')
  const week = u.rateLimits?.find((r: any) => r.kind === 'seven_day')
  const ctx = u.context ?? { window: 0 }
  const bd = ctx.breakdown
  const prev = await read($, limitsA)
  let parts: CtxPart[] | undefined = prev.parts
  let servers: CtxServer[] | undefined = prev.servers
  let skillTokens: number | undefined = prev.skillTokens
  let skills: string[] | undefined = prev.skills
  if (bd) {
    parts = (bd.categories ?? []).map((c: any) => ({ name: String(c.name), tokens: Number(c.tokens) || 0, kind: c.kind }))
    const by = new Map<string, CtxServer>()
    for (const t of bd.mcpTools ?? []) {
      const row = by.get(t.serverName) ?? { server: String(t.serverName), tokens: 0, loaded: 0 }
      row.tokens += t.tokens
      if (t.isLoaded) row.loaded += t.tokens
      by.set(t.serverName, row)
    }
    servers = [...by.values()].sort((a, b) => b.tokens - a.tokens)
    skillTokens = bd.skills?.tokens
    skills = L.skillNames(bd.skills?.skillFrontmatter)
  }
  await update($, limitsA, () => ({
    parts,
    servers,
    skillTokens,
    skills,
    fiveHour: five ? { pct: five.percentUsed, resetsAt: five.resetsAt } : undefined,
    sevenDay: week ? { pct: week.percentUsed, resetsAt: week.resetsAt } : undefined,
    ctxTokens: ctx.tokens,
    ctxWindow: ctx.window ?? 0,
    ctxPct: ctx.percent ?? (ctx.tokens && ctx.window ? (ctx.tokens / ctx.window) * 100 : 0),
    usd: u.cost?.usd,
  }))
}

async function refreshUsage($: any) {
  try {
    await applyUsage($, await $.session.usage({ breakdown: 'summary' }))
  } catch {
    /* no reading yet */
  }
}

async function addUsage($: any, model: string | undefined, usage: L.ModelUsageLike | undefined) {
  if (!usage) return
  const tokens = L.billed(usage)
  if (!tokens) return
  const bucket = L.modelBucket(usage.model ?? model)
  const next = await update($, usageA, (m: Record<string, number>) => ({ ...m, [bucket]: (m[bucket] ?? 0) + tokens }))
  try {
    await $.store.set(await todayKey($), next)
  } catch {
    /* ignore */
  }
}

async function addSaving(key: keyof Savings, n: number, $: any) {
  if (!(n > 0)) return
  const day = L.dayKey(await $.clock.now())
  const rolled = Boolean(savingsDay) && day !== savingsDay
  await update($, savingsA, (s: Savings) => ({ ...(rolled ? L.ZERO_SAVINGS : s), [key]: (rolled ? 0 : s[key]) + n }))
  try {
    await $.store.set(await savingsKey($), await read($, savingsA))
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------ files
async function writeProgress($: any) {
  const now = await $.clock.now()
  const date = L.dayKey(now)
  await $.fs.write(
    `${DIR}/progress-${date}.md`,
    L.progressMarkdown(await read($, goalA), await read($, tasksA), date),
  )
}

async function rulesText($: any): Promise<string> {
  const path = `${DIR}/rules.md`
  try {
    if (await $.fs.exists(path)) return String(await $.fs.read(path))
    await $.fs.write(path, L.DEFAULT_RULES)
  } catch {
    /* fall through to the default */
  }
  return L.DEFAULT_RULES
}

// ------------------------------------------------------------ spinner
function startSpin($: any) {
  // reduced motion: the bots hold still, so no frame timer runs at all
  if (spin || opt('reducedMotion', 0) > 0) return
  spin = $.clock.every(350, () => void update($, frameA, (n: number) => n + 1))
}
function stopSpin() {
  spin?.cancel()
  spin = null
}

// ------------------------------------------------------------ planning
async function projectName($: any): Promise<string> {
  try {
    const root = String(await $.session.root())
    return root.split('/').filter(Boolean).pop() ?? root
  } catch {
    return 'unknown'
  }
}

async function analyze($: any, ask: string, answers: string[], questions: string[] = []): Promise<Plan | null> {
  for (const model of ['haiku', 'sonnet']) {
    const r = await $.model.complete({
      model,
      system: L.PLANNER_SYSTEM,
      prompt: L.plannerPrompt(ask, answers, questions, recent),
      maxTokens: 1500,
      effort: model === 'haiku' ? 'medium' : 'low',
      timeoutMs: 60000,
    })
    if (r.isAnswered) {
      await addUsage($, model, { ...r.usage, model })
      const plan = L.parsePlan(r.text)
      if (plan) return plan
    }
  }
  return null
}

const planText = (plan: Plan, tasks: Task[]): string =>
  [
    'Prompt ready:',
    plan.prompt,
    '',
    'Tasks:',
    ...tasks.map(t => `  ${t.id}. [${L.TIER_LABEL[t.tier]}]${t.parallel ? ' ∥' : ''} ${t.title}${t.why ? ` — ${t.why}` : ''}`),
    '',
    '∥ = runs in parallel with its neighbours. Run them with /command-deck run. Board: /command-deck.',
  ].join('\n')

async function runPlan($: any, ask: string, answers: string[]): Promise<string> {
  const plan = await analyze($, ask, answers)
  if (!plan) return 'Could not build a plan from that. Say it again with the file or feature named.'
  if (!plan.isClear) {
    await update($, answeredA, () => false)
    await update($, pendingA, () => ({ ask, answers, questions: plan.questions }))
    await save($)
    return ['A few questions first (answer with /command-deck-plan <your answers>):', ...plan.questions.map((q, i) => `  ${i + 1}. ${q}`)].join('\n')
  }
  const tasks: Task[] = L.withSmokeTask(plan.tasks).map((t, i) => ({ id: i + 1, title: t.title, tier: t.tier, why: t.why, parallel: t.parallel, status: 'todo', tokens: 0 }))
  await archive($)
  await update($, tasksA, () => tasks)
  await update($, goalA, () => plan.prompt)
  await update($, pendingA, () => null)
  await save($)
  await writeProgress($)
  return planText(plan, tasks)
}

// ------------------------------------------------------------ running tasks
async function waitFor($: any, id: string): Promise<Done> {
  const early = completions.get(id)
  if (early) return early
  return Promise.race([
    new Promise<Done>(resolve => waiters.set(id, resolve)),
    $.clock.sleep(20 * 60_000).then(() => ({ answer: 'timed out after 20 minutes', tokens: 0 })),
  ])
}

async function runOne($: any, task: Task, done: Task[], goal: string): Promise<boolean> {
  let result: Done = { answer: '', tokens: 0 }
  let ok = true
  try {
    const spawned = await $.agent.spawn({
      prompt: L.taskPrompt(goal, task, done),
      description: task.title.slice(0, 40),
      model: L.TIER_MODEL[task.tier],
    })
    if (spawned.deny || !spawned.agentId) {
      ok = false
      result = { answer: spawned.deny ?? 'no agent started', tokens: 0 }
    } else {
      result = await waitFor($, spawned.agentId)
    }
  } catch (err) {
    ok = false
    result = { answer: String((err as Error)?.message ?? err), tokens: 0 }
  }
  const end = await $.clock.now()
  const note = result.answer.split('\n').filter(Boolean).slice(0, 1).join(' ').slice(0, 120)
  await update($, tasksA, (l: Task[]) =>
    l.map(t => (t.id === task.id ? { ...t, status: ok ? ('done' as const) : ('failed' as const), tokens: result.tokens, endedAt: end, note } : t)),
  )
  await save($)
  await writeProgress($)
  return ok
}

// Runs the board in waves: consecutive tasks the planner marked parallel go out together (up to 4 subagents at
// once, usually Haiku edits to separate files); everything else runs one at a time, in order.
async function runAll($: any) {
  if (isRunning) return
  isRunning = true
  startSpin($)
  try {
    for (;;) {
      const all = await read($, tasksA)
      const wave = L.nextWave(all)
      if (!wave.length) break
      const now = await $.clock.now()
      const ids = new Set(wave.map(t => t.id))
      await update($, tasksA, (l: Task[]) => l.map(t => (ids.has(t.id) ? { ...t, status: 'doing' as const, startedAt: now } : t)))
      const done = all.filter(t => t.status === 'done')
      const goal = await read($, goalA)
      const results = await Promise.all(wave.map(t => runOne($, t, done, goal)))
      if (results.some(ok => !ok)) break
    }
    await finish($)
  } finally {
    isRunning = false
    stopSpin()
  }
}

async function finish($: any) {
  const now = await $.clock.now()
  const date = L.dayKey(now)
  const limits = await read($, limitsA)
  const body = L.finalLogMarkdown(
    await read($, goalA),
    await read($, tasksA),
    await read($, usageA),
    await read($, savingsA),
    limits.usd,
    date,
  )
  const path = `${DIR}/log-${date}.md`
  let before = ''
  try {
    if (await $.fs.exists(path)) before = `${await $.fs.read(path)}\n---\n\n`
  } catch {
    /* new file */
  }
  await $.fs.write(path, before + body)
  const tasks = await read($, tasksA)
  const failed = tasks.filter(t => t.status === 'failed').length
  $.ui.toast(failed ? `Deck stopped: ${failed} task failed. Log in ${path}` : `Deck finished ${tasks.length} tasks. Log in ${path}`)
}

// ------------------------------------------------------------ handoff
async function handoff($: any): Promise<string> {
  await refreshGit($)
  const now = await $.clock.now()
  const path = `${DIR}/handoff-${L.stamp(now)}.md`
  const limits = await read($, limitsA)
  // the summary comes from a fork of this very conversation: the prefix is already cached, so it is cheap
  let summary = ''
  try {
    const r = await $.model.fork({ prompt: L.handoffAsk(await read($, goalA), await read($, tasksA)) })
    if (r.isAnswered) summary = r.text
  } catch {
    /* the note still carries the goal, rules, board and repo state */
  }
  await $.fs.write(
    path,
    L.handoffMarkdown({
      summary,
      goal: await read($, goalA),
      tasks: await read($, tasksA),
      rules: await rulesText($),
      git: await read($, gitA),
      date: L.dayKey(now),
      contextPct: limits.ctxPct,
    }),
  )
  await writeProgress($)
  return `Handoff written to ${path}.\nIn a new chat, send:\n  Read ${path} and continue with the first open task.`
}


// ------------------------------------------------------------ smart tool deferral
// Once per chat, on its first prompt (the cache is cold then anyway, so no cached prefix is lost), the better
// prompt step asks Haiku which connected MCP servers the work could use. The rest are moved behind ToolSearch with
// tool.describe: still reachable on demand, so nothing the prompt needs is ever taken away. A server named in the
// prompt, or already called, is never deferred.
async function decideTools($: any, text: string) {
  if (!toolsOn || opt('smartTools', 1) <= 0) return
  const turns = await $.session.turns().catch(() => 1)
  if (turns > 0) return
  const u = await $.session.usage({ breakdown: 'summary' })
  const by = new Map<string, { server: string; tokens: number; names: string[] }>()
  for (const t of u?.context?.breakdown?.mcpTools ?? []) {
    if (!t.isLoaded) continue
    const row = by.get(t.serverName) ?? { server: String(t.serverName), tokens: 0, names: [] }
    row.tokens += t.tokens
    row.names.push(String(t.name).replace(/^mcp__.+?__/, ''))
    by.set(t.serverName, row)
  }
  const servers = [...by.values()]
  if (!servers.length) return
  const r = await $.model.complete({ model: 'haiku', system: L.TOOLS_SYSTEM, prompt: L.toolsPrompt(text, servers), maxTokens: 300, effort: 'low', timeoutMs: 20000 })
  if (!r.isAnswered) return
  await addUsage($, 'haiku', { ...r.usage, model: 'haiku' })
  const need = L.parseNeed(r.text)
  if (!need) return
  const needed = new Set(need.map(L.norm))
  const lower = text.toLowerCase()
  const off = servers.filter(
    sv => !needed.has(L.norm(sv.server)) && !usedServers.has(L.norm(sv.server)) && !lower.includes(sv.server.toLowerCase()) && !lower.includes(L.norm(sv.server).replace(/_/g, ' ')),
  )
  if (!off.length) return
  deferServers = new Set(off.map(sv => L.norm(sv.server)))
  const tokens = off.reduce((n, sv) => n + sv.tokens, 0)
  await addSaving('tools', tokens, $)
  $.ui.toast(`Smart tools: ${off.length} MCP server${off.length === 1 ? '' : 's'} moved behind search (about ${L.compact(tokens)} tokens). /command-deck tools off undoes it.`)
}

// ------------------------------------------------------------ keep warm
// One tool-less fork over the transcript after N idle minutes resets the cache countdown for the price of a read.
async function armWarm($: any, hours: number, why: string) {
  const now = await $.clock.now()
  const until = now + hours * 3_600_000
  if (until <= warmUntil) return
  warmUntil = until
  $.ui.status('keep-warm on')
  $.ui.toast(`Keep-warm on for ${hours}h (${why}).`)
}

function stopWarm($: any, why: string) {
  if (!warmUntil) return
  warmUntil = 0
  $.ui.status(undefined)
  $.ui.toast(`Keep-warm off: ${why}`)
}

async function warmTick($: any) {
  if (!warmUntil || isPinging || isTurnLive || isRunning || isCompacting) return
  const now = await $.clock.now()
  if (now >= warmUntil) return stopWarm($, 'window ended')
  const every = opt('warmPingMin', 50) * 60_000
  if (!lastTouch || now - lastTouch < every) return
  if (now - lastTouch >= opt('cacheTtlMin', 60) * 60_000) return // already cold: the next turn re-warms it
  isPinging = true
  try {
    const r = await $.model.fork({ prompt: L.WARM_PING })
    lastTouch = await $.clock.now()
    if (!r.isAnswered || L.warmVerdict(r.usage) === 'stop') stopWarm($, 'a ping did not read the cache')
  } catch {
    stopWarm($, 'a ping failed')
  } finally {
    isPinging = false
  }
}

// Caveman is the installed caveman:caveman skill: it switches on when the person says "caveman mode" and off on
// "stop caveman". The toggle says those words for the person (a hidden user row, no extra turn), and while on the
// system prompt keeps a reminder so the mode survives compaction and long chats.
async function setCave($: any, value?: boolean): Promise<boolean> {
  const now = value ?? !(await read($, caveA))
  await update($, caveA, () => now)
  await save($)
  const text = now
    ? 'caveman mode (turned on from the Command Deck toggle: use the caveman:caveman skill for every reply until I turn it off)'
    : 'stop caveman. talk normal. (turned off from the Command Deck toggle)'
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {
    /* the system prompt reminder still carries the mode */
  }
  $.ui.toast(now ? 'Caveman ON (caveman:caveman skill)' : 'Caveman off')
  return now
}

// A new chat that already knows where things stand: write the handoff, clear the conversation, and send the
// first prompt of the fresh chat for the person.
async function fresh($: any, carry?: string): Promise<string> {
  $.ui.toast('Writing the handoff…')
  const shed = (await read($, limitsA)).ctxTokens ?? 0
  const note = await handoff($)
  const path = /Handoff written to (\S+)\./.exec(note)?.[1] ?? `${DIR}/`
  const first = carry
    ? `Read ${path} for context from the previous chat. Then do this:\n\n${carry}`
    : `Read ${path} and continue with the first open task.`
  // the handoff holds the findings of this chat; list it in the history so it can be found later
  await addHistory($, `Handoff saved: ${path}`, shed)
  const ask: CleanAsk = { path, first, carry, shed }
  // Auto Clean off: never clear, only compact. On: clear straight away, no question.
  return L.cleanStep(await read($, autoCleanA)) === 'compact' ? runCompact($, ask) : runClean($, ask)
}

async function addHistory($: any, title: string, tokens: number) {
  try {
    const now = await $.clock.now()
    const entry = { at: now, title, tier: 'sonnet' as const, status: 'handoff', tokens }
    const next = [...(await read($, histA)), entry].slice(-200)
    await update($, histA, () => next)
    await $.store.set('deck.history', next)
    await appendHistoryFile($, [entry])
  } catch {
    /* history is a convenience */
  }
}

async function runCompact($: any, ask: CleanAsk): Promise<string> {
  try {
    await $.session.compact({ instructions: `Keep: the goal, the open tasks and any decision already made. Handoff: ${ask.path}` })
    if (ask.carry) await $.prompt.submit({ text: ask.carry })
    return `Handoff written to ${ask.path}. Chat compacted.`
  } catch (err) {
    return `Handoff written to ${ask.path}, but compact failed (${String((err as Error)?.message ?? err)}).`
  }
}

async function runClean($: any, ask: CleanAsk): Promise<string> {
  try {
    await $.command.run({ command: 'clear', args: '' })
    await addSaving('fresh', ask.shed, $)
    deferServers = new Set()
    usedServers.clear()
    await $.prompt.submit({ text: ask.first })
    return `Fresh chat started from ${ask.path}.`
  } catch (err) {
    await $.prompt.fill({ text: ask.first, mode: 'replace' }).catch(() => undefined)
    return `Handoff written to ${ask.path}, but the chat could not be cleared for you (${String((err as Error)?.message ?? err)}). Run /clear, then send what is in the prompt box.`
  }
}

let isAutoBoard = false
// Every subagent has its own card (the one its description names, else a new one), Doing while it runs and done when
// it returns. The main agent's first tool call guesses a card into Doing only for that turn. Only proof closes a main
// card: the model's own task list, or a `Done:` line in its reply. So Doing means work is live right now.
const agentTask = new Map<string, number>()
let mainTask: number | null = null
// the model's own task ids (TaskCreate / TaskUpdate) and the card title each one stands for
const modelTasks = new Map<string, string>()

const tierOf = (model?: string): Task['tier'] | null => {
  const m = String(model ?? '').toLowerCase()
  return m.includes('haiku') ? 'haiku' : m.includes('sonnet') ? 'sonnet' : m.includes('opus') ? 'opus' : null
}

async function beginTask($: any, tier: Task['tier'] | null, hints: string[] = []): Promise<{ id: number; matched: boolean } | null> {
  let picked: { id: number; matched: boolean } | null = null
  const now = await $.clock.now()
  await update($, tasksA, (l: Task[]) => {
    const p = L.pickCard(l, tier, hints)
    if (!p) return l
    picked = p
    return l.map(x => (x.id === p.id ? { ...x, status: 'doing' as const, startedAt: now } : x))
  })
  return picked
}

async function endTask($: any, id: number) {
  const now = await $.clock.now()
  await update($, tasksA, (l: Task[]) => l.map(t => (t.id === id && t.status === 'doing' ? { ...t, status: 'done' as const, endedAt: now } : t)))
}
let lastQuestions = ''
// the last few turns, fed to the planner so it never asks again what the chat already settled
const recent: string[] = []
function remember(role: string, text: string | undefined, max = opt('plannerChatChars', 500)) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return
  recent.push(`${role}: ${t.length > max ? `${t.slice(0, max)}…` : t}`)
  while (recent.length > Math.max(0, opt('plannerChatMessages', 8))) recent.shift()
}
const HUMAN = new Set(['composer', 'bridge', 'sdk'])

async function setAuto($: any, value?: boolean): Promise<boolean> {
  const now = value ?? !(await read($, autoA))
  await update($, autoA, () => now)
  await save($)
  $.ui.toast(now ? 'Auto-plan ON: every message is checked and planned' : 'Auto-plan off: messages go straight through')
  return now
}

async function setClean($: any, value?: boolean): Promise<boolean> {
  const now = value ?? !(await read($, cleanA))
  await update($, cleanA, () => now)
  await save($)
  $.ui.toast(now ? 'Clean code ON: engineering rules go into every chat and plan' : 'Clean code off: no engineering rules added')
  return now
}

async function setAutoClean($: any, value?: boolean): Promise<boolean> {
  const now = value ?? !(await read($, autoCleanA))
  await update($, autoCleanA, () => now)
  await save($)
  $.ui.toast(now ? 'Auto Clean ON: Handoff+/Clean clears the chat' : 'Auto Clean off: Handoff+/Clean only compacts')
  return now
}

async function sendAnswers($: any) {
  const pending = await read($, pendingA)
  if (!pending) return
  const draft = await read($, draftA)
  const lines = pending.questions.map((q, i) => {
    const d = draft[String(i)]
    const parts = [d?.choice, [d?.text, d?.typing].filter(Boolean).join(' ').trim()].filter(Boolean)
    return `${i + 1}. ${q} ${parts.length ? parts.join(' - ') : '(no answer)'}`
  })
  await update($, draftA, () => ({}))
  await update($, answeredA, () => true)
  fromPanel = true
  await $.prompt.submit({ text: lines.join('\n') })
}

async function dismissQuestions($: any) {
  await update($, draftA, () => ({}))
  await update($, pendingA, () => null)
  await save($)
}

async function skipQuestions($: any) {
  await update($, draftA, () => ({}))
  await update($, answeredA, () => true)
  fromPanel = true
  await $.prompt.submit({ text: 'go' })
}

// Every typed message passes here while auto-plan is on. A cheap Haiku pass decides: ask first (the message is
// held back and the questions shown), plan (a short plan rides along as context the person never sees), or
// nothing worth adding (the message goes through untouched). Short messages and slash commands skip it.
async function autoPlan($: any, e: any): Promise<string | 'drop' | null> {
  if (!(await read($, autoA))) return null
  const isPanel = fromPanel
  fromPanel = false
  if (!isPanel && !HUMAN.has(String(e.origin?.kind))) return null
  const text = String(e.text ?? '').trim()
  const pending = await read($, pendingA)
  if (text.startsWith('/')) return null
  if (pending && L.GO_WORDS.test(text)) {
    await update($, pendingA, () => null)
    return `The person skipped the questions; go ahead with the original request: ${pending.ask}`
  }
  if (!pending && text.length < 30) {
    remember('User', text)
    return null
  }
  const ask = pending ? pending.ask : text
  const answers = pending ? [...pending.answers, text] : []
  const plan = await analyze($, ask, answers, pending ? pending.questions : [])
  if (!plan) {
    await update($, pendingA, () => null)
    await save($)
    remember('User', text)
    return null
  }
  // one round of questions at most: a reply to them is always enough to go on
  if (!plan.isClear && !pending && plan.questions.length) {
    await update($, answeredA, () => false)
    await update($, pendingA, () => ({ ask, answers, questions: plan.questions.slice(0, 2) }))
    await save($)
    remember('User', text)
    lastQuestions = ['Command Deck needs a detail first. Reply, or "go" to skip:', ...plan.questions.slice(0, 2).map((q, i) => `${i + 1}. ${q}`)].join('\n')
    $.ui.toast(plan.questions[0] ? `Command Deck asks: ${plan.questions[0]}` : 'Command Deck needs details')
    return 'drop'
  }
  remember('User', text)
  await update($, pendingA, () => null)
  if (!L.isWorthAttaching(plan)) {
    await save($)
    return pending ? `Answers to the earlier questions are in this message. Original request: ${pending.ask}` : null
  }
  const tasks: Task[] = L.withSmokeTask(plan.tasks).map((t, i) => ({ id: i + 1, title: t.title, tier: t.tier, why: t.why, parallel: t.parallel, status: 'todo', tokens: 0 }))
  await archive($)
  await update($, tasksA, () => tasks)
  await update($, goalA, () => plan.prompt)
  agentTask.clear()
  mainTask = null
  isAutoBoard = true
  startSpin($)
  await save($)
  await writeProgress($)
  const clean = await read($, cleanA)
  const extra = pending ? `\nOriginal request: ${pending.ask}\nThe message above answers the questions that were asked.` : ''
  if (clean) try {
    const logPath = `${DIR}/rules-log.md`
    const prev = (await $.fs.exists(logPath)) ? String(await $.fs.read(logPath)) : ''
    const picks = G.pickForPlan(plan).map(p => `step ${p.step} [${p.tier}]: ${p.sections.length ? `core+${p.sections.join(',')}` : 'core'}`)
    const logLine = `${new Date(await $.clock.now()).toISOString()} ${picks.join('; ')}`
    await $.fs.write(logPath, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + logLine + '\n')
  } catch {
    /* logging is best effort */
  }
  // Unity projects only; other projects get the same text as before
  const unity = await $.fs.exists('ProjectSettings/ProjectVersion.txt').catch(() => false)
  return L.planContext(plan, { clean, unity }) + extra
}

// Learn more: a pane of its own with an explanation written for the tip. The text lives in session state only:
// it never enters the conversation (a plain completion, no transcript) and is not stored unless Save is pressed.
async function learnMore($: any, tip: string) {
  await update($, learnA, () => ({ tip, text: '', isLoading: true, isSaved: false }))
  await $.ui.open({ id: LEARN, title: 'Learn more' })
  try {
    const r = await $.model.complete({ model: 'sonnet', system: L.TUTOR_SYSTEM, prompt: `Tip: ${tip}`, maxTokens: 1400, timeoutMs: 90_000 })
    if (r.isAnswered) await addUsage($, 'sonnet', { ...r.usage, model: 'sonnet' })
    const text = r.isAnswered ? r.text : `Could not write the explanation (${r.reason}).`
    await update($, learnA, (l: Learn | null) => (l && l.tip === tip ? { ...l, text, isLoading: false } : l))
  } catch (err) {
    await update($, learnA, (l: Learn | null) => (l && l.tip === tip ? { ...l, text: `Could not write the explanation: ${String((err as Error)?.message ?? err)}`, isLoading: false } : l))
  }
}

async function saveLearn($: any) {
  const l = await read($, learnA)
  if (!l || l.isLoading) return
  const path = `${DIR}/learn/${L.dayKey(await $.clock.now())}-${L.slug(l.tip)}.md`
  await $.fs.write(path, `# ${l.tip}\n\n${l.text}\n`)
  await update($, learnA, (x: Learn | null) => (x ? { ...x, isSaved: true } : x))
  $.ui.toast(`Saved to ${path}`)
}

export const register: Register = (on, options) => {
  cfg = (options ?? {}) as Record<string, unknown>

    on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'command-deck', description: 'Command Deck: board, usage, git. Subcommands: auto, cave, clean, autoclean, run, fresh, handoff, compact, done N, clear', argumentHint: '[auto|cave|clean|autoclean|run|fresh|handoff|compact|done N|clear]' })
    await $.command.register({ name: 'command-deck-cave', description: 'Caveman mode: short answers. on, off, or toggle', argumentHint: '[on|off]' })
    await $.command.register({ name: 'command-deck-plan', description: 'Sharpen a request, ask what is unclear, split it into tasks per model', argumentHint: '<what you want done>' })
    await load($)
    // autoStart (setting, default on): every new chat opens the deck pane and switches auto-plan on
    if (opt('autoStart', 1) > 0) {
      await update($, autoA, () => true)
      await $.store.set('deck.auto', true)
      void $.ui.open({ id: PANE, title: 'Command Deck' })
    }
    void refreshGit($)
    void refreshUsage($)
    void refreshRtk($, true)
    $.clock.every(30_000, () => void refreshGit($))
    $.clock.every(30_000, () => void refreshRtk($))
    $.clock.every(60_000, () => void warmTick($))
    await update($, tipA, () => Math.floor(Math.random() * L.TIPS.length))
    $.clock.every(L.TIP_ROTATE_MS, () => void update($, tipA, (n: number) => n + 1))
    return next(e)
  })

  // ------------------------------------------------------------ commands
  on('command.run', { command: 'command-deck-cave' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const now = await setCave($, arg === 'on' ? true : arg === 'off' ? false : undefined)
    return { text: now ? 'Caveman ON. Short answers.' : 'Caveman off.' }
  })

  on('command.run', { command: 'command-deck-plan' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) {
      const pending = await read($, pendingA)
      return { text: pending ? ['Waiting for answers:', ...pending.questions.map((q, i) => `  ${i + 1}. ${q}`)].join('\n') : 'Usage: /command-deck-plan <what you want done>' }
    }
    const pending = await read($, pendingA)
    try {
      if (pending && !text.toLowerCase().startsWith('new ')) {
        return { text: await runPlan($, pending.ask, [...pending.answers, text]) }
      }
      return { text: await runPlan($, text.replace(/^new\s+/i, ''), []) }
    } catch (err) {
      return { text: `Planning failed: ${String((err as Error)?.message ?? err)}` }
    }
  })

  on('command.run', { command: 'command-deck' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    switch (sub.toLowerCase()) {
      case '':
      case 'open':
        await $.ui.open({ id: PANE, title: 'Command Deck' })
        await refreshGit($)
        await refreshUsage($)
        return { text: 'Command Deck opened.' }
      case 'run': {
        if (isRunning) return { text: 'Already running.' }
        const todo = (await read($, tasksA)).filter(t => t.status === 'todo').length
        if (!todo) return { text: 'No open tasks. Use /command-deck-plan first.' }
        void runAll($)
        return { text: `Running ${todo} tasks, each on its own model. Watch /command-deck.` }
      }
      case 'handoff':
        return { text: await handoff($) }
      case 'fresh':
      case 'new':
        void $.clock.after(50, () => void fresh($).then(t => $.ui.toast(t)))
        return { text: 'Writing the handoff, then starting a fresh chat with it.' }
      case 'auto': {
        const arg = (rest[0] ?? '').toLowerCase()
        const now = await setAuto($, arg === 'on' ? true : arg === 'off' ? false : undefined)
        return { text: now ? 'Auto-plan ON.' : 'Auto-plan off.' }
      }
      case 'clean': {
        const arg = (rest[0] ?? '').toLowerCase()
        const now = await setClean($, arg === 'on' ? true : arg === 'off' ? false : undefined)
        return { text: now ? 'Clean code ON. Engineering rules added to chats and plans.' : 'Clean code off.' }
      }
      case 'autoclean': {
        const arg = (rest[0] ?? '').toLowerCase()
        const now = await setAutoClean($, arg === 'on' ? true : arg === 'off' ? false : undefined)
        return { text: now ? 'Auto Clean ON. Handoff+/Clean clears the chat.' : 'Auto Clean off. Handoff+/Clean only compacts.' }
      }
      case 'cave': {
        const arg = (rest[0] ?? '').toLowerCase()
        const now = await setCave($, arg === 'on' ? true : arg === 'off' ? false : undefined)
        return { text: now ? 'Caveman ON. Short answers.' : 'Caveman off.' }
      }
      case 'warm': {
        const arg = (rest[0] ?? '').toLowerCase()
        if (arg === 'off') {
          stopWarm($, 'turned off')
          return { text: 'Keep-warm off.' }
        }
        if (arg === 'on' || arg === '') await armWarm($, Number.parseFloat(rest[1] ?? '') || opt('warmHours', 6), 'asked')
        const left = warmUntil ? Math.max(0, Math.round((warmUntil - (await $.clock.now())) / 60_000)) : 0
        return { text: warmUntil ? `Keep-warm on, ${left} min left. A ping goes out after ${opt('warmPingMin', 50)} idle minutes.` : 'Keep-warm off. /command-deck warm on [hours] turns it on.' }
      }
      case 'tools': {
        const arg = (rest[0] ?? '').toLowerCase()
        if (arg === 'off') {
          toolsOn = false
          deferServers = new Set()
          return { text: 'Smart tools off: every MCP tool is listed as the engine normally does (takes effect on the next request).' }
        }
        if (arg === 'on') toolsOn = true
        const list = [...deferServers]
        return { text: toolsOn ? (list.length ? `Smart tools on. Behind search for this chat: ${list.join(', ')}. Still reachable on demand.` : 'Smart tools on. Nothing deferred yet; it decides on the first prompt of a chat.') : 'Smart tools off. /command-deck tools on turns it back on.' }
      }
      case 'compact': {
        const rules = await rulesText($)
        const board = (await read($, tasksA)).map(t => `${t.status}: ${t.title}`).join('; ')
        void $.session.compact({ instructions: `Keep: the goal, these rules, the open tasks and any decision already made. Rules:\n${rules}\nTasks: ${board}` }).catch(() => undefined)
        return { text: 'Compacting with the rules and the board kept.' }
      }
      case 'done': {
        const id = Number(rest[0])
        await update($, tasksA, (l: Task[]) => l.map(t => (t.id === id ? { ...t, status: 'done' as const } : t)))
        await save($)
        await writeProgress($)
        return { text: `Task ${id} marked done.` }
      }
      case 'clear':
        await archive($)
        await update($, tasksA, () => [])
        await update($, goalA, () => '')
        await update($, pendingA, () => null)
        await save($)
        return { text: 'Board cleared.' }
      default:
        return { text: 'Subcommands: auto [on|off], cave [on|off], clean [on|off], autoclean [on|off], warm [on|off], tools [on|off], run, fresh (handoff + new chat), handoff, compact, done N, clear. Also /command-deck-plan <ask>.' }
    }
  })

  // ------------------------------------------------------------ prompt shaping
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const extra: { id: string; text: string; scope: 'session' }[] = []
    if (await read($, autoA)) extra.push({ id: 'command-deck:house', text: L.HOUSE_SECTION, scope: 'session' })
    if (await read($, cleanA)) extra.push({ id: 'command-deck:clean-code', text: G.CORE, scope: 'session' })
    if (await read($, caveA)) extra.push({ id: 'command-deck:caveman', text: L.CAVEMAN_SECTION, scope: 'session' })
    return extra.length ? { ...out, sections: [...out.sections, ...extra] } : out
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    {
      const ctxNow = (await read($, limitsA)).ctxTokens ?? 0
      const ttl = opt('cacheTtlMin', 60) * 60_000
      if (lastReal && warmUntil && now - lastReal >= ttl && now - lastTouch < ttl && ctxNow >= opt('coldMinTokens', 50_000)) {
        // a cold rewrite bills the prefix at about 2x input, a read at 0.1x: the ping saved the 1.9x difference
        await addSaving('keepwarm', Math.round(ctxNow * 1.9), $)
      }
    }
    const mode = opt('coldGuard', 1) // 0 off, 1 warn (price shown, message sent), 2 refuse (first send dropped once)
    if (mode > 0 && !coldWarned && !e.text.startsWith('/')) {
      const ctx = await read($, limitsA)
      const tokens = ctx.ctxTokens ?? 0
      const c = L.coldCheck(now, lastTouch, opt('cacheTtlMin', 60), tokens, opt('coldMinTokens', 50_000))
      if (c.isCold) {
        coldWarned = true
        const cost = L.rewriteDollars(tokens, opt('inputDollarsPerMTok', 3)).toFixed(2)
        const msg = `Cache went cold (idle ${c.idleMin} min): this send rewrites about ${L.compact(tokens)} tokens, roughly $${cost}. Keep-warm is now on so it stays warm.`
        if (opt('autoKeepWarm', 1) > 0) await armWarm($, 3, 'cold cache detected')
        if (mode >= 2) return { drop: `${msg} Send again to continue, or /command-deck fresh to start a small new chat.` }
        $.ui.toast(msg)
      }
    }
    const limit = opt('handoffTurns', 12)
    if (limit > 0 && !isNudged && !e.text.startsWith('/') && e.text.length > 40) {
      try {
        const turns = await $.session.turns()
        if (turns >= limit) {
          const kind = await $.model.classify(e.text, ['continues the current work', 'starts a new feature or topic'], { model: 'haiku' })
          if (kind === 'starts a new feature or topic') {
            isNudged = true
            if (opt('autoFresh', 1) > 0) {
              const carry = e.text
              $.clock.after(100, () => void fresh($, carry).then(t => $.ui.toast(t)))
              return { drop: 'New topic after a long chat: moving to a fresh chat with a handoff. Your message goes with it.' }
            }
            $.ui.toast('New topic after a long chat: /command-deck fresh moves to a new chat with a handoff.')
          }
        }
      } catch {
        /* classification is a nudge only */
      }
    }
    let planned: string | 'drop' | null = null
    try {
      planned = await autoPlan($, e)
    } catch {
      planned = null
    }
    if (planned === 'drop') return { drop: lastQuestions || 'Command Deck needs more details first. Reply with them, or "go" to skip.' }
    isTurnLive = true
    if (!e.text.startsWith('/')) await decideTools($, e.text).catch(() => undefined)
    if (planned) return next({ ...e, context: [...(e.context ?? []), planned] })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const auto = await read($, autoA)
    const nextTodo = isAutoBoard ? (await read($, tasksA)).find(t => t.status === 'todo') : undefined
    const wantsHaiku = !e.model && (String(e.subagentType) === 'Explore' || (nextTodo?.tier === 'haiku' && String(e.subagentType) !== 'Plan'))
    const input = auto && wantsHaiku ? { ...e, model: 'haiku' } : e
    const res = (await next(input)) as { model?: string; agentId?: string; deny?: unknown }
    if (!isRunning && !res?.deny && res?.agentId) {
      const ask = e as { description?: unknown; prompt?: unknown }
      const tier = tierOf(res?.model ?? (input as { model?: string }).model) ?? 'sonnet'
      const now = await $.clock.now()
      let id = 0
      await update($, tasksA, (l: Task[]) => {
        const made = L.agentCard(l, [String(ask.description ?? ''), String(ask.prompt ?? '')], tier, now)
        id = made.id
        return made.tasks
      })
      agentTask.set(res.agentId, id)
      startSpin($)
      await save($)
      await writeProgress($)
    }
    return res as never
  })

  // ------------------------------------------------------------ measuring
  on('session.measure', async ($, e, next) => {
    await applyUsage($, e)
    return next(e)
  })

  on('tool.describe', async ($, e, next) => {
    const out = await next(e)
    if (!toolsOn || !deferServers.size) return out
    const srv = L.serverOfTool(String(e.tool))
    return srv && deferServers.has(L.norm(srv)) ? { ...out, isDeferred: true } : out
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (isAutoBoard && !isRunning && !(e as { agentId?: string }).agentId && mainTask === null && agentTask.size === 0 && tool !== 'Agent') {
      mainTask = (await beginTask($, null))?.id ?? null
    }
    // The board follows the model's own task list: TodoWrite sends the whole list with statuses, TaskCreate one new task,
    // TaskUpdate a status change. New titles become cards, and a card moves forward when its task starts or is completed.
    let created: string | undefined
    if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') {
      try {
        const input = (e as { input?: { todos?: unknown; subject?: unknown; taskId?: unknown; status?: unknown } }).input
        const now = await $.clock.now()
        const listed = tool === 'TodoWrite' ? input?.todos : tool === 'TaskCreate' ? [{ content: input?.subject }] : []
        const add = L.newTodoTitles(listed, (await read($, tasksA)).map(t => t.title))
        if (tool === 'TaskCreate') created = add[0] ?? String(input?.subject ?? '')
        if (add.length) {
          await update($, tasksA, (l: Task[]) => [
            ...l,
            ...add.map((title, i) => ({ id: Math.max(0, ...l.map(x => x.id)) + i + 1, title, tier: 'sonnet' as const, why: 'Found while working', parallel: false, status: 'todo' as const, tokens: 0 })),
          ])
        }
        // the model's own list now says what is in progress, so the turn's guessed card is no longer a guess
        mainTask = null
        if (tool === 'TodoWrite') {
          await update($, tasksA, (l: Task[]) => L.syncTodos(l, listed, now))
        } else if (tool === 'TaskUpdate') {
          const title = modelTasks.get(String(input?.taskId))
          const to = L.statusOfTask(input?.status)
          if (title && to) await update($, tasksA, (l: Task[]) => l.map(t => (L.sameTitle(t.title, title) ? L.setCard(t, to, now) : t)))
        }
        await save($)
        await writeProgress($)
      } catch {
        /* the board follows the plan even if a todo list cannot be read */
      }
    }
    const srv = L.serverOfTool(tool)
    if (srv) {
      usedServers.add(L.norm(srv))
      deferServers.delete(L.norm(srv))
    }
    const res = await next(e)
    if (created) {
      // Claude Code numbers its tasks 1, 2, 3 in creation order, and says so in the result
      const made = res as { task?: { id?: unknown }; result?: { task?: { id?: unknown } } }
      modelTasks.set(String(made.task?.id ?? made.result?.task?.id ?? modelTasks.size + 1), created)
    }
    try {
      if (L.serverOfTool(tool) === 'graphify' || (tool === 'Bash' && L.isGraphifyQuery((e as { input?: { command?: unknown } }).input?.command))) {
        await addSaving('graphify', opt('graphifyTokensPerCall', 1200), $)
      }
      if (tool.startsWith('mcp__graft__')) {
        await addSaving('graft', L.parseGraftSaved((res as { text?: string }).text), $)
      } else if (tool.startsWith('mcp__token-optimizer__smart_')) {
        await addSaving('optimizer', opt('optimizerTokensPerCall', 1200), $)
      }
    } catch {
      /* counting savings never breaks a tool call */
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    const usage = e.usage
    if (!e.agentId) {
      isTurnLive = false
      remember('Assistant', (e as { answer?: string }).answer, 600)
      lastTouch = await $.clock.now()
      lastReal = lastTouch
      coldWarned = false
    }
    await addUsage($, usage?.model, usage)
    if (e.agentId && usage && L.modelBucket(usage.model) === 'Haiku') {
      // work the planner routed to Haiku instead of Sonnet: the real tokens times the price gap (an assumption, set in options)
      await addSaving('routing', Math.round(L.billed(usage) * opt('routingSaveRatio', 0.67)), $)
    }
    if (e.agentId) {
      const done: Done = { answer: e.answer ?? '', tokens: usage ? L.billed(usage) : 0 }
      completions.set(e.agentId, done)
      waiters.get(e.agentId)?.(done)
      waiters.delete(e.agentId)
      const card = agentTask.get(e.agentId)
      if (card !== undefined) {
        agentTask.delete(e.agentId)
        await endTask($, card)
        if (!isRunning && !(await read($, tasksA)).some(t => t.status === 'doing')) stopSpin()
        await writeProgress($)
      }
    } else if (!isRunning) {
      // a turn ending proves nothing finished: only `Done:` lines close cards; the turn's guessed card goes back to
      // todo, so the board never shows work in progress that nothing is doing
      const now = await $.clock.now()
      const marks = L.boardMarks((e as { answer?: string }).answer)
      const guess = mainTask
      mainTask = null
      await update($, tasksA, (l: Task[]) =>
        L.applyMarks(l, marks, now).map(t => (t.id === guess && t.status === 'doing' && ![...agentTask.values()].includes(t.id) ? L.setCard(t, 'todo', now) : t)),
      )
      const left = await read($, tasksA)
      if (!left.some(t => t.status === 'doing')) stopSpin()
      if (!left.some(t => t.status === 'todo')) isAutoBoard = false
      await writeProgress($)
    }
    if (!e.agentId && usage && L.toolAvailable('ponytail', undefined, undefined, 0, (await read($, limitsA)).skills)) {
      await addSaving('ponytail', L.cavemanSaved(usage.output_tokens ?? 0, opt('ponytailRatio', 0.45)), $)
    }
    if (!e.agentId && usage && (await read($, caveA))) {
      await addSaving('caveman', L.cavemanSaved(usage.output_tokens ?? 0, opt('cavemanRatio', 0.35)), $)
    }
    await save($)
    await refreshUsage($)
    void refreshGit($)

    const ctx = await read($, limitsA)
    // keep the cache warm once the context is big enough for a cold rewrite to hurt
    if (!e.agentId && opt('autoKeepWarm', 1) > 0 && !warmUntil && (ctx.ctxTokens ?? 0) >= opt('coldMinTokens', 50_000)) {
      await armWarm($, opt('warmHours', 6), 'big context')
    }
    // at the set share of the window: write the handoff, clear, and carry on in a small fresh chat
    const freshPct = opt('autoFreshPct', 50)
    if (freshPct > 0 && !isCompacting && !isRunning && agentTask.size === 0 && !e.agentId && ctx.ctxPct >= freshPct) {
      isCompacting = true
      $.clock.after(1500, () => {
        void fresh($)
          .then(t => $.ui.toast(`Context at ${Math.round(ctx.ctxPct)}%. ${t}`))
          .catch(() => undefined)
          .finally(() => {
            isCompacting = false
            lastTouch = 0
            coldWarned = false
          })
      })
    }
    // plain compaction stays available for people who want it instead (autoCompactPct, off by default)
    const limit = opt('autoCompactPct', 0)
    if (limit > 0 && freshPct <= 0 && !isCompacting && !e.agentId && ctx.ctxPct >= limit) {
      isCompacting = true
      $.clock.after(1500, () => {
        void $.session
          .compact({ instructions: 'Keep the goal, open tasks and decisions.' })
          .catch(() => undefined)
          .finally(() => {
            isCompacting = false
          })
      })
    }
    return out
  })

  // ------------------------------------------------------------ the pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [tasks, usage, savings, cave, clean, autoClean, git, limits, frame, tip, goal, auto, pending, draft, mins, savedOrder, hist, answered, rtk] = await Promise.all([
      read($, tasksA),
      read($, usageA),
      read($, savingsA),
      read($, caveA),
      read($, cleanA),
      read($, autoCleanA),
      read($, gitA),
      read($, limitsA),
      read($, frameA),
      read($, tipA),
      read($, goalA),
      read($, autoA),
      read($, pendingA),
      read($, draftA),
      read($, minA),
      read($, orderA),
      read($, histA).catch(() => [] as Hist[]),
      read($, answeredA),
      read($, rtkA),
    ])
    const Input = ($.ui.resolve(e) as any).Input as ((p: Record<string, unknown>) => any) | undefined
    const now = await $.clock.now()

    // room inside a window: the pane's body less a round border and one column of padding each side
    const cols = Math.max(36, Number((e.props as { bodyColumns?: number })?.bodyColumns) || 60)
    const inner = cols - 4
    const LBL = 9
    const barW = Math.max(6, Math.min(28, inner - LBL - 16))
    const pctText = (pct: number) => `${pct.toFixed(0)}%`.padStart(5)

    const toggleMin = (id: string) => update($, minA, (m: Record<string, boolean>) => ({ ...m, [id]: !m[id] }))
    // layout: the person's section order, saved across sessions; null is the default order
    const order = fullOrder(savedOrder)
    const visible: string[] = []
    const moveSlot = (slot: string, dir: -1 | 1) => {
      const at = visible.indexOf(slot)
      const other = visible[at + dir]
      if (at < 0 || !other) return
      const next = [...order]
      const i = next.indexOf(slot)
      const j = next.indexOf(other)
      next[i] = other
      next[j] = slot
      void update($, orderA, () => next)
      void $.store.set('deck.order', next)
    }
    const resetLayout = () => {
      void update($, orderA, () => null)
      void $.store.set('deck.order', null)
    }
    const reorderBtns = (slot: string) => (
      <Box>
        <Text dimColor>⠿ </Text>
        <Button key={`up-${slot}`} label="▲" onPress={() => moveSlot(slot, -1)} />
        <Button key={`dn-${slot}`} label="▼" onPress={() => moveSlot(slot, 1)} />
        <Text> </Text>
      </Box>
    )
    const win = (icon: string, title: string, color: string, body: any, note?: string, slot?: string) => {
      const isMin = Boolean(mins[title])
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={color} wrap="truncate-end">
              {icon} {title}
              {note ? <Text dimColor>{`  ${note}`}</Text> : null}
            </Text>
            <Box>
              {slot ? reorderBtns(slot) : null}
              <Button key={`min-${title}`} label={isMin ? '＋' : '－'} onPress={() => void toggleMin(title)} />
            </Box>
          </Box>
          {isMin ? null : body}
        </Box>
      )
    }

    // one line per meter: label, filled and empty bar, percent, tail; nested Text so nothing wraps
    const meter = (label: string, pct: number | undefined, tail: string, color?: string) => {
      if (pct === undefined) {
        return (
          <Text dimColor wrap="truncate-end">
            {label.padEnd(LBL)}
            {'·'.repeat(barW)}
            {'   n/a'}
          </Text>
        )
      }
      const b = L.bar(pct, barW)
      return (
        <Text wrap="truncate-end">
          <Text color={color} bold={Boolean(color)}>
            {label.padEnd(LBL)}
          </Text>
          <Text color={color ?? L.barColor(pct)}>{b.full}</Text>
          <Text dimColor>{b.empty}</Text>
          <Text bold>{pctText(pct)}</Text>
          <Text dimColor>{tail ? `  ${tail}` : ''}</Text>
        </Text>
      )
    }

    const field = (label: string, value: string, color?: string) => (
      <Text wrap="truncate-end">
        <Text dimColor>{label.padEnd(10)}</Text>
        <Text color={color} bold={Boolean(color)}>
          {value}
        </Text>
      </Text>
    )

    // ---------------- header
    const header = (
      <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan" wrap="truncate-end">
          ◆ COMMAND DECK
        </Text>
        <Box gap={1} flexWrap="wrap">
          <Button key="cave" label={cave ? '🔥 Caveman ON' : '○ Caveman off'} onPress={() => setCave($)} />
          <Button key="clean" label={clean ? '✓ Clean code ON' : '○ Clean code off'} onPress={() => setClean($)} />
          <Button key="auto" label={auto ? '⚡ Auto-plan ON' : '○ Auto-plan off'} onPress={() => setAuto($)} />
          <Button key="fresh" label="⇢ Handoff+/Clean" onPress={() => void fresh($).then(t => $.ui.toast(t))} />
          <Button key="autoclean" label={autoClean ? '✓ Auto Clean ON' : '○ Auto Clean off'} onPress={() => setAutoClean($)} />
          <Button key="reset-layout" label="↺ Reset layout" onPress={resetLayout} />
        </Box>
      </Box>
    )

    // ---------------- usage
    const fiveTail = limits.fiveHour ? `↻ ${L.resetsIn(limits.fiveHour.resetsAt, now)}` : ''
    const weekTail = limits.sevenDay ? `↻ ${L.resetsIn(limits.sevenDay.resetsAt, now)}` : ''
    const ctxTail = limits.ctxWindow ? `${L.compact(limits.ctxTokens ?? 0)}/${L.compact(limits.ctxWindow)}` : ''
    // cache: an estimate from the clock (the server is never asked); it redraws with the pane's other refreshes
    const idleMin = lastTouch ? Math.max(0, Math.floor((now - lastTouch) / 60_000)) : 0
    const ttlMin = opt('cacheTtlMin', 60)
    const isColdNow = Boolean(lastTouch) && idleMin >= ttlMin && (limits.ctxTokens ?? 0) >= opt('coldMinTokens', 50_000)
    const warmLeft = warmUntil > now ? Math.round((warmUntil - now) / 60_000) : 0
    const cacheText = !lastTouch
      ? 'no turn yet'
      : `${isColdNow ? 'cold' : 'warm'}, idle ${idleMin}m${warmLeft ? `, keep-warm ${warmLeft}m left` : ', keep-warm off'}`
    const cacheColor = isColdNow ? 'red' : warmLeft ? 'green' : 'yellow'
    // the context bar split by where the tokens come from (the engine's own /context breakdown)
    const segs = L.ctxSegments(limits.parts ?? [], limits.ctxWindow, 30).sort((x, y) => y.tokens - x.tokens)
    const used = segs.reduce((n, x) => n + x.cells, 0)
    const ctxBar = segs.length ? (
      <Text wrap="truncate-end">
        <Text dimColor>{'Context'.padEnd(9)}</Text>
        <Text bold>{`${limits.ctxPct.toFixed(0)}%`.padStart(4)} </Text>
        {segs.map(x => (
          <Text key={`seg-${x.name}`} color={x.color}>
            {'█'.repeat(x.cells)}
          </Text>
        ))}
        <Text dimColor>{'░'.repeat(Math.max(0, 30 - used))}</Text>
        <Text dimColor>{` ${ctxTail}`}</Text>
      </Text>
    ) : null
    // one tight band per category, biggest first, as many per line as fit; the colour is the band itself
    const ctxLegend = segs.length
      ? [
          <Box key="ctx-bands" flexWrap="wrap" columnGap={1}>
            {segs.map(x => (
              <Text key={`lg-${x.name}`} backgroundColor={x.color} color={L.ctxInk(x.color)}>
                {` ${x.name} [${L.compact(x.tokens)}/${x.pct.toFixed(1)}%] `}
              </Text>
            ))}
          </Box>,
          ...((limits.servers ?? []).length
            ? [
                <Text key="ctx-mcp" dimColor wrap="wrap">
                  {`MCP: ${(limits.servers ?? []).slice(0, 4).map(sv => `${sv.server} ${L.compact(sv.tokens)}`).join(' · ')}`}
                </Text>,
              ]
            : []),
        ]
      : []
    const usageWin = win(
      '▤',
      'USAGE',
      'blue',
      [
        meter('5-hour', limits.fiveHour?.pct, fiveTail),
        meter('Week', limits.sevenDay?.pct, weekTail),
        ctxBar ?? meter('Context', limits.ctxWindow ? limits.ctxPct : undefined, ctxTail),
        ...ctxLegend,
        field('Cache', cacheText, cacheColor),
      ],
      limits.usd !== undefined ? `session $${limits.usd.toFixed(2)}` : undefined,
      'USAGE',
    )

    // ---------------- models
    const shown = L.shares(usage)
    const modelColor: Record<string, string> = { Haiku: 'green', Sonnet: 'cyan', Opus: 'magenta', Other: 'gray' }
    const modelsWin = win(
      '◉',
      'MODELS TODAY',
      'magenta',
      shown.every(s => s.tokens === 0)
        ? <Text dimColor>no turns counted yet</Text>
        : shown.map(s => meter(s.name, s.pct, L.compact(s.tokens), modelColor[s.name])),
      undefined,
      'MODELS',
    )

    // ---------------- board
    const twoUp = inner >= 54
    const colW = twoUp ? Math.max(12, Math.floor((inner - 4) / 3) - 4) : inner - 2
    const card = (t: Task) => {
      const tierColor = L.TIER_COLOR[t.tier]
      const bot = t.status === 'doing' ? L.workingBot(t.tier, frame, opt('reducedMotion', 0) > 0) : null
      const icon = t.status === 'done' ? '✔' : t.status === 'failed' ? '✖' : '○'
      const iconColor = t.status === 'done' ? 'green' : t.status === 'failed' ? 'red' : 'gray'
      return (
        <Text key={`card-${t.id}`} wrap="wrap">
          {bot ? (
            <Text bold>
              <Text color={tierColor}>{bot.face}</Text>
              <Text color={bot.sparkColor}>{bot.spark}</Text>{' '}
            </Text>
          ) : (
            <Text color={iconColor} bold>
              {icon}{' '}
            </Text>
          )}
          <Text color={tierColor} bold>
            [{L.TIER_LABEL[t.tier]}]{' '}
          </Text>
          <Text dimColor={t.status === 'done'}>{t.title}</Text>
        </Text>
      )
    }
    const lane = (title: string, color: string, list: Task[]) => (
      <Box flexDirection="column" borderStyle="single" borderColor={color} paddingX={1} flexGrow={1}>
        <Text bold color={color}>
          {title} <Text dimColor>{list.length}</Text>
        </Text>
        {list.length === 0 ? <Text dimColor>—</Text> : list.map(card)}
      </Box>
    )
    const todo = tasks.filter(t => t.status === 'todo')
    const doing = tasks.filter(t => t.status === 'doing')
    const done = tasks.filter(t => t.status === 'done' || t.status === 'failed')
    const boardWin = win(
      '▦',
      'BOARD',
      'yellow',
      tasks.length === 0 ? (
        <Text dimColor>Empty. /command-deck-plan &lt;what you want done&gt; fills it, /command-deck run works through it.</Text>
      ) : twoUp ? (
        <Box gap={1}>
          {lane('TODO', 'yellow', todo)}
          {lane('DOING', 'cyan', doing)}
          {lane('DONE', 'green', done)}
        </Box>
      ) : (
        <Box flexDirection="column">
          {lane('TODO', 'yellow', todo)}
          {lane('DOING', 'cyan', doing)}
          {lane('DONE', 'green', done)}
        </Box>
      ),
      tasks.length ? `${done.length}/${tasks.length} done` : undefined,
      'BOARD',
    )

    // ---------------- questions: replaces the board until they are answered
    const setDraft = (i: number, patch: Partial<Draft>) =>
      update($, draftA, (d: Record<string, Draft>) => ({ ...d, [String(i)]: { text: '', ...d[String(i)], ...patch } }))
    const questionsWin = pending && !answered
      ? win(
          '?',
          'BETTER PROMPT',
          'cyan',
          <Box flexDirection="column">
            {pending.questions.map((q, i) => {
              const d = draft[String(i)]
              return (
                <Box key={`q${i}`} flexDirection="column">
                  <Text bold wrap="wrap">
                    {i + 1}. {q}
                  </Text>
                  <Box gap={1} flexWrap="wrap">
                    {CHOICES.map(c => (
                      <Button
                        key={`q${i}-${c}`}
                        label={d?.choice === c ? `● ${c}` : `○ ${c}`}
                        onPress={() => void setDraft(i, { choice: d?.choice === c ? undefined : c })}
                      />
                    ))}
                  </Box>
                  {Input ? (
                    <Input
                      key={`q${i}-text-${d?.rev ?? 0}`}
                      label=""
                      placeholder="type your own answer, Enter adds it…"
                      value={d?.typing ?? ''}
                      submitLabel="add"
                      onInput={(v: string) => void setDraft(i, { typing: v })}
                      onSubmit={(v: string) => void setDraft(i, { text: [d?.text, v.trim()].filter(Boolean).join(' '), typing: '', rev: (d?.rev ?? 0) + 1 })}
                    />
                  ) : null}
                  {d?.text || d?.typing ? (
                    <Text wrap="wrap" dimColor>
                      {[d?.text, d?.typing].filter(Boolean).join(' ')}
                    </Text>
                  ) : null}
                </Box>
              )
            })}
            <Box gap={1} flexWrap="wrap">
              <Button key="q-send" label="Send answers →" onPress={() => void sendAnswers($)} />
              <Button key="q-skip" label="Skip questions" onPress={() => void skipQuestions($)} />
              <Button key="q-dismiss" label="Dismiss" onPress={() => void dismissQuestions($)} />
            </Box>
          </Box>,
          'answer, then the board returns',
          'BOARD',
        )
      : null

    // ---------------- git: one fact per line
    const dirty = git?.dirty ?? []
    const gitWin = win(
      '⎇',
      'GIT',
      'green',
      git ? (
        <Box flexDirection="column">
          {field('Branch', git.branch, 'magenta')}
          {field('Upstream', git.upstream || 'none', git.upstream ? 'green' : 'red')}
          {field(
            'Sync',
            git.upstream ? (git.ahead || git.behind ? `↑${git.ahead}  ↓${git.behind}` : 'in sync') : '—',
            git.ahead || git.behind ? 'yellow' : 'green',
          )}
          {field('Changes', dirty.length ? `${dirty.length} file${dirty.length === 1 ? '' : 's'}` : 'clean', dirty.length ? 'yellow' : 'green')}
          {dirty.slice(0, 6).map(f => (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {f}
            </Text>
          ))}
          {dirty.length > 6 ? <Text dimColor>{`  … ${dirty.length - 6} more`}</Text> : null}
          <Text dimColor>Branches</Text>
          {git.branches.slice(0, 8).map(b => (
            <Text wrap="truncate-end">
              <Text color={b.name === git.branch ? 'magenta' : undefined} bold={b.name === git.branch}>
                {b.name === git.branch ? '● ' : '  '}
                {b.name}
              </Text>
              <Text dimColor>{b.upstream ? ` → ${b.upstream}` : ' (local only)'}</Text>
              {b.track ? <Text color="yellow">{` ${b.track}`}</Text> : null}
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>not a git repository</Text>
      ),
      undefined,
      'GIT',
    )

    // ---------------- savings
    const inPrice = opt('inputDollarsPerMTok', 3)
    const outPrice = opt('outputDollarsPerMTok', 15)
    const saveRow = (label: string, tokens: number, price: number, color: string, state: L.ToolState = 'active') =>
      state === 'missing' ? (
        <Text wrap="truncate-end" dimColor>
          {label.padEnd(11)}
          {'(Not Installed)'}
        </Text>
      ) : (
        <Text wrap="truncate-end">
          <Text dimColor>{label.padEnd(11)}</Text>
          <Text color={color} bold>
            {L.compact(tokens).padStart(6)}
          </Text>
          {state === 'inactive' ? <Text color="yellow">{'  (Not Active)'}</Text> : <Text dimColor>{`  tokens  ≈ $${((tokens * price) / 1_000_000).toFixed(2)}`}</Text>}
        </Text>
      )
    const rtkSaved = rtk?.saved ?? 0
    const savingsWin = win(
      '✚',
      'TOKEN SAVED TODAY',
      'yellow',
      [
        saveRow('Graft', savings.graft, inPrice, 'green', L.toolState('graft', limits.servers, limits.skillTokens, savings.graft, limits.skills)),
        saveRow('Caveman', savings.caveman, outPrice, 'yellow', L.toolState('caveman', limits.servers, limits.skillTokens, savings.caveman, limits.skills, cave)),
        saveRow('CMD Deck', L.deckSaved(savings), inPrice, 'magenta'),
        saveRow('Optimizer', savings.optimizer, inPrice, 'green', L.toolState('optimizer', limits.servers, limits.skillTokens, savings.optimizer, limits.skills)),
        saveRow('RTK', rtkSaved, inPrice, 'cyan', rtk?.state),
        saveRow('Ponytail', savings.ponytail, outPrice, 'cyan', L.toolState('ponytail', undefined, undefined, savings.ponytail, limits.skills)),
        saveRow('Graphify', savings.graphify, inPrice, 'blue', L.toolState('graphify', limits.servers, undefined, savings.graphify, limits.skills)),
      ],
      `≈ $${(L.dollars(savings, inPrice, outPrice) + (rtkSaved * inPrice) / 1_000_000).toFixed(2)} est.`,
      'SAVED',
    )

    // ---------------- plan brief: the generated goal text, full and wrapped, at the bottom
    const BRIEF_COLORS: Record<string, string> = { Brief: 'cyan', Goal: 'cyan', Constraints: 'yellow', Behaviour: 'magenta', Behavior: 'magenta', 'Definition of done': 'green', Verification: 'blue', Done: 'green' }
    const briefParts = (text: string): { label: string; body: string }[] => {
      const re = /(?:^|\s)(Brief|Goal|Constraints|Behaviou?r|Definition of done|Verification|Done|Context|Notes?|Scope):\s/g
      const found: { label: string; at: number; end: number }[] = []
      for (let m = re.exec(text); m; m = re.exec(text)) found.push({ label: m[1] ?? '', at: m.index, end: m.index + m[0].length })
      if (!found.length) return [{ label: '', body: text.trim() }]
      const out = found.map((f, i) => ({ label: f.label, body: text.slice(f.end, found[i + 1]?.at ?? text.length).trim() }))
      const lead = text.slice(0, found[0]?.at ?? 0).trim()
      return lead ? [{ label: '', body: lead }, ...out] : out
    }
    const sentences = (body: string): string[] => body.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(x => x.trim()).filter(Boolean)
    const goalWin = goal
      ? win(
          '✎',
          'PLAN BRIEF',
          'cyan',
          <Box flexDirection="column">
            {goal
              .split('\n')
              .filter(l => l.trim())
              .flatMap(briefParts)
              .map(part => {
                const color = BRIEF_COLORS[part.label] ?? 'white'
                const items = sentences(part.body)
                const bullet = items.length > 1
                return (
                  <Box key={`b-${part.label}-${part.body.slice(0, 12)}`} flexDirection="column" marginBottom={1}>
                    {part.label ? (
                      <Text bold color={color}>
                        ▍{part.label.toUpperCase()}
                      </Text>
                    ) : null}
                    {items.map((item, ii) => (
                      <Box key={`it-${ii}`}>
                        <Box width={4} flexShrink={0}>
                          <Text dimColor>{bullet ? '  • ' : '    '}</Text>
                        </Box>
                        <Box flexGrow={1} flexShrink={1}>
                          <Text wrap="wrap">{item}</Text>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                )
              })}
          </Box>,
          undefined,
          'BRIEF',
        )
      : null

    // ---------------- history: everything finished, newest first, kept across /clear
    const stamp = (at: number) => new Date(at).toISOString().slice(5, 16).replace('T', ' ')
    const histWin = hist && hist.length
      ? win(
          '⌛',
          'HISTORY',
          'green',
          <Box flexDirection="column">
            {[...hist].reverse().slice(0, 15).map((it, i) => (
              <Text key={`h-${i}-${it.at}`} wrap="wrap">
                <Text dimColor>{stamp(it.at)} </Text>
                <Text color={it.status === 'failed' ? 'red' : 'green'} bold>
                  {it.status === 'failed' ? '✖' : it.status === 'handoff' ? '⇢' : '✔'}{' '}
                </Text>
                <Text color={L.TIER_COLOR[it.tier]} bold>
                  [{L.TIER_LABEL[it.tier]}]{' '}
                </Text>
                <Text>{it.title}</Text>
              </Text>
            ))}
            <Box>
              <Button key="hist-folder" label="📂 Open history folder" onPress={() => void openHistoryFolder($)} />
            </Box>
          </Box>,
          hist.length > 15 ? `15 of ${hist.length}` : `${hist.length}`,
          'HISTORY',
        )
      : null

    // ---------------- tip
    const tipText = L.TIPS[tip % L.TIPS.length] ?? ''
    const tipLines = L.wrapWords(tipText, Math.max(10, inner))
    let wordIndex = 0
    const tipWin = (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="yellow" wrap="truncate-end">
            ✦ RANDOM TIPS
          </Text>
          <Box>
            {reorderBtns('TIPS')}
            <Button key="min-tips" label={mins.TIPS ? '＋' : '－'} onPress={() => void toggleMin('TIPS')} />
          </Box>
        </Box>
        {mins.TIPS ? null : tipLines.map(line => (
          <Text wrap="truncate-end">
            {line.map(w => {
              const i = wordIndex++
              return (
                <Text italic color={L.TIP_COLORS[(i + tip) % L.TIP_COLORS.length]}>
                  {w}{' '}
                </Text>
              )
            })}
          </Text>
        ))}
        {mins.TIPS ? null : <Box gap={1} flexWrap="wrap">
          <Button key="tip-next" label="Next tip" onPress={() => update($, tipA, (n: number) => n + 1)} />
          <Button key="tip-learn" label="Learn more →" onPress={() => void learnMore($, tipText)} />
        </Box>}
      </Box>
    )

    // visible must be filled before the buttons are pressed, not before they are built: handlers read it later
    const parts: Record<string, any> = {
      BOARD: questionsWin ?? (tasks.length ? boardWin : null),
      USAGE: usageWin,
      MODELS: modelsWin,
      SAVED: savingsWin,
      GIT: gitWin,
      TIPS: tipWin,
      BRIEF: goalWin,
      HISTORY: histWin,
    }
    for (const id of order) if (parts[id]) visible.push(id)

    return (
      <Box flexDirection="column">
        {header}
        {visible.map(id => parts[id])}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: LEARN }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const l = await read($, learnA)
    if (!l) return <Text dimColor>Press Learn more on a tip in the Command Deck.</Text>
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow" wrap="wrap">
            ✦ {l.tip}
          </Text>
          <Box gap={1}>
            <Button key="learn-save" label={l.isSaved ? '✔ Saved' : 'Save to file'} onPress={() => saveLearn($)} />
            <Button key="learn-close" label="Close" onPress={() => $.ui.close({ id: LEARN })} />
          </Box>
          <Text dimColor>Not part of the chat; kept only for this session unless you save it.</Text>
        </Box>
        {l.isLoading ? <Text color="cyan">Writing the explanation…</Text> : <Markdown key="learn-body" text={l.text} />}
      </Box>
    )
  })
}
