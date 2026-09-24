import type { Clock, EventInput } from '../types.js'

/** How an effect ended, including a transport result whose external outcome cannot be proven. */
export type EffectOutcome = 'ok' | 'error' | 'aborted' | 'unknown'

export type EffectHandle = {
  readonly effectId: string
  /** The row that announces the effect. Written before anything leaves the process. */
  readonly intent: EventInput
  /** The row that closes it, written in the same transaction as whatever the effect produced. */
  settle(outcome: EffectOutcome): EventInput
}

/**
 * The effect sandwich, spelled once. Everything the kernel does outside its own process announces
 * itself with an `effect/intent` before it happens and closes with an `effect/settled` after, both
 * carrying the same `effectId` and the wall time between them. That pair is the only thing that
 * makes an unfinished effect visible to a resume, so it is not a bookkeeping detail: an intent with
 * no settlement is precisely the state 06 has to reconcile.
 *
 * It exists as one object because the two hand-written spellings of it had already drifted — one of
 * them settled `'aborted'` for a plain failure, which told the ledger a call nobody cancelled had
 * been cancelled.
 */
export class EffectRuntime {
  constructor(
    private readonly o: {
      ev(type: string, data: unknown): EventInput
      clock: Clock
      effectId(): string
    },
  ) {}

  /** Mints the id, stamps the start time, and hands back both rows of the sandwich. */
  start(body: Record<string, unknown>): EffectHandle {
    const effectId = this.o.effectId()
    const started = this.o.clock()
    return {
      effectId,
      intent: this.o.ev('effect/intent', { effectId, ...body }),
      settle: (outcome: EffectOutcome): EventInput =>
        this.o.ev('effect/settled', { effectId, outcome, durationMs: this.o.clock() - started }),
    }
  }
}

/**
 * Which outcome a finished effect gets. An unknown external result outranks being cut short, being
 * cut short outranks failing, and failing outranks success. A call may satisfy more than one of
 * these flags while unwinding; the ledger must retain the least replay-safe interpretation.
 */
export function effectOutcome(r: { unknown?: boolean; aborted?: boolean; failed?: boolean }): EffectOutcome {
  return r.unknown ? 'unknown' : r.aborted ? 'aborted' : r.failed ? 'error' : 'ok'
}
