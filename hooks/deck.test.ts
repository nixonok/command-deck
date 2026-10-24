import { expect, mock, test } from 'claude-code/testing'

import * as G from './guidelines'
import * as L from './lib'
import type { Task } from '../types'

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

test('bars fill proportionally and never overflow', () => {
  expect(L.bar(50, 10)).toEqual({ full: '█████', empty: '░░░░░' })
  expect(L.bar(250, 4).full).toBe('████')
  expect(L.bar(-5, 4).full).toBe('')
  expect(L.barColor(90)).toBe('red')
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
})

test('/command-deck-cave switches caveman on and the system prompt gains its section', async ($, on) => {
  // nothing stands beneath the plugins here, so the test answers the engine's part: no sections
  on('prompt.compose', () => ({ sections: [] }))
  const out = await $.command.run({ command: 'command-deck-cave', args: 'on' } as Parameters<typeof $.command.run>[0])
  expect(out.text).toContain('Caveman ON')
  const composed = await $.prompt.compose({ model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(composed.sections.some(s => s.id === 'command-deck:caveman')).toBe(true)
})

test('/command-deck clean turns the engineering rules section on and off', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const ask = () => $.prompt.compose({ model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const run = (args: string) => $.command.run({ command: 'command-deck', args } as Parameters<typeof $.command.run>[0])
  expect((await run('clean on')).text).toContain('Clean code ON')
  expect((await ask()).sections.some(s => s.id === 'command-deck:clean-code')).toBe(true)
  expect((await run('clean off')).text).toContain('Clean code off')
  expect((await ask()).sections.some(s => s.id === 'command-deck:clean-code')).toBe(false)
})

test('waves: consecutive parallel tasks go together, others alone', () => {
  const mk = (id: number, parallel: boolean): Task => ({ id, title: `t${id}`, tier: 'haiku', why: '', status: 'todo', tokens: 0, parallel })
  expect(L.nextWave([mk(1, true), mk(2, true), mk(3, false)]).map(t => t.id)).toEqual([1, 2])
  expect(L.nextWave([mk(3, false), mk(4, true)]).map(t => t.id)).toEqual([3])
  expect(L.nextWave([1, 2, 3, 4, 5, 6].map(i => mk(i, true))).length).toBe(4)
})

test('tip wrapping never exceeds the width', () => {
  const lines = L.wrapWords('Compact at 60% context, not 95%: summaries stay sharp and the cache stays cheap.', 20)
  expect(lines.every(l => l.join(' ').length <= 20)).toBe(true)
  expect(lines.flat().join(' ')).toContain('cache stays cheap.')
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
  const segs = L.ctxSegments(parts, 200000, 30)
  expect(segs.map(x => x.name)).toEqual(['System prompt', 'MCP tools', 'Messages'])
  expect(segs.reduce((n, x) => n + x.cells, 0)).toBeLessThanOrEqual(30)
  expect(segs.every(x => x.cells >= 1)).toBe(true)
  expect(L.ctxSegments(parts, 0, 30)).toEqual([])
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
  expect(G.pickForPlan(rename)[0].sections).toEqual([])
  expect(G.guidelineExtras(rename)).toBe('')
  const arch = plan([
    ['Design module boundaries for the save system', 'opus'],
    ['Fix crash when save file is empty', 'sonnet'],
  ])
  const picks = G.pickForPlan(arch)
  expect(picks[0].sections).toContain('design')
  expect(picks[1].sections).toContain('bug')
  expect(picks[1].sections).not.toContain('design')
  expect(G.finalPass(arch)).toContain('Final pass')
  expect(L.planContext(arch).match(/Final pass/g)?.length).toBe(1)
  expect(L.planContext(rename)).not.toContain('Final pass')
  expect(L.planContext(arch, { clean: false })).not.toContain('Final pass')
  expect(L.planContext(arch, { clean: false })).not.toContain('Extra engineering rules')
  console.log(JSON.stringify(picks), G.guidelineExtras(arch).split(/\s+/).length, 'words')
})

test('each tier has its own one-cell working animation that loops', () => {
  const tiers = ['opus', 'sonnet', 'haiku']
  const seqs = tiers.map(t => Array.from({ length: 12 }, (_, f) => L.tierSpinner(t, f)))
  expect(new Set(seqs.map(s => s.join(''))).size).toBe(3)
  expect(seqs.flat().every(c => [...c].length === 1)).toBe(true)
  expect(tiers.every(t => L.tierSpinner(t, 0) !== L.tierSpinner(t, 1))).toBe(true)
  expect(L.tierSpinner('opus', -3)).toBe(L.tierSpinner('opus', 3))
})

test('Handoff+/Clean clears the chat when Auto Clean is on, otherwise only compacts', () => {
  expect(L.cleanStep(true)).toBe('clean')
  expect(L.cleanStep(false)).toBe('compact')
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

test('Unity rules ride in the plan only for Unity projects', () => {
  const plan = { isClear: true, questions: [], prompt: 'x', tasks: [{ title: 'a', tier: 'sonnet' as const, why: '', parallel: false }] }
  expect(L.planContext(plan)).not.toContain('SerializeField')
  expect(L.planContext(plan, { unity: true })).toContain('SerializeField')
})

const card = (id: number, title: string, status: Task['status'] = 'todo'): Task => ({ id, title, tier: 'sonnet', why: '', status, tokens: 0, parallel: false })

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
  await $.session.start({ cwd: '/tmp/x', surface: null, isInteractive: false } as any)
  await $.tool.call({
    tool: 'TodoWrite',
    input: { todos: [{ content: 'Map the data flow of the board', status: 'completed', activeForm: 'x' }, { content: 'Brand new step', status: 'in_progress', activeForm: 'y' }] },
  } as any)
  await $.tool.call({ tool: 'TaskCreate', input: { subject: 'Another step to do', description: 'd' } } as any)
  await $.tool.call({ tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } } as any)
  const ui = await $.ui.mount({ plugin: 'command-deck', surface: 'terminal', component: 'Pane', props: {}, requestId: 'command-deck' } as any)
  const all = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
  expect(all).toContain('2/4 done')
  expect(all).toMatch(/TODO 1 \| 1 \| ○ \[Sonnet\] Fix done tasks/)
  expect(all).toMatch(/DOING 1 \| 1 \| \S+ \[Sonnet\] Brand new step/)
  expect(all).toMatch(/DONE 2 \| 2 \| ✔ \[Sonnet\] Map the data flow/)
  await ui.unmount()
})

test('token saved: a Graphify query counts and its row turns live; a missing tool says Not Installed', async ($, on) => {
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
    await ui.unmount()
    return all
  }
  expect(await rows()).toMatch(/Graphify\s+\(Not Installed\)/)
  await $.tool.call({ tool: 'Bash', input: { command: 'graphify install' } } as any)
  expect(await rows()).toMatch(/Graphify\s+\(Not Installed\)/)
  await $.tool.call({ tool: 'Bash', input: { command: 'graphify query "how does auth work"' } } as any)
  const all = await rows()
  expect(all).not.toMatch(/Graphify\s+\(Not Installed\)/)
  expect(all).toContain('1.2k')
  expect(all).toMatch(/Ponytail\s+\(Not Installed\)/)
  // rtk is not on this test's PATH (process.run fails), so its row says so
  expect(all).toMatch(/RTK\s+\(Not Installed\)/)
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
  expect(marks).toEqual({ todo: ['Register GA dimensions'], done: ['Export PNGs at matched size', 'Ship build 1.0022'] })
  const out = L.applyMarks([card(1, 'Export PNGs at matched size', 'doing')], marks, 9)
  expect(out.map(t => [t.title, t.status])).toEqual([
    ['Export PNGs at matched size', 'done'],
    ['Register GA dimensions', 'todo'],
    ['Ship build 1.0022', 'done'],
  ])
  expect(L.boardMarks(undefined)).toEqual({ todo: [], done: [] })
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
  expect(await board()).toMatch(/DOING 1 \| 1 \| \S+ \[Haiku\] Find board sync hooks/)
  await $.turn.complete({ agentId: 'a1', answer: 'found' } as any)
  expect(await board()).toMatch(/DONE 1 \| 1 \| ✔ \[Haiku\] Find board sync hooks/)
  await $.turn.complete({ answer: 'Registered.\nDone: Register GA dimensions' } as any)
  expect(await board()).toContain('2/2 done')
})

test('token saved: each tool reads active, not active or not installed', () => {
  const skills = ['graft', 'caveman', 'ponytail']
  // installed and running
  expect(L.toolState('graft', [{ server: 'graft' }], 5, 0, skills)).toBe('active')
  expect(L.toolState('caveman', [], 5, 0, skills, true)).toBe('active')
  expect(L.toolState('ponytail', undefined, undefined, 0, skills)).toBe('active')
  // installed, but off: the Graft skill without its server, Caveman with its toggle off
  expect(L.toolState('graft', [{ server: 'other' }], 5, 0, skills)).toBe('inactive')
  expect(L.toolState('caveman', [], 5, 900, skills, false)).toBe('inactive')
  // not installed
  expect(L.toolState('graft', [{ server: 'other' }], 5, 0, ['caveman'])).toBe('missing')
  expect(L.toolState('caveman', [], 5, 0, ['graft'], true)).toBe('missing')
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
