import { expect, mock, test } from 'claude-code/testing'

import * as G from './guidelines'
import * as L from './lib'
import type { Task } from '../types'

// the test runner has both; the mod runtime's types leave them out
declare const setTimeout: (fn: (...a: never[]) => void, ms: number) => unknown
declare const console: { log: (...a: unknown[]) => void }

test('parseJudge: closes only the asked cards, done wins over skip, junk marks nothing', () => {
  const open: Task[] = [
    { id: 1, title: 'Confirm /ws rate rule live in Cloudflare', tier: 'sonnet', why: '', status: 'todo', tokens: 0 },
    { id: 2, title: 'Smoke test prod /ws and /live', tier: 'haiku', why: '', status: 'todo', tokens: 0 },
  ]
  expect(L.parseJudge('{"done":[1],"skip":[2,9]}', open)).toEqual({ todo: [], done: [open[0]!.title], skip: [open[1]!.title] })
  expect(L.parseJudge('Sure! ```json\n{"done":[2],"skip":[2]}\n```', open)).toEqual({ todo: [], done: [open[1]!.title], skip: [] })
  expect(L.parseJudge('{"done":"1"}', open)).toEqual({ todo: [], done: [], skip: [] })
  expect(L.parseJudge('no json here', open)).toEqual({ todo: [], done: [], skip: [] })
  expect(L.parseJudge('{broken', open)).toEqual({ todo: [], done: [], skip: [] })
  expect(L.judgePrompt('All pushed.', open)).toContain('2: Smoke test prod /ws and /live')
})

test('routing: mechanical work goes to Haiku, risky work to Opus, the rest to Sonnet', () => {
  expect(L.tierOf('Rename the field mCount to mTotal')).toBe('haiku')
  expect(L.tierOf('Fix the typo in the settings label')).toBe('haiku')
  expect(L.tierOf('Add a daily streak popup with tests')).toBe('sonnet')
  expect(L.tierOf('Find the root cause of the intermittent race condition')).toBe('opus')
})

test('parsePlan: a clear plan keeps tiers and falls back for missing ones', () => {
  const raw = '```json\n{"isClear":true,"questions":[],"prompt":"Do X","tasks":[{"title":"Rename a var","tier":"haiku","why":"one place"},{"title":"Design the sync architecture"}]}\n```'
  const plan = L.parsePlan(raw)
  expect(plan?.isClear).toBe(true)
  expect(plan?.tasks.map(t => t.tier)).toEqual(['haiku', 'opus'])
})

test('parsePlan: questions mean not clear, junk is null', () => {
  const plan = L.parsePlan('{"isClear":false,"questions":["Which scene?"],"prompt":"","tasks":[]}')
  expect(plan?.isClear).toBe(false)
  expect(plan?.questions).toEqual(['Which scene?'])
  expect(L.parsePlan('no json here')).toBe(null)
})

test('model buckets and billed tokens ignore cache reads', () => {
  expect(L.modelBucket('claude-haiku-5-5')).toBe('Haiku')
  expect(L.modelBucket('claude-opus-5-5')).toBe('Opus')
  expect(L.billed({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3 })).toBe(18)
  const s = L.shares({ Haiku: 25, Sonnet: 75 })
  expect(Math.round(s.find(x => x.name === 'Sonnet')?.pct ?? 0)).toBe(75)
})

test('bar colours: a level picks green, yellow or red', () => {
  expect([L.barColor(10), L.barColor(70), L.barColor(90)]).toEqual(['green', 'yellow', 'red'])
})

test('models today: Fable is its own bucket, and gets a row only once it has tokens', () => {
  expect(L.modelBucket('claude-fable-5-2')).toBe('Fable')
  expect(L.modelBucket('claude-opus-5-5')).toBe('Opus')
  expect(L.modelBucket('something-else')).toBe('Other')
  expect(L.shares({ Sonnet: 10 }).map(s => s.name)).toEqual(['Haiku', 'Sonnet', 'Opus'])
  const withFable = L.shares({ Sonnet: 25, Fable: 75 })
  expect(withFable.map(s => s.name)).toEqual(['Haiku', 'Sonnet', 'Opus', 'Fable'])
  expect(withFable.find(s => s.name === 'Fable')?.pct).toBe(75)
})

test('graft saving is read from its own line; caveman saving follows the ratio', () => {
  expect(L.parseGraftSaved('[graft] tokens saved ≈ 12k\nrest')).toBe(12000)
  expect(L.parseGraftSaved('[graft] tokens saved ≈ 1,250')).toBe(1250)
  expect(L.parseGraftSaved('nothing')).toBe(0)
  expect(L.cavemanSaved(650, 0.35)).toBe(350)
})

test('git status parsing: branch, upstream, ahead/behind, dirty files', () => {
  const info = L.parseGit(
    '## internal-test/1.0021-t1...origin/internal-test/1.0021-t1 [ahead 2, behind 1]',
    '## x\n M a.cs\n?? b.md\n',
    'main|origin/main|\nfeature||',
  )
  expect(info.branch).toBe('internal-test/1.0021-t1')
  expect(info.upstream).toBe('origin/internal-test/1.0021-t1')
  expect(info.ahead).toBe(2)
  expect(info.behind).toBe(1)
  expect(info.dirty.length).toBe(2)
  expect(info.branches[1]?.upstream).toBe('')
})

test('handoff carries rules, repo state and only the open tasks as next steps', () => {
  const tasks = [
    { id: 1, title: 'Done thing', tier: 'haiku', why: '', status: 'done', tokens: 0 },
    { id: 2, title: 'Open thing', tier: 'sonnet', why: '', status: 'todo', tokens: 0 },
  ] as Task[]
  const md = L.handoffMarkdown({ goal: 'Ship it', tasks, rules: L.DEFAULT_RULES, git: null, date: '2026-10-13' })
  expect(md).toContain('Rules every new chat must follow')
  expect(md).toContain('- Open thing')
  expect(md.split('## Next steps')[1]).not.toContain('Done thing')
  expect(md).not.toContain('continue with the first open task')
  expect(md).not.toContain('## Last answer')
  const withAnswer = L.handoffMarkdown({ goal: 'Ship it', tasks, rules: '', git: null, date: '2026-11-02', summary: 'Answer given.', lastAnswer: 'Plan: route by room code.' })
  expect(withAnswer).toContain('## Last answer')
  expect(withAnswer).toContain('Plan: route by room code.')
  // what really happened comes before the deck's possibly stale plan
  expect(withAnswer.indexOf('## Last answer')).toBeLessThan(withAnswer.indexOf('## Goal'))
})

test('fresh chat: a carried message is done, otherwise the new chat reads and waits instead of starting tasks', () => {
  expect(L.freshPrompt('h.md', 'fix the deck')).toContain('Then do this:\n\nfix the deck')
  const bare = L.freshPrompt('h.md')
  expect(bare).toContain('wait for me')
  expect(bare).not.toContain('first open task')
})

test('fresh gate: only a typed, non-slash message while nothing runs starts the due fresh chat', () => {
  const base = { isDue: true, isHuman: true, text: 'next thing', isBusy: false }
  expect(L.freshGate(base)).toBe(true)
  expect(L.freshGate({ ...base, isDue: false })).toBe(false)
  expect(L.freshGate({ ...base, isHuman: false })).toBe(false)
  expect(L.freshGate({ ...base, isBusy: true })).toBe(false)
  expect(L.freshGate({ ...base, text: '/command-deck' })).toBe(false)
  expect(L.freshGate({ ...base, text: '   ' })).toBe(false)
})

test('clip keeps the head and the tail, where an answer puts its fix list', () => {
  expect(L.clip('short', 10)).toBe('short')
  const long = `start ${'x'.repeat(100)} fixes: a b c`
  const cut = L.clip(long, 40)
  expect(cut.length).toBeLessThanOrEqual(40)
  expect(cut.startsWith('start')).toBe(true)
  expect(cut.endsWith('a b c')).toBe(true)
})

test('planner rules: questions are answered in chat, and "fix it" means what the last answer proposed', () => {
  expect(L.PLANNER_SYSTEM).toContain('answered in chat, never built')
  expect(L.PLANNER_SYSTEM).toContain('points back at the chat')
  // a question plan is one Sonnet step, so it is not attached and the board and goal stay as they were
  const q = L.parsePlan('{"isClear":true,"questions":[],"prompt":"Answer","code":false,"tasks":[{"title":"Answer in chat","tier":"sonnet","why":"question"}]}')
  expect(q && L.isWorthAttaching(q)).toBe(false)
})

test('caveman, clean code, auto-plan and Auto Clean are always on: no switch, and a stale off value is ignored', async ($, on) => {
  mock.clock(on, { now: 1_791_868_793_562 })
  mock.store(on, { 'deck.cave': false, 'deck.clean': false, 'deck.auto': false, 'deck.autoClean': false })
  on('session.start', () => ({ cwd: '/tmp/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 1 } }) as any)
  on('session.usage', () => ({ value: undefined }) as any)
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  const composed = await $.prompt.compose({ model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const ids = composed.sections.map(x => x.id)
  for (const id of ['command-deck:house', 'command-deck:clean-code', 'command-deck:caveman']) expect(ids.includes(id)).toBe(true)
  // the switch subcommands are gone: they fall back to the list of what is left
  const old = await $.command.run({ command: 'command-deck', args: 'clean off' } as Parameters<typeof $.command.run>[0])
  expect(old.text).not.toContain('off.')
  expect(old.text).not.toContain('auto [on|off]')
  const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', props: {}, requestId: 'command-deck' } as any)
  const all = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
  await ui.unmount()
  expect(all).not.toMatch(/Caveman ON|Clean code|Auto-plan|Auto Clean/)
})

test('waves: consecutive parallel tasks go together, others alone', () => {
  const mk = (id: number, parallel: boolean): Task => ({ id, title: `t${id}`, tier: 'haiku', why: '', status: 'todo', tokens: 0, parallel })
  expect(L.nextWave([mk(1, true), mk(2, true), mk(3, false)]).map(t => t.id)).toEqual([1, 2])
  expect(L.nextWave([mk(3, false), mk(4, true)]).map(t => t.id)).toEqual([3])
  expect(L.nextWave([1, 2, 3, 4, 5, 6].map(i => mk(i, true))).length).toBe(4)
})

test('auto-plan attaches a plan only when it adds something', () => {
  const one = { isClear: true, questions: [], prompt: 'p', tasks: [{ title: 'Add a button', tier: 'sonnet' as const, why: '', parallel: false }] }
  const two = { ...one, tasks: [...one.tasks, { title: 'Rename label', tier: 'haiku' as const, why: '', parallel: true }] }
  expect(L.isWorthAttaching(one)).toBe(false)
  expect(L.isWorthAttaching(two)).toBe(true)
  expect(L.planContext(two)).toContain('[Haiku ∥] Rename label')
  expect(L.GO_WORDS.test('go ahead')).toBe(true)
})

test('cold check: only big contexts idle past the cache lifetime count', () => {
  const min = 60_000
  expect(L.coldCheck(69 * min, 10 * min, 60, 80_000, 50_000).isCold).toBe(false)
  expect(L.coldCheck(70 * min, 10 * min, 60, 80_000, 50_000)).toEqual({ isCold: true, idleMin: 60 })
  expect(L.coldCheck(70 * min, 10 * min, 60, 20_000, 50_000).isCold).toBe(false)
  expect(L.coldCheck(70 * min, 0, 60, 80_000, 50_000).isCold).toBe(false)
  expect(L.coldCheck(30 * min, 10 * min, 60, 80_000, 50_000).isCold).toBe(false)
})

test('rewrite cost and keep-warm verdict follow the cache-tax rules', () => {
  expect(L.rewriteDollars(500_000, 3)).toBe(3)
  expect(L.warmVerdict({ cache_read_input_tokens: 100_000, cache_creation_input_tokens: 500 })).toBe('ok')
  expect(L.warmVerdict({ cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 })).toBe('stop')
  expect(L.warmVerdict({ cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000 })).toBe('stop')
  expect(L.warmVerdict(undefined)).toBe('stop')
})

test('planner prompt carries the chat, the questions and the answers so nothing is asked twice', () => {
  const p = L.plannerPrompt('check admob', ['all three admob'], ['Which projects?'], ['User: compare the three games'])
  expect(p).toContain('Recent conversation')
  expect(p).toContain('Q1: Which projects?')
  expect(p).toContain('Answer: all three admob')
  expect(L.PLANNER_SYSTEM).toContain('Default to isClear=true')
})

test('context segments: one run per used category, never wider than the bar', () => {
  const parts = [
    { name: 'System prompt', tokens: 3000, kind: 'used' as const },
    { name: 'MCP tools', tokens: 20000, kind: 'used' as const },
    { name: 'Messages', tokens: 60000, kind: 'used' as const },
    { name: 'Free space', tokens: 100000, kind: 'free' as const },
  ]
  const segs = L.ctxSegments(parts, 200000)
  expect(segs.map(x => x.name)).toEqual(['System prompt', 'MCP tools', 'Messages'])
  // each run is its share of the window, so together they never pass the bar
  expect(segs.map(x => x.pct)).toEqual([1.5, 10, 30])
  expect(L.ctxSegments(parts, 0)).toEqual([])
})

test('smart tools: server names match across spellings, the model reply parses, all four deck savings sum into one figure', () => {
  expect(L.serverOfTool('mcp__token-optimizer__smart_read')).toBe('token-optimizer')
  expect(L.serverOfTool('Bash')).toBe(null)
  expect(L.norm('claude.ai Gmail')).toBe(L.norm('claude_ai_Gmail'))
  expect(L.parseNeed('{"need":["graft","unity"]}')).toEqual(['graft', 'unity'])
  expect(L.parseNeed('nope')).toBe(null)
  const s = { ...L.ZERO_SAVINGS, keepwarm: 100, fresh: 50, routing: 10, tools: 9999 }
  expect(L.deckSaved(s)).toBe(10159)
})

test('the pane draws on the terminal and the desktop', async ($, on) => {
  mock.clock(on, { now: 1_791_868_793_562 })
  mock.store(on, {
    'deck.history': [{ at: 1_791_868_793_562, title: 'Did a thing', tier: 'haiku', status: 'done', tokens: 0 }],
  })
  on('session.start', () => ({ cwd: '/tmp/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 1 } }) as any)
  on('session.usage', () => ({ value: undefined }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'command-deck', surface, component: 'Pane', props: {}, requestId: 'command-deck' } as any)
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(all).toContain('HISTORY')
    expect(all).toContain('HISTORY  1') // the history pane starts minimized: its count shows, its rows do not
    await ui.unmount()
  }
})

test('guidelines: core stays small and sections are picked per step and tier', () => {
  const plan = (tasks: [string, 'haiku' | 'sonnet' | 'opus'][]) => ({
    isClear: true,
    questions: [],
    prompt: 'p',
    tasks: tasks.map(([title, tier]) => ({ title, tier, why: '', parallel: false })),
  })
  expect(G.CORE.split(/\s+/).length).toBeLessThan(G.CORE_MAX_WORDS)
  const rename = plan([['Rename label in menu', 'haiku']])
  expect(G.pickForPlan(rename)[0]!.sections).toEqual([])
  expect(G.guidelineExtras(rename)).toBe('')
  const arch = plan([
    ['Design module boundaries for the save system', 'opus'],
    ['Fix crash when save file is empty', 'sonnet'],
  ])
  const picks = G.pickForPlan(arch)
  expect(picks[0]!.sections).toContain('design')
  expect(picks[1]!.sections).toContain('bug')
  expect(picks[1]!.sections).not.toContain('design')
  expect(G.finalPass(arch)).toContain('Final pass')
  expect(L.planContext(arch).match(/Final pass/g)?.length).toBe(1)
  expect(L.planContext(rename)).not.toContain('Final pass')
  console.log(JSON.stringify(picks), G.guidelineExtras(arch).split(/\s+/).length, 'words')
})

test('clean-code rules: the word budget holds (at most 15% above the 1083 words before the rewrite)', () => {
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length
  const total = words(G.CORE) + words(G.UNITY_RULES) + G.SECTIONS.reduce((n, s) => n + words(s.text), 0)
  expect(total).toBeLessThanOrEqual(Math.round(1083 * 1.15))
  expect(words(G.CORE)).toBeLessThan(G.CORE_MAX_WORDS)
})

test('each tier has its own working bot that blinks, sparkles in changing colors, loops, stays narrow and can hold still', () => {
  const tiers = ['opus', 'sonnet', 'haiku']
  const seqs = tiers.map(t => Array.from({ length: 24 }, (_, f) => L.workingBot(t, f)))
  expect(new Set(seqs.map(s => s.map(b => b.face).join(''))).size).toBe(3)
  // a fixed-width face keeps the card title still
  expect(seqs.flat().every(b => [...b.face].length === 5 && [...b.spark].length === 1)).toBe(true)
  expect(tiers.every(t => new Set(Array.from({ length: 8 }, (_, f) => L.workingBot(t, f).face)).size > 1)).toBe(true)
  expect(new Set(seqs[0]!.map(b => b.sparkColor)).size).toBeGreaterThan(3)
  expect(L.workingBot('opus', -3)).toEqual(L.workingBot('opus', 3))
  expect(L.workingBot('unknown', 0)).toEqual(L.workingBot('sonnet', 0))
  // ambiguous-width glyphs (• ° ◎ ♪ ☆ ★ and friends) draw two cells in some terminals, so only known narrow ones
  const NARROW = /^[\x20-\x7e◕◉▿ᴗᵔᗜ♫✦✧✶✷✸✹✺]+$/
  expect(seqs.flat().every(b => NARROW.test(b.face + b.spark))).toBe(true)
  // reduced motion holds the first frame at any frame number
  expect(new Set(Array.from({ length: 8 }, (_, f) => JSON.stringify(L.workingBot('haiku', f, true)))).size).toBe(1)
  expect(L.workingBot('haiku', 5, true)).toEqual(L.workingBot('haiku', 0))
})

test('token saved: a tool shows as unavailable only when it is not connected and saved nothing', () => {
  const servers = [{ server: 'graft' }, { server: 'other' }]
  expect(L.toolAvailable('graft', servers, 5, 0)).toBe(true)
  expect(L.toolAvailable('optimizer', servers, 5, 0)).toBe(false)
  expect(L.toolAvailable('optimizer', servers, 5, 900)).toBe(true)
  expect(L.toolAvailable('optimizer', [{ server: 'token-optimizer' }], 5, 0)).toBe(true)
  expect(L.toolAvailable('graft', undefined, undefined, 0)).toBe(true)
  expect(L.toolAvailable('caveman', servers, 0, 0)).toBe(false)
  expect(L.toolAvailable('caveman', servers, undefined, 0)).toBe(true)
})

test('Unity rules ride in the plan only for Unity projects whose steps write C#', () => {
  const plan = { isClear: true, questions: [], prompt: 'x', tasks: [{ title: 'a', tier: 'sonnet' as const, why: '', parallel: false }] }
  expect(L.planContext(plan)).not.toContain('SerializeField')
  expect(L.planContext(plan, { unity: true })).toContain('SerializeField')
  // a TypeScript fix in a Unity folder, or any step the planner says is not C#, does not pay for the C# rules
  expect(L.planContext({ ...plan, csharp: false }, { unity: true })).not.toContain('SerializeField')
  expect(L.planContext({ ...plan, csharp: true }, { unity: true })).toContain('SerializeField')
  const parsed = L.parsePlan('{"isClear":true,"questions":[],"prompt":"Fix","code":true,"csharp":false,"tasks":[{"title":"Fix null check in lib.ts","tier":"haiku","why":"","parallel":false}]}')
  expect(parsed?.csharp).toBe(false)
  expect(L.parsePlan('{"isClear":true,"questions":[],"prompt":"Fix","tasks":[{"title":"Fix","tier":"haiku","why":"","parallel":false}]}')?.csharp).toBeUndefined()
})

const card = (id: number, title: string, status: Task['status'] = 'todo'): Task => ({ id, title, tier: 'sonnet', why: '', status, tokens: 0, parallel: false })

// words the deck adds per message: the plan text (steps, run rules, rules for the steps, the Unity rules when a
// step writes C#); the session sections (core, house and caveman) are sent once per chat
const words = (text: string) => text.split(/\s+/).filter(Boolean).length
const sample = (tasks: [string, 'haiku' | 'sonnet'][], code: boolean, csharp: boolean) => ({
  isClear: true,
  questions: [],
  prompt: 'Brief: caveman style request.',
  code,
  csharp,
  tasks: tasks.map(([title, tier]) => ({ title, tier, why: 'why', parallel: false })),
})
test('injected words: a TypeScript fix in a Unity folder pays no C# rules, and each sample stays in budget', () => {
  const tinyFix = words(L.planContext(sample([['Fix null check in hooks/lib.ts', 'haiku']], true, false), { unity: true }))
  const feature = words(L.planContext(sample([['Add pause button to GameHud.cs', 'sonnet'], ['Wire pause to GameManager.cs', 'sonnet']], true, true), { unity: true }))
  const notes = words(L.planContext(sample([['Draft store release notes in chat', 'sonnet'], ['Summarise changes for the owner', 'haiku']], false, false), { unity: true }))
  const session = words(`${L.HOUSE_SECTION}\n${G.CORE}\n${L.CAVEMAN_SECTION}`)
  console.log(`injected words: tiny fix ${tinyFix}, C# feature ${feature}, non-code ${notes}; session sections ${session}`)
  expect(tinyFix).toBeLessThan(200)
  expect(notes).toBeLessThan(300)
  expect(feature).toBeGreaterThan(tinyFix + 400) // the Unity rules are the difference
  expect(session).toBeLessThan(400)
})

test('board sync: a TodoWrite list moves cards forward by title', () => {
  const list = [card(1, 'Map data flow'), card(2, 'Fix done tasks staying in ToDo'), card(3, 'Verify')]
  const out = L.syncTodos(
    list,
    [
      { content: 'map data flow', status: 'completed' },
      { content: 'Fix done tasks staying in ToDo', status: 'in_progress' },
      { content: 'Verify', status: 'pending' },
    ],
    1000,
  )
  expect(out.map(t => t.status)).toEqual(['done', 'doing', 'todo'])
  expect(out[0]?.endedAt).toBe(1000)
  expect(out[1]?.startedAt).toBe(1000)
})

test('board sync: the model task list can reopen a card ticked too early; junk lists and repeats change nothing', () => {
  const done = { ...card(1, 'Ship the fix please', 'done'), startedAt: 1, endedAt: 2 }
  const reopened = L.syncTodos([done], [{ content: 'Ship the fix please', status: 'pending' }], 5)[0]
  expect(reopened?.status).toBe('todo')
  expect(reopened?.endedAt).toBeUndefined()
  expect(L.syncTodos([done], [{ content: 'Ship the fix please', status: 'completed' }], 9)[0]).toEqual(done)
  expect(L.syncTodos([done], 'nope', 5)).toEqual([done])
  expect(L.syncTodos([done], [], 5)).toEqual([done])
  expect(L.setCard(card(2, 'x', 'doing'), 'todo', 5).status).toBe('todo')
  expect(L.statusOfTask('deleted')).toBeUndefined()
  expect(L.statusOfTask('completed')).toBe('done')
})

test('board: a starting agent takes the card its description or prompt names; a guess is not a match', () => {
  const list = [card(1, 'Read pixel size of reference screenshots'), { ...card(2, 'Export PNGs at matched size'), tier: 'haiku' as const }, card(3, 'Verify every file dimension')]
  expect(L.pickCard(list, 'haiku', ['Export PNGs at matched size'])).toEqual({ id: 2, matched: true })
  expect(L.pickCard(list, 'haiku', ['', 'Step title: Verify every file dimension. Done when sizes match.'])).toEqual({ id: 3, matched: true })
  expect(L.pickCard(list, 'haiku', ['Find tutorial events'])).toEqual({ id: 2, matched: false })
  expect(L.pickCard(list, null, [])).toEqual({ id: 1, matched: false })
  expect(L.pickCard([card(1, 'Done already', 'done')], null, ['Done already'])).toBeNull()
})

test('handoff prompt: carries the current goal and only the unfinished cards', () => {
  const ask = L.handoffAsk('Fix the board ticking', [card(1, 'Trace the cause', 'done'), card(2, 'Apply the fix', 'doing'), card(3, 'Push the release')])
  expect(ask).toContain('Current goal: Fix the board ticking')
  expect(ask).toContain('- Apply the fix (doing)')
  expect(ask).toContain('- Push the release (todo)')
  expect(ask).not.toContain('Trace the cause')
  expect(L.handoffAsk('', [])).not.toContain('Current goal')
})

test('board sync: a reworded long title is the same card, a short one must match exactly', () => {
  expect(L.sameTitle('Fix done tasks staying in ToDo', 'Fix done tasks staying in ToDo today')).toBe(true)
  expect(L.sameTitle('Verify', 'Verify the board')).toBe(false)
  expect(L.newTodoTitles([{ content: 'Fix done tasks staying in ToDo today' }, { content: 'Brand new step' }], ['Fix done tasks staying in ToDo'])).toEqual(['Brand new step'])
})

test('install prompt names each tool, its link and steps; unknown tools are skipped', () => {
  const t = L.installPrompt(['tokeneconomizer', 'caveman'])
  expect(t).toContain('https://github.com/microsoft/TokenEconomizer')
  expect(t).toContain('claude plugin install tokeneconomizer@tokeneconomizer')
  expect(t).not.toContain('Caveman')
  expect(L.installPrompt(['graft', 'graphify'])).toContain('uv tool install graphifyy')
})

test('optional tools: Ponytail and Graphify show only when installed or already counted', () => {
  expect(L.toolAvailable('ponytail', undefined, undefined, 0, undefined)).toBe(false)
  expect(L.toolAvailable('ponytail', undefined, undefined, 0, ['ponytail'])).toBe(true)
  expect(L.toolAvailable('graphify', [], undefined, 0, ['graft'])).toBe(false)
  expect(L.toolAvailable('graphify', [{ server: 'graphify' }], undefined, 0, [])).toBe(true)
  expect(L.toolAvailable('graphify', [], undefined, 40, [])).toBe(true)
  expect(L.skillNames([{ name: 'ponytail:ponytail-review', pluginName: 'ponytail' }, { name: 'graphify' }])).toEqual(['ponytail', 'graphify'])
})

test('Graphify calls are the question commands, not the build ones', () => {
  expect(L.isGraphifyQuery('graphify query "how does auth work"')).toBe(true)
  expect(L.isGraphifyQuery('cd x && graphify explain APIRouter')).toBe(true)
  expect(L.isGraphifyQuery('graphify install')).toBe(false)
  expect(L.isGraphifyQuery(undefined)).toBe(false)
})

test('board follows the chat: TodoWrite completes a plan card and adds a new one, TaskCreate and TaskUpdate do the same', async ($, on) => {
  mock.clock(on, { now: 1_791_868_793_562 })
  mock.store(on, { 'deck.tasks': [card(1, 'Map the data flow of the board'), card(2, 'Fix done tasks staying in ToDo')] })
  on('session.start', () => ({ cwd: '/tmp/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 1 } }) as any)
  on('session.usage', () => ({ value: undefined }) as any)
  on('tool.call', () => ({ result: {} }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  on('fs.write', () => ({ value: undefined }) as any)
  on('fs.exists', () => ({ value: false }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Map the data flow of the board', status: 'completed', activeForm: 'x' }, { content: 'Brand new step', status: 'in_progress', activeForm: 'y' }],
  } as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Another step to do', description: 'd' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as any)
  const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', props: {}, requestId: 'command-deck' } as any)
  const all = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
  expect(all).toContain('2/4 done')
  expect(all).toMatch(/▍TODO 1 \| 1 \| □ ○ \[Sonnet\] Fix done tasks/)
  expect(all).toMatch(/▍DOING 1 \| 1 \| ■ \S+ \[Sonnet\] Brand new step/)
  expect(all).toMatch(/▍DONE 2 \| 2 \| ■ ✔ \[Sonnet\] Map the data flow/)
  // the bar above the lanes is Boxes the layout sizes, never a count of characters: one equal stretch per card in board
  // order (done, todo, doing, done), then the percent, which is the row's last box and never shrinks
  const boxes: any[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'Box') boxes.push(n)
    for (const c of n.children ?? []) walk(c)
  }
  const textOf = (n: any): string => (typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join(''))
  walk(await ui.drawn())
  const pctBox = boxes.find(b => b.props?.flexShrink === 0 && /^63%$/.test(textOf(b)))
  expect(pctBox).toBeDefined()
  const row = boxes.find(b => (b.children ?? []).includes(pctBox))
  expect(row.children.at(-1)).toBe(pctBox)
  const bar = row.children[0]
  // the bar starts at no width and grows into the room the layout has, clipped to one row: its length never comes from a column count
  expect(bar.props).toMatchObject({ width: 0, flexGrow: 1, height: 1, overflow: 'hidden' })
  // done, todo, doing (four shimmer parts), done: every stretch grows by the same total from zero, so the bar always spans its room
  const runs = bar.children as any[]
  expect(runs.map(b => [b.props.width, b.props.flexGrow])).toEqual([[0, 4], [0, 4], [0, 1], [0, 1], [0, 1], [0, 1], [0, 4]])
  expect(runs.every(b => b.props.overflow === 'hidden' && b.props.height === 1)).toBe(true)
  // each stretch is a long run of one block glyph, far more than fits: the layout cuts it, so any width shows a full bar
  const glyphs = runs.map(b => textOf(b))
  expect(glyphs.every(g => g.length === L.BAR_CELLS && new Set(g).size === 1)).toBe(true)
  expect(glyphs.map(g => g[0]).join('')).toMatch(/^█░[▓░]{4}█$/)
  // a meter is the same: a fill and the empty rest, as whole percents of the bar that add up to it
  await $.turn.complete({ answer: '', usage: { model: 'claude-fable-5-2', input_tokens: 300, output_tokens: 0 } } as any)
  await $.turn.complete({ answer: '', usage: { model: 'claude-sonnet-5-5', input_tokens: 100, output_tokens: 0 } } as any)
  boxes.length = 0
  walk(await ui.drawn())
  const meter = boxes.find(b => b.props?.width === 0 && b.props?.flexGrow === 1 && b.children?.[0]?.props?.width === '75%')
  expect(meter.children.map((c: any) => [c.props.width, textOf(c)[0]])).toEqual([['75%', '█'], ['25%', '░']])
  expect((await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')).toMatch(/Fable \|/)
  await ui.unmount()
})

test('token saved: a Graphify query counts and its row turns live; every tool keeps a row that says its state', async ($, on) => {
  mock.clock(on, { now: 1_791_868_793_562 })
  mock.store(on, {})
  on('session.start', () => ({ cwd: '/tmp/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 1 } }) as any)
  on('session.usage', () => ({ value: undefined }) as any)
  on('tool.call', () => ({ result: {} }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  const rows = async () => {
    const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', props: {}, requestId: 'command-deck' } as any)
    const all = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
    const buttons = (await ui.findAll({ type: 'Button' })).map(x => (x as any).props?.label ?? x.text).join(' | ')
    await ui.unmount()
    return all + ' || ' + buttons
  }
  // a missing tool offers an Install button, and two or more missing add Install all (here Graft reads as present)
  const first = await rows()
  expect(first).toMatch(/○ \| Graphify/)
  expect(first.split(' || ')[1]).toMatch(/Install \| Install \| Install all \(2\)/)
  await $.tool.call({ tool: 'Bash', command: 'graphify install' } as any)
  expect((await rows()).split(' || ')[1]).toMatch(/Install \| Install/)
  await $.tool.call({ tool: 'Bash', command: 'graphify query "how does auth work"' } as any)
  const all = await rows()
  expect(all.split(' || ')[1]).not.toMatch(/Install \| Install/)
  expect(all).toContain('1.2k')
  expect(all).toMatch(/● \| Graphify \| 1\.2k/)
  expect(all).toMatch(/○ \| Ponytail \| not installed/)
  // rtk is not on this test's PATH (process.run fails), so its row says so
  expect(all).toMatch(/○ \| RTK \| not installed/)
  // caveman is the deck's own text: on without any skill, and its row never disappears
  expect(all).toMatch(/● \| Caveman \| on, nothing saved yet/)
})

test('board: an agent takes the card it names, else gets its own Doing card', () => {
  const list = [card(1, 'Export PNGs at matched size'), card(2, 'Verify', 'done')]
  const named = L.agentCard(list, ['Export PNGs at matched size'], 'haiku', 5)
  expect(named.id).toBe(1)
  expect(named.tasks[0]?.status).toBe('doing')
  const own = L.agentCard(list, ['Find board sync hooks', 'long prompt'], 'haiku', 5)
  expect(own.id).toBe(3)
  expect(own.tasks[2]).toMatchObject({ title: 'Find board sync hooks', tier: 'haiku', status: 'doing', startedAt: 5 })
  expect(L.agentCard([], ['', '  '], 'sonnet', 5).tasks[0]?.title).toBe('Subagent')
})

test('board: Todo and Done lines in a reply add and close cards', () => {
  const marks = L.boardMarks('Fixed it.\nDone: Export PNGs at matched size\n- Todo: Register GA dimensions\n`Done: Ship build 1.0022`\nNot done: nope')
  expect(marks).toEqual({ todo: ['Register GA dimensions'], done: ['Export PNGs at matched size', 'Ship build 1.0022'], skip: [] })
  const out = L.applyMarks([card(1, 'Export PNGs at matched size', 'doing')], marks, 9)
  expect(out.map(t => [t.title, t.status])).toEqual([
    ['Export PNGs at matched size', 'done'],
    ['Register GA dimensions', 'todo'],
    ['Ship build 1.0022', 'done'],
  ])
  expect(L.boardMarks(undefined)).toEqual({ todo: [], done: [], skip: [] })
})

test('board: a Skip line closes a card as skipped, so dropped work leaves Todo without counting as done', () => {
  const marks = L.boardMarks('Dropped the tests.\nSkip: Add EditMode tests for three game modes\n- Skipped: Smoke test run: confirm the whole change works\nSkip: Not on the board')
  expect(marks.skip).toEqual(['Add EditMode tests for three game modes', 'Smoke test run: confirm the whole change works', 'Not on the board'])
  const out = L.applyMarks([card(1, 'Add EditMode tests for three game modes'), card(2, L.SMOKE_TITLE), card(3, 'Find crash root cause')], marks, 9)
  expect(out.map(t => [t.title, t.status])).toEqual([
    ['Add EditMode tests for three game modes', 'skipped'],
    [L.SMOKE_TITLE, 'skipped'],
    ['Find crash root cause', 'todo'],
  ])
  expect(out[0]?.endedAt).toBe(9)
  // a skipped card is closed: no new agent picks it up
  expect(L.agentCard(out, ['Add EditMode tests for three game modes'], 'sonnet', 10).id).toBe(4)
})

test('plan: the smoke test card joins plans that change code only', () => {
  const steps = [{ title: 'Rewrite release notes', tier: 'sonnet' as const, why: '', parallel: false }]
  expect(L.withSmokeTask(steps, false).map(t => t.title)).toEqual(['Rewrite release notes'])
  expect(L.withSmokeTask(steps).map(t => t.title)).toEqual(['Rewrite release notes', L.SMOKE_TITLE])
  const json = (code: string) => `{"isClear":true,"questions":[],"prompt":"p",${code}"tasks":[{"title":"Rewrite release notes","tier":"sonnet","why":"w","parallel":false}]}`
  expect(L.parsePlan(json('"code":false,'))?.code).toBe(false)
  // an older planner answer without the field keeps the smoke card
  expect(L.parsePlan(json(''))?.code).toBe(true)
})

test('board follows agents and replies without a plan: agent card Doing then done, a Done line closes a card', async ($, on) => {
  mock.clock(on, { now: 1_791_868_793_562 })
  mock.store(on, { 'deck.tasks': [card(1, 'Register GA dimensions')] })
  on('session.start', () => ({ cwd: '/tmp/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 1 } }) as any)
  on('session.usage', () => ({ value: undefined }) as any)
  on('fs.write', () => ({ value: undefined }) as any)
  on('fs.exists', () => ({ value: false }) as any)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'haiku' }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  const board = async () => {
    const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', props: {}, requestId: 'command-deck' } as any)
    const all = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
    await ui.unmount()
    return all
  }
  await $.agent.spawn({ description: 'Find board sync hooks', prompt: 'look', subagentType: 'Explore' } as any)
  expect(await board()).toMatch(/▍DOING 1 \| 1 \| .*\(.ᴗ.\)\S \[Haiku\] Find board sync hooks/)
  await $.turn.complete({ agentId: 'a1', answer: 'found' } as any)
  expect(await board()).toMatch(/▍DONE 1 \| 1 \| ■ ✔ \[Haiku\] Find board sync hooks/)
  await $.turn.complete({ answer: 'Registered.\nDone: Register GA dimensions' } as any)
  expect(await board()).toContain('2/2 done')
})

test('token saved: CMD Deck sums the deck and every tool, shown last under a line', async ($, on) => {
  const s = { ...L.ZERO_SAVINGS, graft: 1000, optimizer: 200, graphify: 30, caveman: 4, ponytail: 5, keepwarm: 100, fresh: 50, routing: 10, tools: 1 }
  expect(L.totalSaved(s)).toBe(1400)
  expect(L.totalSaved(s, 600)).toBe(2000)
  expect(L.totalSaved(L.ZERO_SAVINGS)).toBe(0)
  mock.clock(on, { now: 1_791_868_793_562 })
  mock.store(on, {})
  on('session.start', () => ({ cwd: '/tmp/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 1 } }) as any)
  on('session.usage', () => ({ value: undefined }) as any)
  on('fs.write', () => ({ value: undefined }) as any)
  on('fs.exists', () => ({ value: false }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', props: {}, requestId: 'command-deck' } as any)
  const all = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
  await ui.unmount()
  const section = all.slice(all.indexOf('SAVED TODAY'))
  // every tool has a row whatever it saved, so a tool that is off never just vanishes; the total closes the section
  for (const name of ['Deck', 'Caveman', 'Graft', 'RTK', 'Optimizer', 'Ponytail', 'Graphify', 'TokenEcon.']) expect(section).toContain(name)
  expect(section.indexOf('Total')).toBeGreaterThan(section.indexOf('TokenEcon.'))
  expect(section).toMatch(/○ \| Ponytail \| not installed/)
})

test('board judge: an answer without Done/Skip lines still closes the cards it settles', async ($, on) => {
  mock.clock(on, { now: 1_791_868_793_562 })
  mock.store(on, { 'deck.tasks': [card(1, 'Confirm /ws rate rule live in Cloudflare'), card(2, 'Smoke test prod /ws and /live'), card(3, 'Write release notes')] })
  on('session.start', () => ({ cwd: '/tmp/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 1 } }) as any)
  on('session.usage', () => ({ value: undefined }) as any)
  on('fs.write', () => ({ value: undefined }) as any)
  on('fs.exists', () => ({ value: false }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  let judged!: () => void
  const asked = new Promise<void>(r => (judged = r))
  on('model.complete', () => {
    setTimeout(judged, 0)
    return { value: { isAnswered: true, text: '{"done":[1],"skip":[2]}', usage: { input_tokens: 10, output_tokens: 5 } } } as any
  })
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  await $.turn.complete({ answer: 'Rule is live. The /ws test was denied.', reason: 'answer' } as any)
  await asked
  await new Promise(r => setTimeout(r, 20))
  const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', props: {}, requestId: 'command-deck' } as any)
  const all = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
  await ui.unmount()
  expect(all).toContain('TODO 1')
  expect(all).toContain('Write release notes')
  expect(all).toMatch(/DONE 2/)
})

test('token saved: each tool reads active, not active or not installed', () => {
  const skills = ['graft', 'caveman', 'ponytail']
  // installed and running
  expect(L.toolState('graft', [{ server: 'graft' }], 5, 0, skills)).toBe('active')
  expect(L.toolState('caveman', [], 5, 0, skills)).toBe('active')
  expect(L.toolState('ponytail', undefined, undefined, 0, skills)).toBe('active')
  // installed, but not running: the Graft skill without its server
  expect(L.toolState('graft', [{ server: 'other' }], 5, 0, skills)).toBe('inactive')
  // not installed
  expect(L.toolState('graft', [{ server: 'other' }], 5, 0, ['caveman'])).toBe('missing')
  expect(L.toolState('caveman', [], 5, 0, ['graft'])).toBe('missing')
  expect(L.toolState('graphify', [], undefined, 0, [])).toBe('missing')
  expect(L.toolState('optimizer', [{ server: 'other' }], 5, 0, skills)).toBe('missing')
  // no data yet reads as active, and a tool that saved today is live
  expect(L.toolState('graft', undefined, undefined, 0, undefined)).toBe('active')
  expect(L.toolState('graphify', [], undefined, 40, [])).toBe('active')
})

test('token saved: RTK savings come from today in its JSON, its hook from rtk verify', () => {
  const json = JSON.stringify({ daily: [{ date: '2026-10-23', saved_tokens: 27694 }, { date: '2026-10-24', saved_tokens: 19745 }] })
  expect(L.rtkSaved(json, '2026-10-24')).toBe(19745)
  expect(L.rtkSaved(json, '2026-10-25')).toBe(0)
  expect(L.rtkSaved('not json', '2026-10-24')).toBe(0)
  expect(L.rtkSaved(undefined, '2026-10-24')).toBe(0)
  expect(L.rtkHooked('PASS  native binary hook registered in settings.json\nPASS  data directory is owner-only')).toBe(true)
  expect(L.rtkHooked('FAIL  no hook registered in settings.json')).toBe(false)
  expect(L.rtkHooked('')).toBe(false)
})

test('a message with images is never held back for questions, and the planner is told they exist', () => {
  const unclear = { isClear: false, questions: ['Which texts?'], prompt: '', tasks: [] }
  expect(L.mayAsk(unclear, false, 0)).toBe(true)
  expect(L.mayAsk(unclear, false, 2)).toBe(false)
  expect(L.mayAsk(unclear, true, 0)).toBe(false)
  expect(L.plannerPrompt('make it look like these', [], [], [], 2)).toContain('attached 2 image(s)')
  expect(L.plannerPrompt('make it look like these', [])).not.toContain('attached')
})

test('running stretch shimmers: a two-cell highlight sweeps through it, deterministic per frame, held lit by reducedMotion', () => {
  // empty and one-cell stretches: nothing to sweep past, and no output beyond the cells
  expect(L.shimmerMask(0, 3)).toEqual([])
  expect(L.shimmerMask(Number.NaN, 3)).toEqual([])
  expect(L.shimmerMask(1, 0)).toEqual([true])
  expect(L.shimmerMask(1, 2)).toEqual([false])
  // five cells: the highlight enters, crosses, leaves, then rests two frames and starts again
  const frames = [0, 1, 2, 3, 4, 5, 6, 7].map(f => L.shimmerMask(5, f).map(x => (x ? 'x' : '.')).join(''))
  expect(frames).toEqual(['x....', 'xx...', '.xx..', '..xx.', '...xx', '....x', '.....', 'x....'])
  // repeat: same input, same output; a highlight never leaves the stretch
  for (let f = -20; f < 200; f++) {
    expect(L.shimmerMask(7, f)).toEqual(L.shimmerMask(7, f))
    expect(L.shimmerMask(7, f).length).toBe(7)
  }
  // reducedMotion: every cell lit on every frame
  expect(L.shimmerMask(4, 9, true)).toEqual([true, true, true, true])
})

test('board progress: one colored stretch per card, skipped cards leave the count', () => {
  const mk = (status: Task['status'], id: number): Task => ({ id, title: `t${id}`, tier: 'sonnet', why: '', status, tokens: 0 })
  const board = [mk('done', 1), mk('doing', 2), mk('todo', 3), mk('skipped', 4), mk('failed', 5)]
  expect(L.boardProgress(board)).toEqual({ done: 1, total: 4, ratio: 0.375 })
  // the skipped card has no stretch; each stretch keeps its card's place on the board, so row and bar share a color
  expect(L.boardSlices(board).map(x => [x.card, x.status])).toEqual([[0, 'done'], [1, 'doing'], [2, 'todo'], [4, 'failed']])
  // empty and all-skipped boards: no stretches, 0%, never NaN
  expect(L.boardProgress([])).toEqual({ done: 0, total: 0, ratio: 0 })
  expect(L.boardSlices([])).toEqual([])
  expect(L.boardProgress([mk('skipped', 1)]).ratio).toBe(0)
  expect(L.boardProgress([mk('done', 1), mk('done', 2)]).ratio).toBe(1)
  // eight card colors, then they repeat; the percent runs red to amber to green and clamps
  expect(new Set(Array.from({ length: 8 }, (_, i) => L.cardColor(i))).size).toBe(8)
  expect(L.cardColor(8)).toBe(L.cardColor(0))
  expect([L.gradientAt(0), L.gradientAt(0.5), L.gradientAt(1)]).toEqual(['#ef4444', '#f59e0b', '#22c55e'])
  expect([L.gradientAt(-1), L.gradientAt(9), L.gradientAt(Number.NaN)]).toEqual(['#ef4444', '#22c55e', '#ef4444'])
})

// ------------------------------------------------------------ 1.5.0: effort routing, reliable tools, memory, the new pane

/** The engine's side for a test that only needs the deck to start. */
const boot = (on: any, files: Record<string, string> = {}, usage?: unknown) => {
  const written: Record<string, string> = { ...files }
  mock.clock(on, { now: 1_791_868_793_562 })
  on('session.start', () => ({ cwd: '/tmp/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { stdout: '', stderr: '', code: 1 } }) as any)
  on('session.usage', () => ({ value: usage }) as any)
  on('fs.exists', (_: unknown, e: any) => ({ value: Object.keys(written).some(k => JSON.stringify(e).includes(k)) }) as any)
  on('fs.read', (_: unknown, e: any) => ({ value: written[Object.keys(written).find(k => JSON.stringify(e).includes(k)) ?? ''] ?? '' }) as any)
  on('fs.write', (_: unknown, e: any) => {
    written[String(e.path ?? e.file ?? Object.values(e)[0])] = String(e.content ?? e.text ?? e.data ?? Object.values(e)[1])
    return { value: undefined } as any
  })
  return written
}
/** Runs a streamed call to its end and gives its result. */
const drain = async (s: any) => {
  if (!s || typeof s[Symbol.asyncIterator] !== 'function') return await s
  const it = s[Symbol.asyncIterator]()
  let r = await it.next()
  while (!r.done) r = await it.next()
  return r.value
}
const planJson = (effort: string) =>
  JSON.stringify({ isClear: true, questions: [], prompt: 'p', code: false, effort, tasks: [{ title: 'Answer in chat', tier: 'sonnet', why: 'w', parallel: false }] })
const human = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as any

test('effort: a named level wins, mode 1 only lowers, mode 2 may raise, saving caps at medium, no session level sends nothing', () => {
  expect(L.namedEffort('fix it, effort: low')).toBe('low')
  expect(L.namedEffort('use max effort here')).toBe('max')
  expect(L.namedEffort('put more effort in')).toBeUndefined()
  const r = L.routedEffort
  expect(r({ want: 'low', session: 'high', mode: 1 })).toBe('low')
  expect(r({ want: 'xhigh', session: 'high', mode: 1 })).toBeUndefined()
  expect(r({ want: 'xhigh', session: 'high', mode: 2 })).toBe('xhigh')
  expect(r({ want: 'high', session: 'high', mode: 2 })).toBeUndefined()
  expect(r({ want: 'low', session: 'high', mode: 0 })).toBeUndefined()
  // no level in the session (a model without effort, auto, or a number budget): the request is left alone
  expect(r({ want: 'low', session: undefined, mode: 2 })).toBeUndefined()
  expect(r({ want: 'low', session: 7, mode: 2 })).toBeUndefined()
  expect(r({ session: 'high', mode: 1, isSaving: true })).toBe('medium')
  expect(r({ want: 'xhigh', session: 'xhigh', mode: 2, isSaving: true })).toBe('medium')
  expect(r({ named: 'max', want: 'low', session: 'medium', mode: 1, isSaving: true })).toBe('max')
  // an unproven model changes level only while the chat is small; a proven one always, a refuted one never
  expect(L.mayRouteEffort(undefined, 10_000)).toBe(true)
  expect(L.mayRouteEffort(undefined, 90_000)).toBe(false)
  expect(L.mayRouteEffort('ok', 90_000)).toBe(true)
  expect(L.mayRouteEffort('bad', 100)).toBe(false)
  expect(L.effortVerdict({ cache_read_input_tokens: 50_000, cache_creation_input_tokens: 900 })).toBe('ok')
  expect(L.effortVerdict({ cache_read_input_tokens: 2_000, cache_creation_input_tokens: 48_000 })).toBe('bad')
  expect(L.effortVerdict({ cache_read_input_tokens: 3_000, cache_creation_input_tokens: 2_000 })).toBeUndefined()
  expect(L.effortVerdict({ cache_read_input_tokens: 15_000, cache_creation_input_tokens: 30_000 })).toBeUndefined() // a big new message, not a rewrite
  expect(L.effortVerdict(null)).toBeUndefined()
  // one bad reading is a suspicion (a compaction reads the same), the second settles it; a good one clears it
  expect(L.nextTrust(undefined, 'bad')).toBe('suspect')
  expect(L.nextTrust('suspect', 'bad')).toBe('bad')
  expect(L.nextTrust('suspect', 'ok')).toBe('ok')
  expect(L.nextTrust('suspect', undefined)).toBe('suspect')
  expect(L.mayRouteEffort('suspect', 10_000)).toBe(true)
  // the level of one request: routed while allowed, the session's once refuted
  expect(L.stepEffort({ routed: 'low', session: 'high', trust: undefined, ctxTokens: 10_000 })).toBe('low')
  expect(L.stepEffort({ routed: undefined, session: 'high', trust: 'ok', ctxTokens: 500_000 })).toBe('high')
  expect(L.stepEffort({ routed: 'low', session: 'high', trust: 'bad', ctxTokens: 10_000, prev: { sent: 'low', session: 'high' } })).toBe('high')
  // unproven in a big chat: the level it had is kept (a change there is the cost the limit bounds), whatever is routed now
  expect(L.stepEffort({ routed: undefined, session: 'high', trust: undefined, ctxTokens: 90_000, prev: { sent: 'medium', session: 'high' } })).toBe('medium')
  expect(L.stepEffort({ routed: 'low', session: 'high', trust: 'suspect', ctxTokens: 90_000, prev: { sent: 'high', session: 'high' } })).toBe('high')
  // the person changed their own level meanwhile: theirs is sent; and a family with no request yet starts at the session's
  expect(L.stepEffort({ routed: 'low', session: 'low', trust: undefined, ctxTokens: 90_000, prev: { sent: 'medium', session: 'high' } })).toBe('low')
  expect(L.stepEffort({ routed: 'low', session: 'high', trust: undefined, ctxTokens: 90_000 })).toBe('high')
  expect(L.parsePlan(planJson('low'))?.effort).toBe('low')
  expect(L.parsePlan(planJson('turbo'))?.effort).toBeUndefined()
})

test('effort routing: the planner level rides on the main request, a subagent request is left alone, a cache rewrite turns it off', async ($, on) => {
  boot(on)
  mock.store(on, {})
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined } as any
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: planJson('low'), usage: {} } }) as any)
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }) as any)
  const sent: unknown[] = []
  let usage: unknown = null
  on('turn.step', async function* (_: unknown, e: any) {
    sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  } as any)
  on('turn.complete', () => ({ text: '' }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  const step = (extra: object = {}) => drain($.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1, ...extra } as any))
  await step()
  expect(sent.at(-1)).toBe('high') // nothing planned yet: the session's own level
  await $.prompt.submit(human('Rename the label in the settings menu to Options'))
  await step()
  expect(sent.at(-1)).toBe('low')
  await step({ agentId: 'a1' })
  expect(sent.at(-1)).toBe('high')
  // a short follow-up continues the work at its level
  await $.prompt.submit(human('yes, go on'))
  await step()
  expect(sent.at(-1)).toBe('low')
  // a slash command is its own work: it runs at the session's level, not the level before it
  await $.prompt.submit(human('/code-review'))
  await step()
  expect(sent.at(-1)).toBe('high')
  // another model family starts clean: its first request is not read as a level change, whatever its cache says
  await $.turn.complete({ answer: 'ok' } as any) // a main turn ended: the cache counts as warm from here
  usage = { model: 'claude-opus-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 60_000 }
  await step({ model: 'claude-opus-5-5' })
  expect(toasts).toEqual([])
  // a level named in the message is used as named, for that message only
  usage = { model: 'claude-sonnet-5-5', cache_read_input_tokens: 500, cache_creation_input_tokens: 60_000 }
  await $.prompt.submit(human('Now rename the other label too, max effort'))
  await step()
  expect(sent.at(-1)).toBe('max')
  // that changed request wrote the whole prefix again: one such reading is a suspicion, so routing goes on
  await $.prompt.submit(human('Rename the third label in the settings menu as well'))
  await step()
  expect(sent.at(-1)).toBe('low')
  // the second one settles it: the family is marked and left alone afterwards
  expect(toasts.join(' ')).toContain('Effort routing is off for Sonnet')
  await step()
  expect(sent.at(-1)).toBe('high')
})

test('caveman: the rules are inline with no skill to load, and every typed message carries the reminder until "normal mode"', async ($, on) => {
  expect(L.CAVEMAN_SECTION).not.toMatch(/skill/i)
  boot(on)
  mock.store(on, {})
  const seen: string[][] = []
  on('prompt.submit', (_: unknown, e: any) => {
    seen.push([...(e.context ?? [])])
    return { text: e.text } as any
  })
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  await $.prompt.submit(human('do the next one'))
  await $.prompt.submit(human('/code-review'))
  // a prompt the deck or a task sent is not the person's message: nothing rides with it
  await $.prompt.submit({ text: 'task finished', origin: { kind: 'task' }, wait: false } as any)
  await $.prompt.submit(human('and the one after'))
  expect(seen).toEqual([[L.CAVEMAN_REMINDER], [], [], [L.CAVEMAN_REMINDER]])
  // the section promises "normal mode" turns it off: from that message on nothing is added in this chat
  await $.prompt.submit(human('normal mode please'))
  await $.prompt.submit(human('do the next one'))
  expect(seen.slice(4)).toEqual([[], []])
})

test('planner gate: a plain one-line question skips the planner call, a request with a build word does not', async ($, on) => {
  expect(L.isPlainQuestion('What does HideBannerAds do?')).toBe(true)
  expect(L.isPlainQuestion('Why is the Android export so slow on CI?')).toBe(true)
  expect(L.isPlainQuestion('Why is the Android build so slow on CI?')).toBe(false) // "build" may be an order: the planner decides
  expect(L.isPlainQuestion('How do I fix the crash in save?')).toBe(false)
  expect(L.isPlainQuestion('Can you add dark mode?')).toBe(false)
  expect(L.isPlainQuestion('Why is the build slow')).toBe(false)
  expect(L.isPlainQuestion('What is this?\nAlso rename the label?')).toBe(false)
  boot(on)
  mock.store(on, {})
  let calls = 0
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: planJson('medium'), usage: {} } } as any
  })
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  await $.prompt.submit(human('What does the HideBannerAds method do in this project?'))
  expect(calls).toBe(0)
  await $.prompt.submit(human('Rename the label in the settings menu to Options'))
  expect(calls).toBe(1)
})

test('graft: an indexed repo gets the search line, a CLI answer is counted, and a plain grep earns one nudge per turn', async ($, on) => {
  expect(L.isTextSearch('Grep')).toBe(true)
  expect(L.isTextSearch('Bash', 'grep -rn "foo" src')).toBe(true)
  expect(L.isTextSearch('Bash', 'cd src && rg foo')).toBe(true)
  expect(L.isTextSearch('Bash', 'rtk grep foo .')).toBe(true)
  expect(L.isTextSearch('Bash', 'git log | grep fix')).toBe(false) // a filter on other output is not a code search
  expect(L.isTextSearch('Bash', 'graft grep "foo"')).toBe(false)
  expect(L.isTextSearch('Read')).toBe(false)
  expect(L.isGraftCli('graft ask "how does save work" --source')).toBe(true)
  expect(L.isGraftCli('npm i -g @nanonets/graft@latest')).toBe(false)
  expect(L.houseSection()).toBe(L.HOUSE_SECTION)
  boot(on, { 'graft/INDEX.md': '# graft' })
  mock.store(on, {})
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }) as any)
  on('tool.call', (_: unknown, e: any) => ({ result: {}, text: String(e.command).startsWith('graft') ? '[graft] tokens saved ≈ 12k\nhits' : 'out' }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  const composed = await $.prompt.compose({ model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(composed.sections.find(x => x.id === 'command-deck:house')?.text).toContain(L.GRAFT_LINE)
  const grep = () => $.tool.call({ tool: 'Bash', command: 'grep -rn "Save" src' } as any) as Promise<any>
  expect((await grep()).context).toEqual([L.GRAFT_NUDGE])
  expect((await grep()).context).toBeUndefined() // once per turn
  await $.prompt.submit(human('next'))
  await $.tool.call({ tool: 'Bash', command: 'graft ask "where is Save" --source' } as any)
  expect((await grep()).context).toBeUndefined() // graft was used this turn: nothing to say
  const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', props: {}, requestId: 'command-deck' } as any)
  expect((await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')).toMatch(/● \| Graft \| 12k/)
  await ui.unmount()
})

test('smart tools: a saving tool is never moved behind search, whatever the chooser says', async ($, on) => {
  boot(on, {}, { context: { breakdown: { mcpTools: [
    { serverName: 'graft', name: 'mcp__graft__graft_find_code', tokens: 300, isLoaded: true },
    { serverName: 'unity', name: 'mcp__unity__unity_build', tokens: 900, isLoaded: true },
  ] } } })
  mock.store(on, {})
  on('session.turns', () => ({ value: 0 }) as any)
  // a short message skips the planner, so this is the chooser's answer: it names no server as needed
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"need":[]}', usage: {} } }) as any)
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }) as any)
  on('tool.describe', () => ({ description: 'd' }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  await $.prompt.submit(human('fix the typo in readme'))
  const placed = async (tool: string) => ((await $.tool.describe({ tool, description: 'd' } as any)) as any).isDeferred
  expect(await placed('mcp__unity__unity_build')).toBe(true)
  expect(await placed('mcp__graft__graft_find_code')).toBeUndefined()
})

test('project memory: lasting facts leave the handoff note, join the memory file once, and ride in every handoff', async ($, on) => {
  const split = L.splitFacts('- built the board\n- next: tests\n\n## Lasting facts\n- Tests run with `claude plugin test .`\n- None new beyond that.\n* Strict validate must pass before a release\nThat is all I found.\n')
  expect(split.note).toBe('- built the board\n- next: tests')
  expect(split.facts).toEqual(['Tests run with `claude plugin test .`', 'Strict validate must pass before a release'])
  expect(L.splitFacts('just a note').facts).toEqual([])
  expect(L.splitFacts('note\n## Lasting facts\nnone').facts).toEqual([])
  const once = L.mergeFacts('', ['Use bun for tests.', 'Never push without a tag'])
  const twice = L.mergeFacts(once, ['use BUN for tests', 'Keep the pane free of block characters'])
  expect(L.memoryFacts(twice)).toEqual(['Use bun for tests.', 'Never push without a tag', 'Keep the pane free of block characters'])
  expect(L.memoryFacts(L.mergeFacts(twice, ['d', 'e'], 2))).toEqual(['d', 'e']) // the newest are kept
  // the file is the person's too: their own lines stay, and nothing new leaves the file untouched
  const edited = `${once}\n## My notes\nShip on Fridays only.\n`
  expect(L.mergeFacts(edited, ['use bun for tests'])).toBe(edited)
  const grown = L.mergeFacts(edited, ['A new fact', 'a NEW fact.'], 2)
  expect(grown).toContain('## My notes\nShip on Fridays only.')
  expect(L.memoryFacts(grown)).toEqual(['Never push without a tag', 'A new fact'])
  expect(L.handoffAsk('g', [], ['Use bun for tests.'])).toContain('Already known, do not repeat:\n- Use bun for tests.')
  expect(L.handoffMarkdown({ goal: 'g', tasks: [], rules: 'r', git: null, date: 'd', memory: once })).toContain('## Project memory\n- Use bun for tests.\n- Never push without a tag')
  expect(L.handoffMarkdown({ goal: 'g', tasks: [], rules: 'r', git: null, date: 'd' })).not.toContain('Project memory')
  const files = boot(on, { 'memory.md': once })
  mock.store(on, {})
  on('model.fork', () => ({ value: { isAnswered: true, text: '- board done\n\n## Lasting facts\n- The pane has no terminal preview: test with ui.mount', usage: {} } }) as any)
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  await $.command.run({ command: 'command-deck', args: 'handoff' } as Parameters<typeof $.command.run>[0])
  const memory = Object.entries(files).find(([k]) => k.endsWith('memory.md') && k !== 'memory.md')?.[1] ?? ''
  expect(L.memoryFacts(memory)).toEqual(['Use bun for tests.', 'Never push without a tag', 'The pane has no terminal preview: test with ui.mount'])
  const note = Object.entries(files).find(([k]) => /handoff-\d+\.md$/.test(k))?.[1] ?? ''
  expect(note).toContain('## Where things stand\n- board done')
  expect(note).not.toContain('Lasting facts')
  expect(note).toContain('- The pane has no terminal preview: test with ui.mount')
})

test('pane: the minimized form is a glance with no buttons, and the move buttons show only while arranging', async ($, on) => {
  boot(on)
  mock.store(on, { 'deck.tasks': [card(1, 'Map the data flow of the board', 'done'), card(2, 'Fix done tasks staying in ToDo')] })
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  const mount = (props: object) => $.ui.mount({ plugin: 'command-deck', surface: 'desktop', component: 'Pane', props, requestId: 'command-deck' } as any)
  const small = await mount({ placement: 'widget' })
  expect(await small.findAll({ type: 'Button' })).toHaveLength(0)
  expect((await small.findAll({ type: 'Text' })).map(x => x.text).join(' | ')).toMatch(/◆ DECK {2}1\/2 done/)
  await small.unmount()
  const full = await mount({ placement: 'dock', bodyColumns: 50 })
  const labels = async () => (await full.findAll({ type: 'Button' })).map(x => (x as any).props?.label ?? x.text)
  expect(await labels()).not.toContain('▲')
  await full.press({ key: 'arrange' })
  expect(await labels()).toContain('▲')
  expect(await labels()).toContain('↺ Reset')
  await full.unmount()
})
