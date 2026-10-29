import { CoreError, type Seq } from '@agnes/core-common/types'
import { settlesWithin } from '@agnes/core-effects/effects/wrap'
import type { SessionImpl } from '../step/session.js'
import { sessionIdentity } from './scope.js'

/** The longest the end of a turn waits for its side calls to settle. */
const SETTLE_MS = 5_000

/** A side call between its claim and its settlement, and how to cut it short. */
type Running = Readonly<{ turn: number; settled: Promise<void>; abort: () => void }>

/** Side calls running in this process, by session and effect id. */
const running = new WeakMap<object, Map<string, Running>>()
/**
 * The program counter cell of a turn whose end is waiting for its side calls. Any phase edge moves
 * the cell, so a mark left by an end that failed to commit refuses nothing in a later turn.
 */
const closing = new WeakMap<object, Seq>()

export const inFlight = () =>
  new CoreError('E_RELATION', 'Side call invocation is already running', { reason: 'invocation-in-flight' })

/** Whether a side call of this session is between its claim and its settlement. */
export function sideCallInFlight(s: SessionImpl): boolean {
  return (running.get(sessionIdentity(s))?.size ?? 0) > 0
}

/**
 * Claims an invocation id for a call in the open turn `turn`. The claim's signal aborts when the
 * turn ends under the call, and `release` reports the call settled. Refused while the id is already
 * running, and once the turn has begun to end.
 */
export function claimSideCall(s: SessionImpl, effectId: string, turn: number) {
  const owner = sessionIdentity(s)
  const mark = closing.get(owner)
  if (mark !== undefined && mark === s.opSeq())
    throw new CoreError('E_RELATION', 'The turn is ending', { reason: 'turn-closing' })
  const calls = running.get(owner) ?? new Map<string, Running>()
  if (calls.has(effectId)) throw inFlight()
  const controller = new AbortController()
  let release!: () => void
  const settled = new Promise<void>((resolve) => {
    release = resolve
  })
  calls.set(effectId, { turn, settled, abort: () => controller.abort() })
  running.set(owner, calls)
  return {
    signal: controller.signal,
    release() {
      calls.delete(effectId)
      if (!calls.size && running.get(owner) === calls) running.delete(owner)
      release()
    },
  }
}

/**
 * Runs before a turn ends, outside the session lock, because a settlement takes that lock. Marks the
 * turn as ending so no new call starts in it, cuts its calls in flight and waits, within a bound,
 * until each has written its settlement or late receipt; a cut call settles as cancelled by its
 * caller, or as aborted under a session stop. A call still running at the bound is named in a
 * diagnostic and the turn ends without it: a settlement it writes after that is refused, and its
 * effect stays pending for recovery.
 */
export async function settleSideCalls(s: SessionImpl, opSeq: Seq | null): Promise<void> {
  // Close ends the turn only after it has waited for this work and released the loop's scope.
  if (s.closingOrClosed && !s.loopScope.alive) return
  const owner = sessionIdentity(s)
  const turn = s.op()?.meta.turn
  const calls = [...(running.get(owner) ?? [])].filter(([, call]) => call.turn === turn)
  if (!calls.length || opSeq === null) return
  closing.set(owner, opSeq)
  for (const [, call] of calls) call.abort()
  const bound = Math.min(SETTLE_MS, s.d.closeDrainMs ?? SETTLE_MS)
  if (await settlesWithin(Promise.all(calls.map(([, call]) => call.settled)), bound)) return
  for (const [effectId, call] of calls)
    if (running.get(owner)?.get(effectId) === call)
      await s.diag('invariant', { kind: 'side-call-unsettled', effectId })
}
