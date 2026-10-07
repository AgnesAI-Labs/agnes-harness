import type {
  CompactionEngineInstance,
  CompactionInput,
  CompactionModelPort,
  CompactionOutput,
  CompactionPlan,
  HookPayloadMap,
} from '@agnes/extension-api'
import type { CompactionPort } from './session.js'
import { CoreError } from '../types.js'
type BeforeCompactPayload = HookPayloadMap['before_compact']
type CompactPayload = HookPayloadMap['compact']

type RunnerOptions = {
  engine?: CompactionEngineInstance
  plan(
    payload: BeforeCompactPayload,
    config: Readonly<{ keepRecentTokens: number }>,
  ): Promise<CompactionPlan | null>
  onCompact(payload: CompactPayload): Promise<void>
}

const HYSTERESIS_MARGIN_FRACTION = 0.5
// The longest a route that failed outright is spared another threshold compaction, in turns.
const MAX_SUSPENDED_TURNS = 8
const CACHE_WARM_RATIO = 0.5
function isCacheWarm(cache?: { cacheRead: number; input: number }): boolean {
  if (!cache) return false
  const total = cache.cacheRead + cache.input
  return total > 0 && cache.cacheRead / total >= CACHE_WARM_RATIO
}

/** The policy half is injected; this class owns only threshold and overflow mechanism decisions. */
export class CompactionRunner implements CompactionPort {
  readonly runnable = true
  // Session-lifetime, not durable: the worst a process restart costs is losing one deferral (the
  // very next over-threshold check compacts immediately instead of waiting), never the reverse. A
  // durable flag would need a ledger row of its own for a one-shot grace period that is cheap to
  // simply redo if a restart happens to land inside it.
  private deferredOnce = false
  // Not durable, for the same reason: consecutive transient summary failures of threshold
  // compactions within one turn. A restart forgets them, which costs at most one more retry.
  transientFailures = 0
  transientTurn: number | undefined
  // Not durable either: consecutive threshold compactions whose route could not work at all (bad
  // credentials, exhausted quota, a misconfigured model), and the last turn that is spared another
  // attempt. A restart forgets both, which costs one more failing request, never a missed overflow
  // compaction, which is never held back.
  unavailableFailures = 0
  suspendedThrough = 0

  readonly options: RunnerOptions
  constructor(options: Omit<RunnerOptions, 'plan'> & { plan?: RunnerOptions['plan'] }) {
    this.options = { ...options, plan: options.plan ?? (async () => null) }
  }

  /** Whether threshold compaction is held back this turn after the route failed outright. */
  suspended(turn: number): boolean {
    return turn <= this.suspendedThrough
  }

  /** Spares the next 1, 2, 4, 8, 8, ... turns another attempt, so a broken route is retried ever more rarely. */
  suspend(turn: number): void {
    this.unavailableFailures++
    this.suspendedThrough = turn + Math.min(2 ** (this.unavailableFailures - 1), MAX_SUSPENDED_TURNS)
  }

  shouldCompact(p: {
    contextTokens: number
    contextWindow: number
    reserveTokens: number
    cache?: { cacheRead: number; input: number }
  }): boolean {
    if (this.options.engine) return this.options.engine.shouldCompact(p)
    if (!Number.isFinite(p.reserveTokens) || p.reserveTokens < 0)
      throw new CoreError('E_ENVELOPE', 'compaction reserveTokens must be nonnegative')
    const over = p.contextTokens - (p.contextWindow - p.reserveTokens)
    if (over <= 0) {
      this.deferredOnce = false
      return false
    }
    // "Marginal" is scaled to the preset's own declared safety margin rather than an absolute
    // token count, so a preset with a small reserve does not get a proportionally huge grace band
    // and one with a large reserve does not get a proportionally tiny one.
    const marginal = over <= p.reserveTokens * HYSTERESIS_MARGIN_FRACTION
    if (marginal && isCacheWarm(p.cache) && !this.deferredOnce) {
      // One more request gets to spend the warm cache it is about to lose; the next
      // over-threshold check, whichever turn it falls in, compacts regardless of warmth.
      this.deferredOnce = true
      return false
    }
    this.deferredOnce = false
    return true
  }

  async compact(
    input: CompactionInput,
    ports: { signal: AbortSignal; model: CompactionModelPort },
  ): Promise<CompactionOutput | null> {
    ports.signal.throwIfAborted()
    if (this.options.engine) return this.options.engine.compact(input, ports)
    const plan = await this.options.plan?.(input.beforeCompact, {
      keepRecentTokens: input.budget.keepRecentTokens,
    })
    return plan ? { kind: 'plan', plan } : null
  }

  onOverflow(): 'compaction' {
    return 'compaction'
  }
}
