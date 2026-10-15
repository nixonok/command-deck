// Engineering guidelines, split into an always-on core and tagged sections.
// A plain keyword selector picks sections per step and tier. No model call.
import type { Plan, Tier } from '../types'

export const CORE = `Engineering rules (own the outcome: correct, readable, tested, safe to change):
- Read the code, callers, tests and conventions before editing. Search before reading whole files.
- Never invent APIs, libraries, flags or requirements. Check a call exists in the installed version.
- Unclear and risky: ask one focused question. Else state the assumption and go.
- Make the smallest coherent change that fully solves it. No drive-by refactor, reformat or new dependency. Keep unrelated uncommitted work.
- Fix the root cause, not the symptom. Reuse before writing new.
- Handle errors out loud: no swallowed failure, no fake success. Secrets never in source or logs.
- Comments say why, not what. No dead or commented-out code.
- Run the tests, build and lint that apply. Report what was verified, not what was attempted; say what you could not check.
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
    text: 'Bug: reproduce first. Write a failing test, fix, see it pass. Find the cause before patching.',
  },
  {
    id: 'feature',
    tags: /\b(add|build|create|implement|new feature|support|introduce)\b/i,
    minTier: 'sonnet',
    check: 'contract, invariants and 3 failure modes considered',
    text: 'Feature: name the contract and invariants. List 3 failure modes (empty, boundary, repeat or concurrent) before calling it correct. Add a test for new behavior.',
  },
  {
    id: 'refactor',
    tags: /\b(refactor|restructure|extract|split|decouple|migrat\w*|consolidate|clean ?up)\b/i,
    minTier: 'sonnet',
    check: 'behavior unchanged, invariants rechecked',
    text: 'Refactor: list invariants first. Add characterization tests before moving code. No behavior change. Recheck invariants after.',
  },
  {
    id: 'design',
    tags: /\b(architect\w*|design|module|layer\w*|dependenc\w*|interface|abstraction|boundary|boundaries|coupling)\b/i,
    minTier: 'opus',
    check: 'dependencies point one way, abstraction removes complexity',
    text: 'Design: keep dependencies one-way and no cycles. Keep domain logic apart from I/O and UI. Prefer composition. Abstract only when the concept is stable; copying beats a wrong abstraction. Weigh a simpler option with the same guarantees and state the trade-off.',
  },
  {
    id: 'perf',
    tags: /\b(perf\w*|slow|fast|latency|memory|alloc\w*|optimi[sz]\w*|frame ?rate|fps|cache|retry|queue)\b/i,
    minTier: 'sonnet',
    check: 'measured before and after',
    text: 'Perf: measure before and after; no guessing. Split slow-alone from slow-under-load. Cap queues. Retry with backoff and jitter, never a tight loop. Do not trade clarity for unmeasured speed.',
  },
  {
    id: 'security',
    tags: /\b(secur\w*|auth\w*|token|password|secret|credential|inject\w*|sanitiz\w*|permission|encrypt\w*|untrusted)\b/i,
    minTier: 'sonnet',
    check: 'untrusted input validated, no secret exposed',
    text: 'Security: validate untrusted input at the boundary. Use proven mechanisms, never custom crypto. Parameterized queries only. Keep secrets out of source, logs and VCS.',
  },
  {
    id: 'risky',
    tags: /\b(delet\w*|remov\w*|drop|push|force|reset|overwrite|migrat\w*|deploy|release|publish|rm -rf|irreversible)\b/i,
    minTier: 'sonnet',
    check: 'irreversible steps were approved first',
    text: 'Risky: plan first. Ask before delete, push, migrate or overwrite. Look at the target before destroying it. Work on a branch, never main.',
  },
  {
    id: 'test',
    tags: /\b(tests?|coverage|spec|assert\w*|verify|verification)\b/i,
    minTier: 'sonnet',
    check: 'tests assert behavior, and were actually run',
    text: 'Tests: assert observable behavior, not internals. Cover edge cases. Never claim a check passed unless you ran it and saw the result.',
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

/** Unity projects only. Subagents see nothing but their prompt, so the main agent must paste this into each C# subagent's prompt. */
export const UNITY_RULES = [
  'Unity C# rules (paste into the prompt of every subagent that writes or edits C#; apply to new and edited code only, never decide by asking):',
  '- References: [SerializeField] private fields linked in the prefab or scene. No GetComponent, AddComponent, GetChild, Find*, FindObjectOfType or Camera.main; if one is unavoidable, do it once in Awake or Start and cache it.',
  '- Hot paths (Update, FixedUpdate, LateUpdate, OnGUI): no lookups, LINQ, string concat or new collections. Use events, not polling. Look up by key with Dictionary or HashSet.',
  '- Pool anything spawned or shown repeatedly (reuse inactive instances, deactivate instead of Destroy). Spawned-from-code things are prefabs.',
  '- Names: serialized mUpperCamel, private _lowerCamel, locals lowerCamel, enum members ALL_UPPER, bools is/can/has, callbacks on...Callback, type suffixes Go/Trans/Cg/Image/Button/Text/Tween.',
  '- Methods start with a verb. Guard clauses first as one-line if-return. No var. One LINQ call per line. Comment only a non-obvious why.',
  '- DOTween: every tween gets .SetLink(gameObject); Sequence only to chain several tweens; timers are a stored DOVirtual.DelayedCall, killed before rescheduling and in teardown.',
  '- Mark nullable things [CanBeNull] (JetBrains.Annotations).',
  '- Scene first: anything an artist may move (position, rotation, scale, gap, angle, arc, timing) is an object or a component field in the scene or prefab, with a [Tooltip] and a Scene-view gizmo when it is spatial. Code reads it and animates between such objects; code holds no coordinates, no magic layout numbers, and creates no layout objects at runtime unless the same object is also baked into the scene.',
  '- Reuse first: search Common and the other games for an existing component before writing one. A second game needing the same thing moves it into Common as a configurable component; never copy a script between games.',
  '- Prefab first: a UI block that appears twice or more (a seat, a card row, a popup, a score panel, a button group) is ONE prefab in Common, with its look as component fields. Scenes hold instances; a game that differs uses a prefab variant or overridden fields, never a pasted copy. Before building UI, list the prefabs that already exist. If two games hold near-identical objects or scripts, merge them into Common first, then use that.',
  '- Children follow parents: a highlight, glow, label or popup is a CHILD of the object it marks, so it moves with it. Use a follow script only when a child is impossible (world-space particles). Draw order is sibling order in the hierarchy, not a code offset.',
  '- Hierarchy sections: group scene objects under coloured Hierarchy Header dividers (Common/Scripts/Layout/HierarchyHeader), one per section, in every new scene. No unused, duplicate or disabled-leftover objects: prove zero references before deleting and list what was deleted.',
  '- Game doc: each game keeps a GAMEPLAY_LOOP.md (entry point, loop, seats, where to edit visuals); update it with the change.',
  '- Structure: one owner per state (others read it or listen to its event, never copy it). Simple over clever: no base class, generic or pattern until two real users. One component, one job. Shared numbers live in one ScriptableObject or parent prefab field. Screens are small nested prefabs; a variant differs only by overrides. UI uses events or serialized refs, not Instance singletons. A missing scene link logs a red error naming the object.',
  '- Hierarchy and UI: same section kind, same Header colour in every scene. No default or "(N)" names; name objects by their job. Anchors for static layouts, layout groups only for dynamic lists and never nested. Static and changing UI on separate canvases; Raycast Target off on non-interactive graphics.',
  '- Performance and Android: measure before and after on the lowest-spec device. Reuse cached collections, no per-frame allocations. Trim pools on scene change; Incremental GC on. Compressed GPU textures per platform. Resources folder lean; bulk content in Addressables. Raise code stripping only with a build test. Ship an App Bundle (AAB).',
  '- Hooks block Camera.main, GameObject.Find*, FindObjectOfType and `new GameObject(` in added Minigames C#, and text edits of .meta, .unity, .prefab: do not try them; change scenes through Unity. A line with `allow-deck: <reason>` is skipped.',
  '- Finish clean: delete the fields, objects and disabled leftovers your change replaces. End by stating in plain words what to move or change in the hierarchy to alter the result.',
].join('\n')
