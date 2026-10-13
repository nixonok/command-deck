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
    expect(all).toContain('Did a thing')
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
