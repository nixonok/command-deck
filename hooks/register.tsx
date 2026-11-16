import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import * as L from './lib'
import * as G from './guidelines'
import type { CtxPart, CtxServer, Draft, GitInfo, Hist, Learn, Limits, Pending, Plan, Savings, Task } from '../types'

const PANE = 'command-deck'
// absolute once load() has run: a relative path would follow the shell's working directory and scatter .claude folders through the project
let DIR = '.claude/deck'
// from plugin.json at load, so the pane shows which build is running; empty when it cannot be read
let VERSION = ''

const tasksA = atom({ plugin: 'command-deck', key: 'tasks' } as const, [] as Task[])
const goalA = atom({ plugin: 'command-deck', key: 'goal' } as const, '')
const pendingA = atom({ plugin: 'command-deck', key: 'pending' } as const, null as Pending | null)
const usageA = atom({ plugin: 'command-deck', key: 'usage' } as const, {} as Record<string, number>)
const savingsA = atom({ plugin: 'command-deck', key: 'savings' } as const, L.ZERO_SAVINGS)
const gitA = atom({ plugin: 'command-deck', key: 'git' } as const, null as GitInfo | null)
// RTK runs outside the chat, so its state and today's savings come from its own CLI; null until first checked
const rtkA = atom({ plugin: 'command-deck', key: 'rtk' } as const, null as { state: L.ToolState; saved: number } | null)
const limitsA = atom({ plugin: 'command-deck', key: 'limits' } as const, { ctxWindow: 0, ctxPct: 0 } as Limits)
const frameA = atom({ plugin: 'command-deck', key: 'frame' } as const, 0)
const tipA = atom({ plugin: 'command-deck', key: 'tip' } as const, 0)
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
// arrange mode shows the move buttons on every section; off, a section header holds only its fold button
const arrangeA = atom({ plugin: 'command-deck', key: 'arrange' } as const, false)
// the effort level the deck is sending this turn's requests with; '' when it leaves the session's own level
const effortA = atom({ plugin: 'command-deck', key: 'effort' } as const, '')
// the verify gate: what the last check said, or a command waiting for the person's yes
type Verify = { state: 'idle' | 'ask' | 'running' | 'pass' | 'fail'; command: string; note?: string }
const verifyA = atom({ plugin: 'command-deck', key: 'verify' } as const, { state: 'idle', command: '' } as Verify)
// what each effort level cost today (turns, output tokens, turns that ran long)
const effortStatsA = atom({ plugin: 'command-deck', key: 'effortStats' } as const, {} as Record<string, L.EffortStat>)
const LEARN = 'command-deck-learn'
const CHOICES = ['Yes', 'No', 'Not sure']
let fromPanel = false

type Done = { answer: string; tokens: number }

let isRunning = false
let isNudged = false
let isCompacting = false
// the context passed autoFreshPct: the next typed message moves to a fresh chat (never mid-turn, never before the
// person has read the last answer)
let isFreshDue = false
// the main agent's last reply, kept for the handoff because a clear wipes it from the screen
let lastAnswer = ''
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
// graft: the repo has an index (fixed at session start, so the system prompt line never changes mid-chat)
let hasGraft = false
let graftUsedTurn = false
let graftNudgedTurn = false
let graftNudges = 0
// effort routing: the planner's level for the current request (kept across short follow-ups), a level the person
// named, the level of the last main request, and what each model family proved about changing levels
let turnEffort: L.Effort | undefined
let namedLevel: L.Effort | undefined
// per model family: a switch of model starts clean, so the new family's first request is never read as a level change
let lastStep: Record<string, { sent?: string; session?: string }> = {}
let effortTrust: Record<string, L.EffortTrust> = {}
// caveman: the person's "normal mode" turns the reminder and the count off for the rest of the chat
let isCavemanOff = false
// the project, read once at session start: a Unity project, its guards, and the notes a new chat is told
let isUnity = false
let guards: L.Guard[] = []
let projectNotes = ''
// verify gate: files changed this turn, a check in flight, a failure waiting for the next typed message
let editedTurn = false
let csEditedTurn = false
let isVerifying = false
let verifyAgain = false
let verifySends = 0
let verifyNote = ''
// Unity MCP: calls that got no answer in a row (three and the deck stops asking); when Play was last seen off
let unityMisses = 0
let playClearAt = 0
// rules already given, by agent and file type, so each is paid for once
const rulesSent = new Set<string>()
// stuck detector: the last failure of each agent and how often it repeated
const fails = new Map<string, { key: string; n: number }>()
// the level the turn's main requests went out at, for the effort record
let turnSent: string | undefined
let statsDay = ''
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
    const done = (await read($, tasksA)).filter(t => t.status === 'done' || t.status === 'failed' || t.status === 'skipped')
    if (!done.length) return
    const have = await read($, histA)
    const seen = new Set(have.map(entry => `${entry.at}|${entry.title}`))
    const add = done
      .map(t => ({ at: t.endedAt ?? t.startedAt ?? now, title: t.title, tier: t.tier, status: t.status as string, tokens: t.tokens }))
      .filter(entry => !seen.has(`${entry.at}|${entry.title}`))
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
    const lines = items.map(entry => `- ${new Date(entry.at).toISOString().slice(0, 16).replace('T', ' ')} [${entry.tier}] ${entry.status}: ${entry.title}`)
    await $.fs.write(histFile(), `${prev.endsWith('\n') ? prev : `${prev}\n`}${lines.join('\n')}\n`)
  } catch {
    /* history is a convenience */
  }
}

// lasting project facts, gathered at each handoff and carried into every later one
const memoryFile = () => `${DIR}/memory.md`
const rootDir = () => DIR.replace(/\.claude\/deck$/, '')

/** A project file's text, or '' when it is missing or cannot be read. */
async function readFile($: any, path: string): Promise<string> {
  try {
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  } catch {
    return ''
  }
}

// ------------------------------------------------------------ verify gate
// Contract: after a turn that changed files, the project's check runs once in the background. Invariants: only a
// command the person allowed (that exact text, for this project) is ever run; one check at a time, a change that lands
// meanwhile runs one more; a failure reaches the model at most VERIFY_MAX_SENDS times per typed message.
async function verifyFor($: any): Promise<{ command: string; isAllowed: boolean; isRefused: boolean }> {
  const command = L.verifyCommand(await readFile($, `${DIR}/verify.txt`))
  const ok = ((await $.store.get('deck.verifyOk').catch(() => undefined)) as Record<string, string> | undefined) ?? {}
  const no = ((await $.store.get('deck.verifyNo').catch(() => undefined)) as Record<string, string> | undefined) ?? {}
  return { command, isAllowed: Boolean(command) && ok[DIR] === command, isRefused: Boolean(command) && no[DIR] === command }
}

// `shown` is the command the pane showed: the yes or no is for that text and no other. A file that changed since
// (an edit, a pull) is asked about again, never allowed on the old answer.
async function answerVerify($: any, shown: string, isYes: boolean) {
  const { command } = await verifyFor($)
  if (!shown || command !== shown) {
    await update($, verifyA, () => (command ? { state: 'ask' as const, command } : { state: 'idle' as const, command: '' }))
    return
  }
  const key = isYes ? 'deck.verifyOk' : 'deck.verifyNo'
  const have = ((await $.store.get(key).catch(() => undefined)) as Record<string, string> | undefined) ?? {}
  await $.store.set(key, { ...have, [DIR]: shown })
  await update($, verifyA, () => ({ state: 'idle' as const, command: shown }))
  if (isYes) void runVerify($, true).catch(() => undefined)
}

// A call to the Unity MCP that cannot hang a hook: an editor that does not answer in time counts as a miss. Three
// misses in a row and the deck stops asking for this chat (no Unity MCP here); any answer starts the count again, so
// one dropped call while Unity reloads its scripts turns nothing off.
async function askUnity($: any, input: Record<string, unknown>, waitMs: number): Promise<string | null> {
  if (unityMisses >= 3) return null
  try {
    const r = (await Promise.race([$.tool.call(input), $.clock.sleep(waitMs).then(() => null)])) as { deny?: unknown; text?: string } | null
    if (!r || r.deny || typeof r.text !== 'string') throw new Error('no answer')
    unityMisses = 0
    return r.text
  } catch {
    unityMisses += 1
    return null
  }
}

// Unity's own compiler, asked through the Unity MCP. A compile still running is waited for with a growing pause, a few
// times; an editor that cannot be asked is no failure.
async function unityCompile($: any): Promise<{ what: string; output: string } | 'clean' | 'unknown'> {
  for (let wait = 2000; wait <= 8000; wait += 2000) {
    const text = await askUnity($, { tool: L.UNITY_ERRORS_TOOL, severity: 'error', count: 20 }, 8000)
    if (text === null) return 'unknown'
    const c = L.unityCompile(text)
    if (c.errors) return { what: 'Unity compile errors', output: c.errors }
    if (!c.isCompiling) return 'clean'
    await $.clock.sleep(wait).catch(() => undefined)
  }
  return 'unknown'
}

async function runVerify($: any, isForced = false) {
  if (opt('verifyGate', 1) <= 0) return
  if (isVerifying) {
    verifyAgain = true
    return
  }
  isVerifying = true
  try {
    do {
      verifyAgain = false
      const wasCs = csEditedTurn
      csEditedTurn = false
      const compiled = isUnity && wasCs ? await unityCompile($) : 'unknown'
      let failure: { what: string; exitCode?: number; output: string } | null = typeof compiled === 'object' ? compiled : null
      const v = await verifyFor($)
      let isChecked = compiled !== 'unknown'
      if (!failure && v.command && !v.isAllowed) {
        // never run on the file's say-so: the person allows this exact command once, in the pane
        const was = await read($, verifyA)
        if (!v.isRefused && !(was.state === 'ask' && was.command === v.command)) {
          await update($, verifyA, () => ({ state: 'ask' as const, command: v.command }))
          $.ui.toast(`Command Deck can run "${v.command}" after code changes. Allow it in the pane.`)
        }
      } else if (!failure && v.isAllowed) {
        isChecked = true
        await update($, verifyA, () => ({ state: 'running' as const, command: v.command }))
        try {
          const r = await $.process.run(['/bin/sh', '-c', v.command], { cwd: rootDir() || undefined, timeoutMs: 600_000 })
          if (r.exitCode !== 0) failure = { what: v.command, exitCode: r.exitCode, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
        } catch (err) {
          failure = { what: v.command, output: `did not finish: ${String((err as Error)?.message ?? err)}` }
        }
      }
      if (failure) await verifyFailed($, failure)
      else if (isChecked) await verifyPassed($, v.isAllowed ? v.command : 'Unity compile')
      else if (isForced && !v.command) $.ui.toast('No verify command yet: /command-deck verify <command> sets one.')
    } while (verifyAgain)
  } finally {
    isVerifying = false
  }
}

async function verifyPassed($: any, what: string) {
  await update($, verifyA, () => ({ state: 'pass' as const, command: what }))
  verifyNote = ''
  // a passing check is the smoke test: its card closes once it is the only work left
  const now = await $.clock.now()
  const tasks = await read($, tasksA)
  const open = tasks.filter(t => t.status === 'todo' || t.status === 'doing')
  if (what !== 'Unity compile' && open.length === 1 && /^smoke test run/i.test(open[0]!.title)) {
    await update($, tasksA, (l: Task[]) => l.map(t => (t.id === open[0]!.id ? { ...L.setCard(t, 'done', now), note: 'verify passed' } : t)))
    await save($)
    await writeProgress($)
  }
}

async function verifyFailed($: any, f: { what: string; exitCode?: number; output: string }) {
  const text = L.verifyFailText(f.what, f.exitCode, f.output)
  await update($, verifyA, () => ({ state: 'fail' as const, command: f.what, note: f.output.trim().split('\n').filter(Boolean).pop()?.slice(0, 120) }))
  const isBusy = isTurnLive || isRunning || isCompacting
  if (verifySends < L.VERIFY_MAX_SENDS && !isBusy) {
    verifySends += 1
    $.ui.toast(`Verify failed: ${f.what}. Sent back to the model.`)
    await $.prompt.submit({ text }).catch(() => {
      verifyNote = text
    })
  } else {
    // sent back twice already, or a turn is running: the next typed message carries it
    verifyNote = text
    $.ui.toast(verifySends >= L.VERIFY_MAX_SENDS ? `Verify still fails after ${L.VERIFY_MAX_SENDS} tries: ${f.what}. It rides with your next message.` : `Verify failed: ${f.what}. It rides with your next message.`)
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
  hasGraft = await $.fs.exists(`${DIR.replace(/\.claude\/deck$/, '')}graft/INDEX.md`).catch(() => false)
  try {
    VERSION = String(JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))).version ?? '')
  } catch {
    /* no version shown */
  }
  effortTrust = ((await $.store.get('deck.effortTrust').catch(() => undefined)) as Record<string, L.EffortTrust> | undefined) ?? {}
  graftNudges = 0
  lastStep = {}
  isCavemanOff = false
  isUnity = await $.fs.exists(`${rootDir()}ProjectSettings/ProjectVersion.txt`).catch(() => false)
  guards = L.parseGuards(await readFile($, `${DIR}/guards.md`))
  projectNotes = L.projectSection(await readFile($, memoryFile()), await readFile($, `${DIR}/conventions.md`))
  rulesSent.clear()
  fails.clear()
  unityMisses = 0
  playClearAt = 0
  editedTurn = false
  csEditedTurn = false
  verifySends = 0
  verifyNote = ''
  turnSent = undefined
  statsDay = L.dayKey(await $.clock.now())
  const stats = ((await $.store.get(`deck.effortStats.${statsDay}`).catch(() => undefined)) as Record<string, L.EffortStat> | undefined) ?? {}
  await update($, effortStatsA, () => stats)
  const tasks = ((await $.store.get('deck.tasks')) as Task[] | undefined) ?? []
  const goal = ((await $.store.get('deck.goal')) as string | undefined) ?? ''
  // questions are never carried into a new session: they would cling to the pane and ask what was answered
  const pending = null as Pending | null
  await $.store.set('deck.pending', null).catch(() => undefined)
  const savings = { ...L.ZERO_SAVINGS, ...((await $.store.get(await savingsKey($))) as Partial<Savings> | undefined) }
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
  await syncSpin($)
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
// the frame clock runs only while a card is Doing: a board of Todo cards alone has nothing to animate
async function syncSpin($: any) {
  if ((await read($, tasksA)).some(t => t.status === 'doing')) startSpin($)
  else if (!isRunning) stopSpin()
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

/** A plan's steps as the board shows them: the review step for a risky plan, then the smoke test for one that changes code. */
const planSteps = (plan: Plan) => L.withSmokeTask(L.withReviewTask(plan.tasks, plan, opt('freshReview', 1) > 0), plan.code, isUnity && plan.csharp === true)

async function analyze($: any, ask: string, answers: string[], questions: string[] = [], media = 0): Promise<Plan | null> {
  for (const model of ['haiku', 'sonnet']) {
    const r = await $.model.complete({
      model,
      system: L.PLANNER_SYSTEM,
      prompt: L.plannerPrompt(ask, answers, questions, recent, media),
      maxTokens: 1500,
      effort: model === 'haiku' ? 'medium' : 'low',
      // the message waits for this call, so a slow planner is cut short and the message goes out unplanned
      timeoutMs: model === 'haiku' ? 20000 : 30000,
    })
    if (r.isAnswered) {
      await addUsage($, model, { ...r.usage, model })
      const plan = L.parsePlan(r.text)
      if (plan) return plan
    }
  }
  return null
}

/** Closes the open cards the turn's answer settles, when the main chat left out its Done:/Skip: lines. */
async function judgeBoard($: any, answer: string, open: Task[]): Promise<void> {
  try {
    const r = await $.model.complete({ model: 'haiku', system: L.JUDGE_SYSTEM, prompt: L.judgePrompt(answer, open), maxTokens: 200, effort: 'low', timeoutMs: 30000 })
    if (!r.isAnswered) return
    await addUsage($, 'haiku', { ...r.usage, model: 'haiku' })
    const marks = L.parseJudge(r.text, open)
    if (!marks.done.length && !marks.skip.length) return
    const now = await $.clock.now()
    // only the same cards, still in Todo: a new plan reuses ids, and a subagent may have picked one up meanwhile
    const asked = (t: Task) => t.status === 'todo' && open.some(o => o.id === t.id && o.title === t.title)
    await update($, tasksA, (l: Task[]) =>
      l.map(t => (!asked(t) ? t : marks.done.includes(t.title) ? L.setCard(t, 'done', now) : marks.skip.includes(t.title) ? L.setCard(t, 'skipped', now) : t)),
    )
    if (!(await read($, tasksA)).some(t => t.status === 'todo')) isAutoBoard = false
    await save($)
    await writeProgress($)
  } catch (err) {
    $.ui.log(`[command-deck] board judge failed: ${String((err as Error)?.message ?? err)}`)
  }
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
  const steps = planSteps(plan)
  const tasks: Task[] = steps.map((t, i) => ({ id: i + 1, title: t.title, tier: t.tier, why: t.why, parallel: t.parallel, status: 'todo', tokens: 0 }))
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
  let memory = ''
  try {
    if (await $.fs.exists(memoryFile())) memory = String(await $.fs.read(memoryFile()))
  } catch {
    /* no memory yet */
  }
  try {
    const r = await $.model.fork({ prompt: L.handoffAsk(await read($, goalA), await read($, tasksA), L.memoryFacts(memory)) })
    if (r.isAnswered) {
      const split = L.splitFacts(r.text)
      summary = split.note
      if (split.facts.length) {
        memory = L.mergeFacts(memory, split.facts)
        await $.fs.write(memoryFile(), memory)
      }
    }
  } catch {
    /* the note still carries the goal, rules, board and repo state */
  }
  await $.fs.write(
    path,
    L.handoffMarkdown({
      summary,
      memory,
      goal: await read($, goalA),
      tasks: await read($, tasksA),
      rules: await rulesText($),
      git: await read($, gitA),
      date: L.dayKey(now),
      contextPct: limits.ctxPct,
      lastAnswer: L.clip(lastAnswer, 4000),
    }),
  )
  await writeProgress($)
  return `Handoff written to ${path}.\nIn a new chat, send:\n  ${L.freshPrompt(path)}`
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
    sv => !L.KEEP_SERVERS.includes(L.norm(sv.server)) && !needed.has(L.norm(sv.server)) && !usedServers.has(L.norm(sv.server)) && !lower.includes(sv.server.toLowerCase()) && !lower.includes(L.norm(sv.server).replace(/_/g, ' ')),
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

// A new chat that already knows where things stand: write the handoff, clear the conversation, and send the
// first prompt of the fresh chat for the person.
async function fresh($: any, carry?: string): Promise<string> {
  $.ui.toast('Writing the handoff…')
  isFreshDue = false
  const shed = (await read($, limitsA)).ctxTokens ?? 0
  const note = await handoff($)
  const path = /Handoff written to (\S+)\./.exec(note)?.[1] ?? `${DIR}/`
  const first = L.freshPrompt(path, carry)
  // the handoff holds the findings of this chat; list it in the history so it can be found later
  await addHistory($, `Handoff saved: ${path}`, shed)
  const ask: CleanAsk = { path, first, carry, shed }
  return runClean($, ask)
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

async function runClean($: any, ask: CleanAsk): Promise<string> {
  try {
    await $.command.run({ command: 'clear', args: '' })
    await addSaving('fresh', ask.shed, $)
    deferServers = new Set()
    usedServers.clear()
    rulesSent.clear()
    fails.clear()
    verifyNote = ''
    graftNudges = 0
    isCavemanOff = false
    turnEffort = undefined
    lastStep = {}
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
  recent.push(`${role}: ${L.clip(t, max)}`)
  while (recent.length > Math.max(0, opt('plannerChatMessages', 8))) recent.shift()
}
const HUMAN = new Set(['composer', 'bridge', 'sdk'])

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

// Every typed message passes here. A cheap Haiku pass decides: ask first (the message is
// held back and the questions shown), plan (a short plan rides along as context the person never sees), or
// nothing worth adding (the message goes through untouched). Short messages and slash commands skip it.
async function autoPlan($: any, e: any): Promise<string | 'drop' | null> {
  const isPanel = fromPanel
  fromPanel = false
  if (!isPanel && !HUMAN.has(String(e.origin?.kind))) return null
  const text = String(e.text ?? '').trim()
  const pending = await read($, pendingA)
  // a slash command is its own work: it runs at the session's level, not the level of the request before it
  if (text.startsWith('/')) {
    turnEffort = undefined
    return null
  }
  namedLevel = L.namedEffort(text)
  if (L.CAVEMAN_OFF.test(text)) isCavemanOff = true
  if (pending && L.GO_WORDS.test(text)) {
    await update($, pendingA, () => null)
    return `The person skipped the questions; go ahead with the original request: ${pending.ask}`
  }
  // a short follow-up ("yes", "go on") continues the work, so it keeps that work's effort level
  if (!pending && text.length < 30) {
    remember('User', text)
    return null
  }
  // a plain question is answered in chat: no plan would be attached, so the planner call and its wait are skipped
  if (!pending && L.isPlainQuestion(text)) {
    turnEffort = undefined
    remember('User', text)
    return null
  }
  const ask = pending ? pending.ask : text
  const answers = pending ? [...pending.answers, text] : []
  const media = Array.isArray(e.attachments) ? e.attachments.length : 0
  const plan = await analyze($, ask, answers, pending ? pending.questions : [], media)
  turnEffort = plan?.effort
  if (!plan) {
    await update($, pendingA, () => null)
    await save($)
    remember('User', text)
    return null
  }
  if (L.mayAsk(plan, Boolean(pending), media)) {
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
  const steps = planSteps(plan)
  const tasks: Task[] = steps.map((t, i) => ({ id: i + 1, title: t.title, tier: t.tier, why: t.why, parallel: t.parallel, status: 'todo', tokens: 0 }))
  await archive($)
  await update($, tasksA, () => tasks)
  await update($, goalA, () => plan.prompt)
  agentTask.clear()
  mainTask = null
  isAutoBoard = true
  await save($)
  await writeProgress($)
  const extra = pending ? `\nOriginal request: ${pending.ask}\nThe message above answers the questions that were asked.` : ''
  try {
    const logPath = `${DIR}/rules-log.md`
    const prev = (await $.fs.exists(logPath)) ? String(await $.fs.read(logPath)) : ''
    const picks = G.pickForPlan(plan).map(p => `step ${p.step} [${p.tier}]: ${p.sections.length ? `core+${p.sections.join(',')}` : 'core'}`)
    const logLine = `${new Date(await $.clock.now()).toISOString()} ${picks.join('; ')}`
    await $.fs.write(logPath, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + logLine + '\n')
  } catch {
    /* logging is best effort */
  }
  // Unity projects only, and only when a step writes C# (planContext checks that); the main chat then has the rules
  if (isUnity && plan.csharp !== false) rulesSent.add('main|unity')
  return L.planContext(plan, { unity: isUnity, added: steps.slice(plan.tasks.length) }) + extra
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
  cfg = (options ?? {}) as Record<string, unknown>;

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'command-deck', description: 'Command Deck: board, usage, git. Subcommands: run, fresh, handoff, compact, done N, clear', argumentHint: '[run|fresh|handoff|compact|done N|clear]' })
    await $.command.register({ name: 'command-deck-plan', description: 'Sharpen a request, ask what is unclear, split it into tasks per model', argumentHint: '<what you want done>' })
    await load($)
    // autoStart (setting, default on): every new chat opens the deck pane
    if (opt('autoStart', 1) > 0) void $.ui.open({ id: PANE, title: 'Command Deck' })
    void refreshGit($)
    void refreshUsage($)
    void refreshRtk($, true)
    $.clock.every(30_000, () => void refreshGit($))
    // RTK's figure moves only when a command ran, so it is read after each turn; this slow tick covers idle changes
    $.clock.every(120_000, () => void refreshRtk($))
    $.clock.every(60_000, () => void warmTick($))
    await update($, tipA, () => Math.floor(Math.random() * L.TIPS.length))
    $.clock.every(L.TIP_ROTATE_MS, () => void update($, tipA, (n: number) => n + 1))
    return next(e)
  })

  // ------------------------------------------------------------ commands
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
      case 'verify': {
        const command = rest.join(' ').trim()
        if (command) {
          await $.fs.write(`${DIR}/verify.txt`, `# Command Deck runs this after code changes (first line that is not a comment)\n${command}\n`)
          // allowed as it is set only when the person typed it; a command another plugin or a script ran is asked for in the pane
          if (e.origin?.kind === 'composer') {
            const ok = ((await $.store.get('deck.verifyOk').catch(() => undefined)) as Record<string, string> | undefined) ?? {}
            await $.store.set('deck.verifyOk', { ...ok, [DIR]: command })
          }
          void runVerify($, true).catch(() => undefined)
          return { text: `Verify set: ${command}. It runs after each turn that changes files; a failure goes back to the model.` }
        }
        void runVerify($, true).catch(() => undefined)
        return { text: 'Running the verify check now. Set one with /command-deck verify <command>.' }
      }
      case 'conventions':
        void $.clock.after(50, () => void $.prompt.submit({ text: L.CONVENTIONS_ASK }).catch(() => undefined))
        return { text: 'Asking for a scan of the project. New chats start with what it writes to .claude/deck/conventions.md.' }
      case 'clear':
        await archive($)
        await update($, tasksA, () => [])
        await update($, goalA, () => '')
        await update($, pendingA, () => null)
        await save($)
        return { text: 'Board cleared.' }
      default:
        return { text: 'Subcommands: verify [command], conventions, warm [on|off], tools [on|off], run, fresh (handoff + new chat), handoff, compact, done N, clear. Also /command-deck-plan <ask>.' }
    }
  })

  // ------------------------------------------------------------ prompt shaping
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const extra: { id: string; text: string; scope: 'session' }[] = [
      { id: 'command-deck:house', text: L.houseSection({ graft: hasGraft }), scope: 'session' },
      { id: 'command-deck:clean-code', text: G.CORE, scope: 'session' },
      ...(opt('caveman', 1) > 0 ? [{ id: 'command-deck:caveman', text: L.CAVEMAN_SECTION, scope: 'session' as const }] : []),
      // read once at session start, so the text is the same on every turn of the chat and stays in the prompt cache
      ...(projectNotes ? [{ id: 'command-deck:project', text: projectNotes, scope: 'session' as const }] : []),
    ]
    return { ...out, sections: [...out.sections, ...extra] }
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
    const isBusy = isTurnLive || isRunning || isCompacting || agentTask.size > 0
    if (L.freshGate({ isDue: isFreshDue, isHuman: HUMAN.has(String(e.origin?.kind)), text: e.text, isBusy })) {
      const carry = e.text
      isCompacting = true
      $.clock.after(100, () => {
        void fresh($, carry)
          .then(t => $.ui.toast(t))
          .catch(() => undefined)
          .finally(() => {
            isCompacting = false
            lastTouch = 0
            coldWarned = false
          })
      })
      return { drop: 'Context is big: moving to a fresh chat with a handoff. Your message goes with it.' }
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
    // a named level belongs to the message that named it
    namedLevel = undefined
    try {
      planned = await autoPlan($, e)
    } catch {
      planned = null
    }
    if (planned === 'drop') return { drop: lastQuestions || 'Command Deck needs more details first. Reply with them, or "go" to skip.' }
    isTurnLive = true
    graftUsedTurn = false
    graftNudgedTurn = false
    if (!e.text.startsWith('/')) await decideTools($, e.text).catch(() => undefined)
    const added = [...(planned ? [planned] : [])]
    if (HUMAN.has(String(e.origin?.kind)) && !e.text.startsWith('/')) {
      // a typed message is a new request: the failure it has not seen rides along, and the send count starts over
      verifySends = 0
      if (verifyNote) added.push(verifyNote)
      verifyNote = ''
    }
    // every typed message carries the caveman line: beside the newest message it holds where the system prompt fades
    if (!isCavemanOff && opt('caveman', 1) > 0 && HUMAN.has(String(e.origin?.kind)) && !e.text.startsWith('/')) added.push(L.CAVEMAN_REMINDER)
    if (added.length) return next({ ...e, context: [...(e.context ?? []), ...added] })
    return next(e)
  })

  // Effort routing: the main loop's requests go out at the level the planner picked for this request. Subagents keep
  // their own level (lowering it cost answers in the effortless benchmark). A model that re-bills the conversation on
  // a level change is found on the first changed request and left alone from then on.
  on('turn.step', async function* ($, e, next) {
    let level: L.Effort | undefined
    let family = ''
    let isJudged = false
    // a failure here must never hold a model request back: the request then goes out as the engine made it
    try {
      const mode = opt('autoEffort', 1)
      if (!(e as { agentId?: string }).agentId && mode > 0) {
        const limits = await read($, limitsA)
        family = L.modelBucket(e.model)
        const savePct = opt('saveModePct', 80)
        const isSaving = savePct > 0 && Math.max(limits.fiveHour?.pct ?? 0, limits.sevenDay?.pct ?? 0) >= savePct
        const session = typeof e.effort === 'string' ? e.effort : undefined
        const routed = L.routedEffort({ want: turnEffort, named: namedLevel, session, mode, isSaving })
        const prev = lastStep[family]
        const sending = L.stepEffort({ routed, session, trust: effortTrust[family], ctxTokens: limits.ctxTokens ?? 0, prev })
        level = sending === session ? undefined : L.asEffort(sending)
        // judged only on a warm cache: a cold one writes the prefix again whatever the level
        isJudged = prev !== undefined && prev.sent !== sending && lastTouch > 0 && (await $.clock.now()) - lastTouch < opt('cacheTtlMin', 60) * 60_000
        lastStep = { ...lastStep, [family]: { sent: sending, session } }
        turnSent = sending
        if ((await read($, effortA)) !== (level ?? '')) await update($, effortA, () => level ?? '')
      }
    } catch {
      level = undefined
      isJudged = false
    }
    const r = yield* next(level ? { ...e, effort: level } : e)
    const trust = L.nextTrust(effortTrust[family], isJudged ? L.effortVerdict(r?.usage) : undefined)
    if (trust !== effortTrust[family]) {
      effortTrust = { ...effortTrust, [family]: trust }
      await $.store.set('deck.effortTrust', effortTrust).catch(() => undefined)
      if (trust === 'bad') $.ui.toast(`Effort routing is off for ${family}: two level changes each made it write the conversation to the cache again.`)
    }
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const nextTodo = isAutoBoard ? (await read($, tasksA)).find(t => t.status === 'todo') : undefined
    const wantsHaiku = !e.model && (String(e.subagentType) === 'Explore' || (nextTodo?.tier === 'haiku' && String(e.subagentType) !== 'Plan'))
    // a fork or a teammate carries its own context and a workflow agent its script's prompt: those are left as written
    // and a resumed agent's prompt is the message it is woken with, empty meaning none
    const spawn = e as typeof e & { isTeammate?: true; workflow?: unknown; resume?: unknown }
    const isPlain = !spawn.fork && !spawn.isTeammate && !spawn.workflow && !spawn.resume
    const isReader = ['Explore', 'Plan'].includes(String(e.subagentType))
    const brief = `${String(e.description ?? '')} ${String(e.prompt ?? '')}`
    // a subagent that will touch C# gets the Unity rules in its own prompt: before it writes, and at no cost in output
    // (an agent that only reads writes no code, so it gets none)
    const unity = isPlain && !isReader && isUnity && /\.cs\b|\bC#|\bcsharp\b|MonoBehaviour/i.test(brief) ? `\n\n${G.unityRules(brief)}` : ''
    const suffix = isPlain && opt('briefReports', 1) > 0 ? L.BRIEF_SUFFIX : ''
    const input = { ...e, ...(wantsHaiku ? { model: 'haiku' } : {}), ...(unity || suffix ? { prompt: `${e.prompt}${unity}${suffix}` } : {}) }
    const res = (await next(input)) as { model?: string; agentId?: string; deny?: unknown }
    if (unity && res?.agentId) rulesSent.add(`${res.agentId}|unity`)
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
    // a tool's arguments sit on the event beside `tool` (e.command for Bash), not under an `input` key
    const args = e as unknown as { todos?: unknown; subject?: unknown; taskId?: unknown; status?: unknown; command?: unknown; file_path?: unknown; notebook_path?: unknown }
    const agent = String((e as { agentId?: string }).agentId ?? 'main')
    const path = String(args.file_path ?? args.notebook_path ?? '')
    const ext = L.isFileEdit(tool) ? L.extOf(path) : ''
    // the project's own guards: a command a rule names is refused with the rule's reason
    if (tool === 'Bash') {
      const guard = L.guardFor(guards, args.command)
      if (guard) return { deny: L.guardDeny(guard) } as never
    }
    // Unity: a script is never edited while the editor plays. "Not playing" is trusted for a few seconds; "playing" never
    if (ext === 'cs' && isUnity && opt('unityPlayGuard', 1) > 0) {
      const now = await $.clock.now()
      if (now - playClearAt > 15_000) {
        // an editor that does not answer in time is not held to be playing: the edit goes through
        const state = await askUnity($, { tool: L.UNITY_STATE_TOOL }, 4000)
        if (state !== null && L.unityIsPlaying(state)) return { deny: L.UNITY_PLAY_DENY } as never
        if (state !== null) playClearAt = now
      }
    }
    if (isAutoBoard && !isRunning && !(e as { agentId?: string }).agentId && mainTask === null && agentTask.size === 0 && tool !== 'Agent') {
      mainTask = (await beginTask($, null))?.id ?? null
      if (mainTask !== null) startSpin($)
    }
    // The board follows the model's own task list: TodoWrite sends the whole list with statuses, TaskCreate one new task,
    // TaskUpdate a status change. New titles become cards, and a card moves forward when its task starts or is completed.
    let created: string | undefined
    if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') {
      try {
        const now = await $.clock.now()
        const listed = tool === 'TodoWrite' ? args.todos : tool === 'TaskCreate' ? [{ content: args.subject }] : []
        const add = L.newTodoTitles(listed, (await read($, tasksA)).map(t => t.title))
        if (tool === 'TaskCreate') created = add[0] ?? String(args.subject ?? '')
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
          const title = modelTasks.get(String(args.taskId))
          const to = L.statusOfTask(args.status)
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
    // what the model reads right after this result: each note is given once, where it is needed
    const notes: string[] = []
    const got = res as { deny?: unknown; isError?: boolean; text?: string; context?: readonly string[] }
    try {
      if (L.serverOfTool(tool) === 'graphify' || (tool === 'Bash' && L.isGraphifyQuery(args.command))) {
        await addSaving('graphify', opt('graphifyTokensPerCall', 1200), $)
      }
      const command = args.command
      // graft answers the same way through its MCP tools and its CLI, so both are counted
      if (tool.startsWith('mcp__graft__') || (tool === 'Bash' && L.isGraftCli(command))) {
        graftUsedTurn = true
        await addSaving('graft', L.parseGraftSaved(got.text), $)
      } else if (hasGraft && !graftUsedTurn && !graftNudgedTurn && graftNudges < L.GRAFT_NUDGE_MAX && L.isTextSearch(tool, command) && !got.deny) {
        // a plain text search while graft sat unused: say so once, after the result, where the model reads it next
        graftNudgedTurn = true
        graftNudges += 1
        notes.push(L.GRAFT_NUDGE)
      } else if (tool.startsWith('mcp__token-optimizer__smart_')) {
        await addSaving('optimizer', opt('optimizerTokensPerCall', 1200), $)
      }
      if (ext && !got.deny && !got.isError) {
        // a file changed: the verify gate runs when the turn ends
        editedTurn = true
        if (ext === 'cs') csEditedTurn = true
        // rules for this file type, once per agent: the project's own file, and the Unity rules for a script
        if (!rulesSent.has(`${agent}|${ext}`)) {
          rulesSent.add(`${agent}|${ext}`)
          const own = L.clip((await readFile($, `${DIR}/rules-${ext}.md`)).trim(), 3000)
          const unity = ext === 'cs' && isUnity && !rulesSent.has(`${agent}|unity`) ? G.unityRules(path) : ''
          if (unity) rulesSent.add(`${agent}|unity`)
          const rules = [unity, own].filter(Boolean).join('\n')
          if (rules) notes.push(`Rules for .${ext} files in this project (given once; check the edit you just made against them and fix what breaks one):\n${rules}`)
        }
      }
      // the same call failing the same way, three times running: say so once
      if (got.isError) {
        const key = L.failureKey(tool, got.text)
        const last = fails.get(agent)
        const n = last?.key === key ? last.n + 1 : 1
        fails.set(agent, { key, n })
        if (n === L.STUCK_AFTER) notes.push(L.STUCK_NUDGE)
      } else if (!got.deny) {
        fails.delete(agent)
      }
    } catch {
      /* counting and notes never break a tool call */
    }
    // a refusal carries no notes: its own text is what the model reads
    return notes.length && !got.deny ? ({ ...res, context: [...(got.context ?? []), ...notes] } as typeof res) : res
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    const usage = e.usage
    if (!e.agentId) {
      isTurnLive = false
      // the turn changed files and ended with an answer: the project's check runs in the background
      // an aborted or failed turn keeps the mark, so the check still runs when the work does end
      if (editedTurn && ((e as { reason?: string }).reason ?? 'answer') === 'answer') {
        editedTurn = false
        void runVerify($).catch(() => undefined)
      }
      if (turnSent && usage) {
        const level = turnSent
        const day = L.dayKey(await $.clock.now())
        const stats = await update($, effortStatsA, (m: Record<string, L.EffortStat>) => L.addEffortStat(day === statsDay ? m : {}, level, usage.output_tokens ?? 0))
        statsDay = day
        await $.store.set(`deck.effortStats.${day}`, stats).catch(() => undefined)
      }
      // a turn that made no request of its own is not counted under the last one's level
      turnSent = undefined
      lastAnswer = String((e as { answer?: string }).answer ?? '')
      // board lines (Done:/Skip:) would fill the kept tail, where an answer's offer or fix list sits
      remember('Assistant', lastAnswer.replace(/^(Todo|Done|Skip): .*$/gm, ''), 1200)
      lastTouch = await $.clock.now()
      lastReal = lastTouch
      coldWarned = false
      void refreshRtk($)
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
      const open = left.filter(t => t.status === 'todo')
      // in the background: the answer is already on screen, and a slow or failed call only leaves the cards as they were
      const answer = String((e as { answer?: string }).answer ?? '')
      // an empty answer (a tool-only turn) settles nothing, so the judge is not called
      if (open.length && answer.trim() && (e as { reason?: string }).reason === 'answer' && opt('judgeBoard', 1) > 0) void judgeBoard($, answer, open)
    }
    if (!e.agentId && usage && L.toolAvailable('ponytail', undefined, undefined, 0, (await read($, limitsA)).skills)) {
      await addSaving('ponytail', L.cavemanSaved(usage.output_tokens ?? 0, opt('ponytailRatio', 0.45)), $)
    }
    if (!e.agentId && usage && opt('caveman', 1) > 0 && !isCavemanOff) {
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
    // at the set share of the window, the next typed message moves to a small fresh chat and goes there; clearing
    // right here would wipe an answer the person has not read yet, or cut work that is still going
    const freshPct = opt('autoFreshPct', 50)
    if (freshPct > 0 && !isFreshDue && !e.agentId && ctx.ctxPct >= freshPct) {
      isFreshDue = true
      $.ui.toast(`Context at ${Math.round(ctx.ctxPct)}%: your next message starts a fresh chat with a handoff and goes there.`)
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
  // Layout rule: nothing is counted in characters. Columns are Boxes with a width, bars are Boxes with a background
  // (the engine draws its own Progress that way), and text wraps or truncates in the room the layout gives it. So the
  // pane holds at any width and in a proportional font, where a row of block characters did not.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [tasks, usage, savings, git, limits, frame, tip, goal, pending, draft, mins, savedOrder, hist, answered, rtk, isArranging, effort, verify, effortStats] = await Promise.all([
      read($, tasksA),
      read($, usageA),
      read($, savingsA),
      read($, gitA),
      read($, limitsA),
      read($, frameA),
      read($, tipA),
      read($, goalA),
      read($, pendingA),
      read($, draftA),
      read($, minA),
      read($, orderA),
      read($, histA).catch(() => [] as Hist[]),
      read($, answeredA),
      read($, rtkA),
      read($, arrangeA),
      read($, effortA),
      read($, verifyA),
      read($, effortStatsA),
    ])
    const Input = ($.ui.resolve(e) as any).Input as ((p: Record<string, unknown>) => any) | undefined
    const now = await $.clock.now()
    const props = e.props as { bodyColumns?: number; placement?: string }
    // a hint only: what to leave out when the pane is narrow, and how many cells a bar gets; no width is computed from it
    const cols = Number(props?.bodyColumns) || 60
    const isNarrow = cols < 44
    const isTerminal = e.surface === 'terminal'
    const isStill = opt('reducedMotion', 0) > 0
    // one label column for every row, so values line up down the whole pane
    const LBL = 10

    // a row of cells: each a Box the layout sizes, holding one block glyph (so a bar cannot wrap into a second line)
    const cellRow = (key: string, cells: { color?: string; isDim?: boolean }[], grow = 1) => (
      <Box key={key} width={0} flexGrow={grow} overflow="hidden">
        {cells.map((c, i) => (
          <Box key={`${key}-${i}`} width={0} flexGrow={1} overflow="hidden">
            <Text color={c.color ?? 'gray'} dimColor={c.isDim ?? !c.color}>
              {L.BAR_GLYPH}
            </Text>
          </Box>
        ))}
      </Box>
    )
    // a meter row's fixed parts: frame and padding 4, label and its gap 11, percent and its gap 5
    const meterCells = L.cellCount(cols - 20, isTerminal)
    const track = (key: string, fills: { pct: number; color: string }[]) => cellRow(key, L.barCells(fills, meterCells).map(color => ({ color })))
    const label = (text: string, color?: string) => (
      <Box width={LBL} flexShrink={0}>
        <Text color={color} bold={Boolean(color)} dimColor={!color} wrap="truncate-end">
          {text}
        </Text>
      </Box>
    )
    // one line per meter: label, bar, percent, tail. The bar and label wear the meter's own colour; for a limit, the
    // percent turns yellow then red as it nears the top
    const meter = (name: string, pct: number | undefined, tail: string, isLimit = false) => {
      const color = L.METER_COLORS[name] ?? L.METER_COLORS.Other!
      return (
        <Box key={`meter-${name}`} gap={1}>
          {label(name, color)}
          {pct === undefined ? (
            <Text dimColor>n/a</Text>
          ) : (
            [
              track(`track-${name}`, [{ pct, color }]),
              <Box key={`pct-${name}`} width={4} flexShrink={0} justifyContent="flex-end">
                <Text bold color={isLimit && pct >= 60 ? L.barColor(pct) : undefined}>{`${pct.toFixed(0)}%`}</Text>
              </Box>,
              tail && !isNarrow ? (
                <Box key={`tail-${name}`} flexShrink={0}>
                  <Text dimColor>{tail}</Text>
                </Box>
              ) : null,
            ]
          )}
        </Box>
      )
    }
    const field = (name: string, value: string, color?: string) => (
      <Box key={`field-${name}`} gap={1}>
        {label(name)}
        <Box flexGrow={1} flexShrink={1}>
          <Text color={color} bold={Boolean(color)} wrap="truncate-end">
            {value}
          </Text>
        </Box>
      </Box>
    )

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
    // a section: a coloured frame, its title and note, a fold button, and the move buttons while arranging
    const win = (icon: string, title: string, color: string, body: any, note?: string, slot?: string) => {
      const isMin = Boolean(mins[title])
      return (
        <Box key={`win-${title}`} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={isMin} paddingX={1}>
          <Box justifyContent="space-between" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold color={color} wrap="truncate-end">
                {icon} {title}
                {note ? <Text dimColor>{`  ${note}`}</Text> : null}
              </Text>
            </Box>
            <Box flexShrink={0}>
              {slot && isArranging ? <Button key={`up-${slot}`} label="▲" onPress={() => moveSlot(slot, -1)} /> : null}
              {slot && isArranging ? <Button key={`dn-${slot}`} label="▼" onPress={() => moveSlot(slot, 1)} /> : null}
              <Button key={`min-${title}`} label={isMin ? '▸' : '▾'} onPress={() => void toggleMin(title)} />
            </Box>
          </Box>
          {isMin ? null : body}
        </Box>
      )
    }

    // ---------------- the facts every placement shows
    const idleMin = lastTouch ? Math.max(0, Math.floor((now - lastTouch) / 60_000)) : 0
    const ttlMin = opt('cacheTtlMin', 60)
    // cache: an estimate from the clock (the server is never asked); it redraws with the pane's other refreshes
    const isColdNow = Boolean(lastTouch) && idleMin >= ttlMin && (limits.ctxTokens ?? 0) >= opt('coldMinTokens', 50_000)
    const warmLeft = warmUntil > now ? Math.round((warmUntil - now) / 60_000) : 0
    const cacheColor = isColdNow ? 'red' : warmLeft ? 'green' : 'yellow'
    const progress = L.boardProgress(tasks)
    const pctText = `${Math.round(progress.ratio * 100)}%`
    // the glance line: what would otherwise need three sections open
    const chips: { text: string; color: string }[] = [
      ...(limits.ctxWindow ? [{ text: `ctx ${limits.ctxPct.toFixed(0)}%`, color: L.barColor(limits.ctxPct) }] : []),
      ...(limits.fiveHour ? [{ text: `5h ${limits.fiveHour.pct.toFixed(0)}%`, color: L.barColor(limits.fiveHour.pct) }] : []),
      ...(limits.sevenDay ? [{ text: `week ${limits.sevenDay.pct.toFixed(0)}%`, color: L.barColor(limits.sevenDay.pct) }] : []),
      ...(lastTouch ? [{ text: `cache ${isColdNow ? 'cold' : 'warm'}`, color: cacheColor }] : []),
      ...(effort ? [{ text: `effort ${effort}`, color: 'cyan' }] : []),
      ...(verify.state === 'pass' ? [{ text: 'verify ✔', color: 'green' }] : verify.state === 'fail' ? [{ text: 'verify ✖', color: 'red' }] : verify.state === 'running' ? [{ text: 'verify …', color: 'yellow' }] : []),
      ...(limits.usd !== undefined ? [{ text: `$${limits.usd.toFixed(2)}`, color: 'white' }] : []),
    ]
    const glance = chips.length ? (
      <Text wrap="wrap">
        {chips.map((c, i) => (
          <Text key={`chip-${i}`}>
            {i ? <Text dimColor>{' · '}</Text> : null}
            <Text color={c.color}>{c.text}</Text>
          </Text>
        ))}
      </Text>
    ) : null

    // ---------------- board progress: one equal stretch per card, in the card's colour (equal growth from zero width)
    const inkOf = (i: number, status: Task['status']) => (status === 'failed' ? L.FAILED_COLOR : status === 'todo' ? undefined : L.cardColor(i))
    // the board row's fixed parts: frame and padding 4, percent and its gap 5. Every cell that fits is shared out among
    // the cards, and a card's group grows by its cell count, so all cells are one width and none is left as a gap
    const slices = L.boardSlices(tasks, L.cellCount(cols - 9, isTerminal)).filter(x => x.cells > 0)
    const progressBar = (
      <Box key="board-bar" gap={1}>
        <Box width={0} flexGrow={1} overflow="hidden">
          {slices.map(x =>
            cellRow(
              `slice-${x.card}`,
              x.status === 'doing'
                ? // the running stretch shimmers: a lit part sweeps across it, one cell per frame
                  L.shimmerMask(x.cells, frame, isStill).map(lit => ({ color: inkOf(x.card, x.status), isDim: !lit }))
                : Array.from({ length: x.cells }, () => ({ color: inkOf(x.card, x.status) })),
              x.cells,
            ),
          )}
        </Box>
        <Box flexShrink={0}>
          <Text bold color={L.gradientAt(progress.ratio)}>
            {pctText}
          </Text>
        </Box>
      </Box>
    )
    const botOf = (t: Task) => {
      const bot = L.workingBot(t.tier, frame, isStill)
      return (
        <Text bold>
          <Text color={L.TIER_COLOR[t.tier]}>{bot.face}</Text>
          <Text color={bot.sparkColor}>{bot.spark}</Text>{' '}
        </Text>
      )
    }

    // ---------------- minimized: the small form shows what reads at a glance, and no buttons (clicks may not reach it)
    if (props?.placement === 'widget') {
      const live = tasks.find(t => t.status === 'doing')
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="cyan" wrap="truncate-end">
            ◆ DECK
            {tasks.length ? <Text dimColor>{`  ${progress.done}/${progress.total} done`}</Text> : null}
          </Text>
          {tasks.length ? progressBar : null}
          {live ? (
            <Text wrap="truncate-end">
              {botOf(live)}
              {live.title}
            </Text>
          ) : null}
          {glance}
        </Box>
      )
    }

    // ---------------- header
    const header = (
      <Box key="header" flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Box justifyContent="space-between" flexWrap="wrap" columnGap={1}>
          <Text bold color="cyan" wrap="truncate-end">
            ◆ COMMAND DECK
            {VERSION ? <Text color="gray" bold={false}>{` v${VERSION}`}</Text> : null}
          </Text>
          <Box gap={1} flexShrink={0}>
            <Button key="fresh" label="⇢ Fresh chat" onPress={() => void fresh($).then(t => $.ui.toast(t))} />
            <Button key="arrange" label={isArranging ? '✔ Done' : '⠿ Arrange'} onPress={() => void update($, arrangeA, (isOn: boolean) => !isOn)} />
            {isArranging ? <Button key="reset-layout" label="↺ Reset" onPress={resetLayout} /> : null}
          </Box>
        </Box>
        {glance}
        {verify.state === 'ask' ? (
          // the command comes from a project file, so it runs only after the person allows this exact text
          <Box flexDirection="column">
            <Text wrap="wrap">
              Run <Text bold color="yellow">{verify.command}</Text> after code changes?
            </Text>
            <Box gap={1}>
              <Button key="verify-yes" label="Allow" onPress={() => void answerVerify($, verify.command, true)} />
              <Button key="verify-no" label="Never" onPress={() => void answerVerify($, verify.command, false)} />
            </Box>
          </Box>
        ) : verify.state === 'fail' ? (
          <Text color="red" wrap="truncate-end">
            ✖ {verify.command}
            {verify.note ? <Text dimColor>{`  ${verify.note}`}</Text> : null}
          </Text>
        ) : null}
      </Box>
    )

    // ---------------- usage
    const fiveTail = limits.fiveHour ? `↻ ${L.resetsIn(limits.fiveHour.resetsAt, now)}` : ''
    const weekTail = limits.sevenDay ? `↻ ${L.resetsIn(limits.sevenDay.resetsAt, now)}` : ''
    const ctxTail = limits.ctxWindow ? `${L.compact(limits.ctxTokens ?? 0)}/${L.compact(limits.ctxWindow)}` : ''
    const cacheText = !lastTouch
      ? 'no turn yet'
      : `${isColdNow ? 'cold' : 'warm'}, idle ${idleMin}m${warmLeft ? `, keep-warm ${warmLeft}m left` : ', keep-warm off'}`
    // the context bar split by where the tokens come from (the engine's own /context breakdown), biggest first
    // shown only when asked for (contextBreakdown): by default the Context row is one plain meter
    const segs = opt('contextBreakdown', 0) > 0 ? L.ctxSegments(limits.parts ?? [], limits.ctxWindow).sort((x, y) => y.tokens - x.tokens) : []
    const ctxBar = segs.length ? (
      <Box key="meter-Context" gap={1}>
        {label('Context', L.METER_COLORS.Context)}
        {track('track-Context', segs)}
        <Box width={4} flexShrink={0} justifyContent="flex-end">
          <Text bold color={limits.ctxPct >= 60 ? L.barColor(limits.ctxPct) : undefined}>{`${limits.ctxPct.toFixed(0)}%`}</Text>
        </Box>
        {isNarrow ? null : (
          <Box flexShrink={0}>
            <Text dimColor>{ctxTail}</Text>
          </Box>
        )}
      </Box>
    ) : null
    // one band per category, as many per line as fit; the colour is the band itself
    const ctxLegend = segs.length
      ? [
          <Box key="ctx-bands" flexWrap="wrap" columnGap={1}>
            {segs.map(x => (
              <Text key={`lg-${x.name}`} backgroundColor={x.color} color={L.ctxInk(x.color)}>
                {` ${x.name} ${L.compact(x.tokens)} `}
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
        meter('5-hour', limits.fiveHour?.pct, fiveTail, true),
        meter('Week', limits.sevenDay?.pct, weekTail, true),
        ctxBar ?? meter('Context', limits.ctxWindow ? limits.ctxPct : undefined, ctxTail, true),
        ...ctxLegend,
        field('Cache', cacheText, cacheColor),
        ...(opt('autoEffort', 1) > 0 ? [field('Effort', effort ? `${effort} for this request` : 'your own level', effort ? 'cyan' : undefined)] : []),
        // turns and mean output tokens per level today: a cheap level that ran long was a wrong pick
        ...(L.effortLine(effortStats) ? [field('Today', L.effortLine(effortStats))] : []),
      ],
      limits.usd !== undefined ? `session $${limits.usd.toFixed(2)}` : undefined,
      'USAGE',
    )

    // ---------------- models
    const shown = L.shares(usage)
    const modelsWin = win(
      '◉',
      'MODELS TODAY',
      'magenta',
      shown.every(s => s.tokens === 0) ? <Text dimColor>no turns counted yet</Text> : shown.map(s => meter(s.name, s.pct, L.compact(s.tokens))),
      undefined,
      'MODELS',
    )

    // ---------------- board
    // the running card's marker blinks; reducedMotion holds it lit (the bar's running stretch has its own shimmer)
    const isLit = isStill || frame % 2 === 0
    const mins2 = (t: Task) => (t.startedAt ? Math.max(0, Math.round(((t.endedAt ?? now) - t.startedAt) / 60_000)) : 0)
    const card = (t: Task) => {
      const tierColor = L.TIER_COLOR[t.tier]
      const icon = t.status === 'done' ? '✔' : t.status === 'failed' ? '✖' : t.status === 'skipped' ? '–' : '○'
      const iconColor = t.status === 'done' ? 'green' : t.status === 'failed' ? 'red' : 'gray'
      const took = t.status === 'doing' && mins2(t) > 0 ? `${mins2(t)}m` : t.status === 'done' && t.tokens > 0 ? L.compact(t.tokens) : ''
      return (
        <Text key={`card-${t.id}`} wrap="wrap">
          <Text color={inkOf(tasks.indexOf(t), t.status)} dimColor={t.status === 'todo' || (t.status === 'doing' && !isLit)}>
            {t.status === 'todo' ? '□' : '■'}{' '}
          </Text>
          {t.status === 'doing' ? (
            botOf(t)
          ) : (
            <Text color={iconColor} bold>
              {icon}{' '}
            </Text>
          )}
          <Text color={tierColor} bold>
            [{L.TIER_LABEL[t.tier]}]{' '}
          </Text>
          <Text dimColor={t.status === 'done' || t.status === 'skipped'}>{t.title}</Text>
          {took ? <Text dimColor>{`  ${took}`}</Text> : null}
        </Text>
      )
    }
    // a lane with no cards is left out; lanes sit side by side while there is room and stack when there is not
    const DONE_SHOWN = 6
    const lane = (title: string, color: string, list: Task[], cap = list.length) =>
      list.length === 0 ? null : (
        <Box key={`lane-${title}`} flexDirection="column" flexGrow={1} minWidth={isNarrow ? undefined : 26}>
          <Text bold color={color}>
            ▍{title} <Text dimColor>{list.length}</Text>
          </Text>
          {list.slice(-cap).map(card)}
          {list.length > cap ? <Text dimColor>{`  … ${list.length - cap} earlier`}</Text> : null}
        </Box>
      )
    const todo = tasks.filter(t => t.status === 'todo')
    const doing = tasks.filter(t => t.status === 'doing')
    const done = tasks.filter(t => t.status === 'done' || t.status === 'failed' || t.status === 'skipped')
    const boardWin = win(
      '▦',
      'BOARD',
      'yellow',
      <Box flexDirection="column">
        {progressBar}
        <Box flexWrap="wrap" columnGap={2}>
          {lane('DOING', 'cyan', doing)}
          {lane('TODO', 'yellow', todo)}
          {lane('DONE', 'green', done, DONE_SHOWN)}
        </Box>
      </Box>,
      `${done.length}/${tasks.length} done`,
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
    const gitNote = git ? `${git.branch}${dirty.length ? ` · ${dirty.length} changed` : ''}${git.ahead ? ` · ↑${git.ahead}` : ''}${git.behind ? ` · ↓${git.behind}` : ''}` : undefined
    const gitWin = win(
      '⎇',
      'GIT',
      'green',
      git ? (
        <Box flexDirection="column">
          {field('Branch', git.branch, 'magenta')}
          {field('Upstream', git.upstream || 'none', git.upstream ? 'green' : 'red')}
          {field('Sync', git.upstream ? (git.ahead || git.behind ? `↑${git.ahead}  ↓${git.behind}` : 'in sync') : '—', git.ahead || git.behind ? 'yellow' : 'green')}
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
      // the note keeps the facts in view while the section is folded
      gitNote,
      'GIT',
    )

    // ---------------- savings: every tool has a row and a plain state, so a tool that is off is never just missing
    const inPrice = opt('inputDollarsPerMTok', 3)
    const outPrice = opt('outputDollarsPerMTok', 15)
    const askInstall = (tools: L.ToolName[]) => void $.prompt.submit({ text: L.installPrompt(tools) })
    const DOT: Record<L.ToolState, { mark: string; color: string }> = { active: { mark: '●', color: 'green' }, inactive: { mark: '◐', color: 'yellow' }, missing: { mark: '○', color: 'gray' } }
    const saveRow = (name: string, tokens: number, price: number, state: L.ToolState = 'active', tool?: L.ToolName) => (
      <Box key={`save-${name}`} gap={1}>
        <Box flexShrink={0}>
          <Text color={DOT[state].color}>{DOT[state].mark}</Text>
        </Box>
        {label(name, state === 'active' ? 'white' : undefined)}
        {state === 'missing' ? (
          tool && L.TOOL_INFO[tool] ? (
            <Button key={`install-${tool}`} label="Install" onPress={() => askInstall([tool])} />
          ) : (
            <Text dimColor>not installed</Text>
          )
        ) : state === 'inactive' ? (
          <Text color="yellow">installed, not running</Text>
        ) : tokens > 0 ? (
          <Text wrap="truncate-end">
            <Text color="green" bold>
              {L.compact(tokens)}
            </Text>
            <Text dimColor>{`  ≈ $${((tokens * price) / 1_000_000).toFixed(2)}`}</Text>
          </Text>
        ) : (
          <Text dimColor>on</Text>
        )}
      </Box>
    )
    const graftState = L.toolState('graft', limits.servers, limits.skillTokens, savings.graft, limits.skills)
    const graphifyState = L.toolState('graphify', limits.servers, undefined, savings.graphify, limits.skills)
    const tokenEconState = L.toolState('tokeneconomizer', limits.servers, undefined, 0, limits.skills)
    const missing = (
      [['graft', graftState], ['graphify', graphifyState], ['tokeneconomizer', tokenEconState]] as [L.ToolName, L.ToolState][]
    )
      .filter(([, st]) => st === 'missing')
      .map(([t]) => t)
    const rtkSaved = rtk?.saved ?? 0
    const deckSaved = L.deckSaved(savings)
    const savedDollars = L.dollars(savings, inPrice, outPrice) + (rtkSaved * inPrice) / 1_000_000
    const savingsWin = win(
      '✚',
      'SAVED TODAY',
      'yellow',
      [
        saveRow('Deck', deckSaved, inPrice),
        deckSaved > 0 ? (
          <Text key="deck-parts" dimColor wrap="wrap">
            {`  routing ${L.compact(savings.routing)} · fresh chat ${L.compact(savings.fresh)} · keep-warm ${L.compact(savings.keepwarm)} · smart tools ${L.compact(savings.tools)}`}
          </Text>
        ) : null,
        // caveman is the deck's own text now: on whenever its option is on, with no skill to install or load
        saveRow('Caveman', savings.caveman, outPrice, opt('caveman', 1) > 0 ? 'active' : 'inactive'),
        saveRow('Graft', savings.graft, inPrice, hasGraft ? 'active' : graftState, 'graft'),
        saveRow('RTK', rtkSaved, inPrice, rtk?.state ?? 'missing'),
        saveRow('Optimizer', savings.optimizer, inPrice, L.toolState('optimizer', limits.servers, limits.skillTokens, savings.optimizer, limits.skills)),
        saveRow('Ponytail', savings.ponytail, outPrice, L.toolState('ponytail', undefined, undefined, savings.ponytail, limits.skills)),
        saveRow('Graphify', savings.graphify, inPrice, graphifyState, 'graphify'),
        saveRow('TokenEcon.', 0, inPrice, tokenEconState, 'tokeneconomizer'),
        missing.length > 1 ? <Button key="install-all" label={`Install all (${missing.length})`} onPress={() => askInstall(missing)} /> : null,
        <Box key="total" gap={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Total</Text>
          <Text color="magenta" bold>
            {L.compact(L.totalSaved(savings, rtkSaved))}
          </Text>
          <Text dimColor wrap="truncate-end">{`tokens  ≈ $${savedDollars.toFixed(2)} est.`}</Text>
        </Box>,
      ],
      `≈ $${savedDollars.toFixed(2)} est.`,
      'SAVED',
    )

    // ---------------- plan brief: the generated goal text, full and wrapped
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
                <Text color={it.status === 'failed' ? 'red' : it.status === 'skipped' ? 'gray' : 'green'} bold>
                  {it.status === 'failed' ? '✖' : it.status === 'skipped' ? '–' : it.status === 'handoff' ? '⇢' : '✔'}{' '}
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

    // ---------------- tip: one wrapped line of coloured words; the layout breaks it where the pane ends
    const tipText = L.TIPS[tip % L.TIPS.length] ?? ''
    const tipWin = win(
      '✦',
      'TIPS',
      'yellow',
      <Box flexDirection="column">
        <Text wrap="wrap">
          {tipText.split(/\s+/).map((w, i) => (
            <Text key={`tip-${i}`} italic color={L.TIP_COLORS[(i + tip) % L.TIP_COLORS.length]}>
              {w}{' '}
            </Text>
          ))}
        </Text>
        <Box gap={1} flexWrap="wrap">
          <Button key="tip-next" label="Next tip" onPress={() => update($, tipA, (n: number) => n + 1)} />
          <Button key="tip-learn" label="Learn more →" onPress={() => void learnMore($, tipText)} />
        </Box>
      </Box>,
      undefined,
      'TIPS',
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
        {tasks.length || pending ? null : (
          <Text dimColor wrap="wrap">
            {' '}Board is empty. Type what you want done: the deck plans it and fills the board.
          </Text>
        )}
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
