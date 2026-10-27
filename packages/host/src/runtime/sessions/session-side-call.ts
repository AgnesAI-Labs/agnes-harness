import { randomUUID } from 'node:crypto'
import {
  type ChildControlStore,
  type CostLedger,
  capToMicrocredits,
  chargeToMicrocredits,
  conservativeModelCredits,
  hasChildControl,
} from '@agnes/core'
import type { InferenceEvent, ModelRecord } from '@agnes/protocol'
import { bestEffort } from '../../best-effort.js'
import type { HostSession } from '../lifecycle/host.js'

/** What one provider call produced; `failure` is what went wrong once the provider was called. */
export type SideCallRun = {
  text: string
  usage?: Extract<InferenceEvent, { type: 'usage' }>
  completed: boolean
  failure?: unknown
}

export type SideCall = {
  /** Names the cost row: its effect id is `<label>:<uuid>`. */
  label: string
  route: string
  modelId: string
  model: ModelRecord
  /** The hold is max(billingProjected, conservativeModelCredits(tokensEstimate, outputEstimate, cost)). */
  tokensEstimate: number
  outputEstimate: number
  cap: number | null
  requestHash: string
  /** The latest turn start: the tree-budget root and the row's `sourceTurn`. */
  start: { seq: number; data: unknown } | undefined
  /**
   * With a tree budget and no turn to root it in: `refuse` (the default) refuses the call; `unbudgeted`
   * runs it outside the tree budget, for a call that is not part of any turn (voice on a new chat).
   */
  withoutTurn?: 'refuse' | 'unbudgeted'
  /** The row's tokens when no usage event arrived. */
  estimatedTokens(text: string): CostLedger['tokens']
  /** The provider call itself; it reports a failure in the result instead of throwing. */
  run(signal: AbortSignal): Promise<SideCallRun>
}

/**
 * The accounting around one model call outside the conversation: the per-request cap, the tree-budget
 * reservation, one `side-call` cost row, settlement and billing. A refusal or an abort before the
 * provider is called appends nothing and releases its reservation. Once the provider was called a
 * timeout, cancel or provider error still appends the row (interrupted, with estimated tokens when no
 * usage arrived) because the vendor may bill it, and the failure is rethrown after accounting.
 */
export async function accountedSideCall(
  s: HostSession,
  call: SideCall,
  signal: AbortSignal,
  refuse: (code: 'budget' | 'timeout', message: string) => Error,
): Promise<SideCallRun> {
  const stopped = () => refuse('timeout', 'the call was cancelled or timed out')
  let permit: { store: ChildControlStore; id: string } | undefined
  try {
    const projected = await abortable(
      s.d.runtime.billingProjected({ tokensEstimate: call.tokensEstimate, model: call.modelId }),
      signal,
      stopped,
    )
    const hold = Math.max(
      projected.credits,
      conservativeModelCredits(call.tokensEstimate, call.outputEstimate, call.model.cost),
    )
    if (!Number.isFinite(hold) || (call.cap !== null && hold > call.cap))
      throw refuse('budget', 'the call exceeds the per-request budget')
    const effectId = `${call.label}:${randomUUID()}`
    const { start } = call
    if (s.preset.treeBudgetCredits !== null && (start || call.withoutTurn !== 'unbudgeted')) {
      const store = s.d.log.storage
      if (!hasChildControl(store) || !start) throw refuse('budget', 'tree budget unavailable for a side call')
      const rootTaskId = `${s.key}:${s.lane}:${start.seq}`
      const scope = await store.ensureRootScope(rootTaskId, capToMicrocredits(s.preset.treeBudgetCredits))
      const reserved = await store.reserve({
        rootTaskId,
        scopeIds: [scope.scopeId],
        qMicro: chargeToMicrocredits(hold),
        effectId,
        requestHash: call.requestHash,
        writerGeneration: (await store.writerGeneration?.(rootTaskId)) ?? 1,
      })
      if (!reserved.ok) throw refuse('budget', 'tree budget exhausted')
      permit = { store, id: reserved.permitId }
    }
    if (signal.aborted) throw stopped()

    // From here the provider may bill whatever happens next, so a failure is still accounted.
    let result: SideCallRun
    try {
      result = await call.run(signal)
    } catch (error) {
      result = { text: '', completed: false, failure: error }
    }
    if (!result.failure && signal.aborted && !result.completed) result = { ...result, failure: stopped() }
    const { usage, completed } = result

    const turn = (start?.data as { turn?: number } | undefined)?.turn
    const spend: CostLedger = {
      purpose: 'side-call',
      ...(typeof turn === 'number' && turn >= 1 ? { sourceTurn: turn } : {}),
      effectId,
      model: call.modelId,
      route: call.route,
      tokens: usage?.tokens ?? call.estimatedTokens(result.text),
      creditSource: usage?.creditSource ?? 'estimated',
      ...(usage?.credits === undefined ? {} : { credits: usage.credits }),
      ...(usage?.billing ? { billing: usage.billing } : {}),
      ...(!completed ? { interrupted: true } : {}),
    }
    // The append is the durable fact; if it fails the reservation is released by the finally below.
    const appended = await s.locked(() => s.append([s.ev('cost/ledger', spend)]))
    if (permit) {
      await permit.store.settleOrigin({
        permitId: permit.id,
        originSessionKey: s.key,
        originCostSeq: appended.firstSeq,
        actualMicro: usage?.credits === undefined ? null : chargeToMicrocredits(usage.credits),
        complete: usage?.credits !== undefined,
        creditSource: usage?.creditSource ?? 'unknown',
      })
      permit = undefined
    }
    await s.d.runtime.billingRecord({
      ...spend,
      sessionKey: s.key,
      lane: s.lane,
      turn: typeof turn === 'number' ? turn : 0,
      step: 0,
    })
    if (result.failure) throw result.failure
    return result
  } finally {
    // Still held only when the provider was never called or accounting itself failed.
    if (permit)
      await permit.store
        .releaseReservation(permit.id)
        .catch(bestEffort(s.d.logger, 'side-call-reservation-release'))
  }
}

/** An uncooperative adapter must not hold the request open past its deadline. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(onAbort())
  })
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) abort()
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
