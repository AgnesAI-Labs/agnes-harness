import type { JsonValue } from '@agnes/protocol/gen/session-v1'
import type { CompactionPlan, HookPayloadMap } from './hooks.js'

export type CompactionBudget = Readonly<{
  contextTokens: number
  contextWindow: number
  reserveTokens: number
  cache?: { cacheRead: number; input: number }
}>

/** The visible conversation, never masked ledger rows. System context stays outside the range. */
export type CompactionNode = Readonly<{
  seq: number
  kind: 'user' | 'assistant' | 'tool_result' | 'summary'
  turn: number
  pinned: boolean
  tokensEstimate: number
  data: JsonValue
}>

export type CompactionInput = Readonly<{
  conversation: readonly CompactionNode[]
  system: string
  budget: CompactionBudget & { keepRecentTokens: number }
  /** Also preserves the existing before_compact planner vocabulary. */
  beforeCompact: HookPayloadMap['before_compact']
}>

export type CompactionReplacement = Readonly<{
  kind: 'replacement'
  range: readonly [number, number]
  text: string
  mode: 'summary' | 'elision'
}>

/** Core executes summary plans with its existing retry, usage and fallback policy. */
export type CompactionOutput = CompactionReplacement | { kind: 'plan'; plan: CompactionPlan }

export interface CompactionModelPort {
  /** Summarize a pair-closed range with safe request derivation and budget/usage accounting. */
  summarize(
    request: {
      range: readonly [number, number]
      system: string
      instruction: string
      maxTokens: number
    },
    signal?: AbortSignal,
  ): Promise<string>
}

export interface CompactionEngineInstance {
  dispose?(): void | Promise<void>
  shouldCompact(budget: CompactionBudget): boolean
  compact(
    input: CompactionInput,
    ports: { signal: AbortSignal; model: CompactionModelPort },
  ): Promise<CompactionOutput | null>
}

/** Register from an ordinary plugin that injects compactionEngines. Instances are Host-owned. */
export interface CompactionEngine {
  readonly id: string
  readonly version: string
  create(signal?: AbortSignal): CompactionEngineInstance | Promise<CompactionEngineInstance>
  cleanup?(): void | Promise<void>
}

export type CompactionEngineCatalogEntry = Readonly<{
  id: string
  version: string
  sourcePackage: string
}>

export interface CompactionEngineRegistration {
  register(engine: CompactionEngine): () => Promise<void>
  catalog(): readonly CompactionEngineCatalogEntry[]
}

export type CompactionEnginePluginContext = {
  compactionEngines: CompactionEngineRegistration
}

/** Experimental default threshold: at most one marginal warm-cache deferral per instance.
 * Session-local state; restart can forget one grace period, never suppress overflow compaction. */
export function createCompactionThreshold(
  invalid: (message: string) => Error = (message) =>
    Object.assign(new Error(message), { code: 'E_ENVELOPE' }),
): (budget: CompactionBudget) => boolean {
  let deferredOnce = false
  return (budget) => {
    if (!Number.isFinite(budget.reserveTokens) || budget.reserveTokens < 0)
      throw invalid('compaction reserveTokens must be nonnegative')
    const over = budget.contextTokens - (budget.contextWindow - budget.reserveTokens)
    if (over <= 0) {
      deferredOnce = false
      return false
    }
    const cache = budget.cache
    const total = cache ? cache.cacheRead + cache.input : 0
    const warm = !!cache && total > 0 && cache.cacheRead / total >= 0.5
    if (over <= budget.reserveTokens * 0.5 && warm && !deferredOnce) {
      deferredOnce = true
      return false
    }
    deferredOnce = false
    return true
  }
}
