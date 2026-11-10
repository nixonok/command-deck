// Engineering guidelines, split into an always-on core and tagged sections.
// A plain keyword selector picks sections per step and tier. No model call.
import type { Plan, Tier } from '../types'

export const CORE = `Engineering rules (own the outcome: correct, readable, tested, safe to change):
- Read the callers, tests and conventions before editing. Search before reading whole files.
- Design before code: name the contract, give each piece of state one owner, point dependencies one way, no cycles.
- Never invent APIs, libraries, flags or requirements. Check the installed version.
- Unclear and risky: ask one focused question. Otherwise state the assumption and go.
- Smallest coherent change that fully solves it. Deletion beats addition. No drive-by refactor, reformat or new dependency; keep unrelated uncommitted work.
- Fix the root cause once, in the shared code. Reuse before writing new.
- Validate input at the boundary. Never swallow a failure or fake a success. Secrets never in source or logs.
- Tests pin observable behaviour. Run the tests, build and lint that apply; report what was verified and what was not.
- Comments say why, not what. No dead or commented-out code.
- Same fix fails twice: stop and change approach.
- Before done, read your own diff: only requested changes, no stray files.`
// Core must stay under this many words; deck.test.ts checks it.
export const CORE_MAX_WORDS = 260

export type Section = {
  id: string
  /** Matches the step title/why. */
  tags: RegExp
  /** Cheapest tier that gets this section; cheaper tiers get core only. */
  minTier: Tier
  /** One line for the final-pass checklist. */
  check: string
  text: string
}

export const SECTIONS: Section[] = [
  {
    id: 'bug',
    tags: /\b(bug|fix|crash|broken|regress|fail(?:s|ing|ure)?|error|blank|nothing)\b/i,
    minTier: 'sonnet',
    check: 'bug reproduced first and a test now covers it',
    text: 'Bug: reproduce it with a failing test, find the cause, fix it, see the test pass. Never patch a guess.',
  },
  {
    id: 'feature',
    tags: /\b(add|build|create|implement|new feature|support|introduce)\b/i,
    minTier: 'sonnet',
    check: 'contract, invariants and 3 failure modes considered',
    text: 'Feature: name the contract and invariants. List 3 failure modes (empty, boundary, repeat or concurrent) before calling it correct. Test the new behaviour.',
  },
  {
    id: 'refactor',
    tags: /\b(refactor|restructure|extract|split|decouple|migrat\w*|consolidate|clean ?up)\b/i,
    minTier: 'sonnet',
    check: 'behavior unchanged, invariants rechecked',
    text: 'Refactor: list the invariants, add characterization tests, then move the code with no behaviour change. Recheck the invariants after.',
  },
  {
    id: 'design',
    tags: /\b(architect\w*|design|module|layer\w*|dependenc\w*|interface|abstraction|boundary|boundaries|coupling)\b/i,
    minTier: 'opus',
    check: 'dependencies point one way, abstraction removes complexity',
    text: 'Design: dependencies point one way, no cycles. Keep domain logic apart from I/O and UI. Prefer composition. Abstract only a stable concept: copying beats a wrong abstraction. Weigh a simpler option with the same guarantees and state the trade-off.',
  },
  {
    id: 'perf',
    tags: /\b(perf\w*|slow|fast|latency|memory|alloc\w*|optimi[sz]\w*|frame ?rate|fps|cache|retry|queue)\b/i,
    minTier: 'sonnet',
    check: 'measured before and after',
    text: 'Perf: measure before and after on the slow path, under load. No guessing. Cap queues. Retry with backoff and jitter, never a tight loop. Do not trade clarity for unmeasured speed.',
  },
  {
    id: 'security',
    tags: /\b(secur\w*|auth\w*|token|password|secret|credential|inject\w*|sanitiz\w*|permission|encrypt\w*|untrusted)\b/i,
    minTier: 'sonnet',
    check: 'untrusted input validated, no secret exposed',
    text: 'Security: validate untrusted input at the boundary. Parameterized queries only. Proven mechanisms, never custom crypto. Secrets stay out of source, logs and VCS.',
  },
  {
    id: 'risky',
    tags: /\b(delet\w*|remov\w*|drop|push|force|reset|overwrite|migrat\w*|deploy|release|publish|rm -rf|irreversible)\b/i,
    minTier: 'sonnet',
    check: 'irreversible steps were approved first',
    text: 'Risky: plan first. Ask before delete, push, migrate or overwrite. Inspect the target before destroying it. Work on a branch, never main.',
  },
  {
    id: 'test',
    tags: /\b(tests?|coverage|spec|assert\w*|verify|verification)\b/i,
    minTier: 'sonnet',
    check: 'tests assert behavior, and were actually run',
    text: 'Tests: assert observable behaviour, not internals. Cover the edge cases. Claim a check passed only after running it and reading the result.',
  },
]

const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 }
/** Most extra sections one step may pull in; cheaper tiers pull fewer. */
const MAX_EXTRA: Record<Tier, number> = { haiku: 0, sonnet: 2, opus: 4 }

export type Pick = { step: number; tier: Tier; sections: string[] }

/** Sections that fit one step: tag match, tier allowed, capped by tier budget, in table order. */
export function pickForStep(title: string, why: string, tier: Tier): string[] {
  const text = `${title} ${why}`
  return SECTIONS.filter(s => RANK[tier] >= RANK[s.minTier] && s.tags.test(text))
    .slice(0, MAX_EXTRA[tier])
    .map(s => s.id)
}

export function pickForPlan(plan: Plan): Pick[] {
  return plan.tasks.map((t, i) => ({ step: i + 1, tier: t.tier, sections: pickForStep(t.title, t.why, t.tier) }))
}

const byId = (id: string) => SECTIONS.find(s => s.id === id)

/** Step-specific rules for a plan: each chosen section once, tagged with the steps that need it. Empty when no step needs one. */
export function guidelineExtras(plan: Plan): string {
  const used = new Map<string, number[]>()
  for (const p of pickForPlan(plan)) for (const id of p.sections) used.set(id, [...(used.get(id) ?? []), p.step])
  if (!used.size) return ''
  return ['Extra engineering rules for specific steps:', ...[...used].map(([id, steps]) => `(steps ${steps.join(',')}) ${byId(id)!.text}`)].join('\n')
}

/** Run once after the last step, never per step. */
export function finalPass(plan: Plan): string {
  const ids = [...new Set(pickForPlan(plan).flatMap(p => p.sections))]
  const checks = ids.map(id => byId(id)!.check)
  return [
    'Final pass (once, after the last step, not per step): review the whole diff against these. Fix or report each miss.',
    '- Only the requested change; no stray files; unrelated work kept.',
    '- Checks that apply were run and their results seen.',
    ...checks.map(c => `- ${c}`),
    '- Remaining risks and unverified parts are stated.',
  ].join('\n')
}

/** Unity projects, C# steps only (planContext gates it). Subagents see nothing but their prompt, so the main agent must paste this into each C# subagent's prompt. */
export const UNITY_RULES = [
  'Unity C# rules (paste into the prompt of every subagent that writes or edits C#; new and edited code only, never decided by asking):',
  '- Scene and prefab first: anything an artist may move, size or time (position, gap, angle, arc, duration) is a serialized field or an object in the scene or prefab, with a [Tooltip] and a Scene-view gizmo when spatial. Code reads it and holds no coordinates or layout numbers; it creates no layout objects at runtime unless the same object is also in the scene.',
  '- One prefab per repeated block: a UI block that appears twice or more (seat, card row, popup, score panel, button group) is one prefab in Common with its look as fields. Scenes hold instances; a game that differs uses a variant or overrides, never a pasted copy. Before building UI, list the prefabs that already exist.',
  '- Reuse first: search Common and the other games for an existing component. A second game that needs one moves it into Common as a configurable component. Merge near-identical scripts or objects into Common before building on them; never copy a script between games.',
  '- References: [SerializeField] links set in the prefab or scene. No GetComponent, AddComponent, GetChild, Find*, FindObjectOfType or Camera.main in gameplay code; when unavoidable, look it up once in Awake or Start and cache it. A missing link logs a red error naming the object.',
  '- Hot paths (Update, FixedUpdate, LateUpdate, OnGUI) allocate nothing: no lookups, LINQ, string concatenation or new collections. React to events, never poll. Look up by key in a Dictionary or HashSet cached outside the hot path.',
  '- Pool what spawns or shows repeatedly: reuse inactive instances and deactivate instead of Destroy. Things spawned from code are prefabs.',
  '- DOTween: every tween gets .SetLink(gameObject). Use a Sequence only to chain tweens. A timer is a stored DOVirtual.DelayedCall, killed before rescheduling and in teardown.',
  '- Structure: one owner per state; others read it or listen to its event, never copy it. Simple over clever: no base class, generic or pattern until two real users. One component, one job. Shared numbers live in one ScriptableObject or parent prefab field. Screens are small nested prefabs; a variant differs only by overrides. UI takes events or serialized refs, not singletons.',
  '- Children follow parents: a highlight, glow, label or popup is a child of what it marks. A follow script only when a child is impossible (world-space particles). Draw order is sibling order, not a code offset.',
  '- Hierarchy: group objects under coloured Hierarchy Header dividers (Common/Scripts/Layout/HierarchyHeader), one per section, in every scene; the same section kind has the same colour in every scene (it comes from the header name via HierarchyHeaderPalette; menu Card Adda > Hierarchy > Apply Header Colours To All Scenes). No unused, duplicate or disabled-leftover objects. Name objects by their job, never default or "(N)" names. Delete an object only after proving zero references; list what was deleted.',
  '- UI: anchors for static layouts; layout groups only for dynamic lists, never nested. Static and changing UI on separate canvases; Raycast Target off on non-interactive graphics.',
  '- Names: serialized mUpperCamel, private _lowerCamel, locals lowerCamel, enum members ALL_UPPER, bools is/can/has, callbacks on...Callback, type suffixes Go/Trans/Cg/Image/Button/Text/Tween. Methods start with a verb. Guard clauses first. No var. One LINQ call per line. Comment only a non-obvious why. Nullable values carry [CanBeNull] (JetBrains.Annotations).',
  '- Performance and Android: measure before and after on the lowest-spec device. Trim pools on scene change; Incremental GC on; compressed GPU textures per platform; Resources folder lean, bulk content in Addressables; raise code stripping only with a build test; ship an App Bundle (AAB).',
  '- Game doc: each game keeps GAMEPLAY_LOOP.md (entry point, loop, seats, where to edit visuals); update it with the change.',
  '- Hooks block Camera.main, GameObject.Find*, FindObjectOfType and `new GameObject(` in added Minigames C#, and text edits of .meta, .unity and .prefab: change scenes through Unity instead. A line with `allow-deck: <reason>` is skipped.',
  '- Finish clean: delete the fields, objects and disabled leftovers your change replaces. End by saying in plain words what to move or change in the hierarchy to alter the result.',
].join('\n')
