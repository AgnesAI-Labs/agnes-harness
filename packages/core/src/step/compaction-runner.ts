import type {
  CompactionEngineInstance,
  CompactionInput,
  CompactionModelPort,
  CompactionOutput,
  CompactionPlan,
  HookPayloadMap,
} from '@agnes/extension-api'
import { createCompactionThreshold } from '@agnes/extension-api'
import { CoreError } from '../types.js'
import type { CompactionPort } from './session.js'

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

const MAX_SUSPENDED_TURNS = 8

/** The policy half is injected; this class owns only threshold and overflow mechanism decisions. */
export class CompactionRunner implements CompactionPort {
  readonly runnable = true
  private readonly threshold = createCompactionThreshold((message) => new CoreError('E_ENVELOPE', message))
  // Session-local, like threshold hysteresis: consecutive transient summary failures of threshold
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
    return this.threshold(p)
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
