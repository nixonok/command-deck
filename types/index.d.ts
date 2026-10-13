export type Tier = 'haiku' | 'sonnet' | 'opus'
export type Status = 'todo' | 'doing' | 'done' | 'failed'

export type Task = {
  id: number
  title: string
  tier: Tier
  why: string
  status: Status
  tokens: number
  startedAt?: number
  endedAt?: number
  note?: string
  parallel?: boolean
}

export type Plan = {
  isClear: boolean
  questions: string[]
  prompt: string
  tasks: { title: string; tier: Tier; why: string; parallel: boolean }[]
}

export type GitInfo = {
  branch: string
  upstream: string
  ahead: number
  behind: number
  branches: { name: string; upstream: string; track: string }[]
  dirty: string[]
}

export type Savings = {
  graft: number
  optimizer: number
  caveman: number
  // Command Deck's own savings, in input-token equivalents
  keepwarm: number
  fresh: number
  routing: number
  tools: number
}

export type CtxPart = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }
export type CtxServer = { server: string; tokens: number; loaded: number }

export type Limits = {
  fiveHour?: { pct: number; resetsAt?: string }
  sevenDay?: { pct: number; resetsAt?: string }
  ctxTokens?: number
  ctxWindow: number
  ctxPct: number
  usd?: number
  parts?: CtxPart[]
  servers?: CtxServer[]
  skillTokens?: number
}

export type Learn = { tip: string; text: string; isLoading: boolean; isSaved: boolean }

/** An answer being written: `text` is what was added with Enter, `typing` the line in the field, `rev` remounts the field after each add. */
export type Draft = { choice?: string; text: string; typing?: string; rev?: number }

export type Hist = { at: number; title: string; tier: Tier; status: string; tokens: number }

export type Pending = { ask: string; answers: string[]; questions: string[] }

declare module 'claude-code' {
  interface PluginState {
    'command-deck': {
      tasks: Task[]
      goal: string
      pending: Pending | null
      usage: Record<string, number>
      savings: Savings
      cave: boolean
      clean: boolean
      git: GitInfo | null
      limits: Limits
      frame: number
      tip: number
      auto: boolean
      learn: Learn | null
      draft: Record<string, Draft>
      answered: boolean
      min: Record<string, boolean>
      order: string[] | null
      history: Hist[]
    }
  }
}
