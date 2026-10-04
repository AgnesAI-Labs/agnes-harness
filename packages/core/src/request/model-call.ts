import {
  type InferenceEvent,
  MODEL_CALL_EVENT,
  ModelCallRecord,
  ModelCallUsage,
  validateAgainst,
} from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'
import { canonicalJson } from './hash.js'
import { captureModelPriceQuote } from './model-pricing.js'

type Started = Extract<ModelCallRecord, { stage: 'started' }>
type Settled = Extract<ModelCallRecord, { stage: 'settled' }>
export type ModelCallAttribution = Pick<
  Started,
  'purpose' | 'parentEffectId' | 'route' | 'model' | 'sourceTurn' | 'sourceStep'
> & { id?: string }
export interface ModelCallHandle {
  readonly id: string
  readonly startedSeq: number
  observe(event: InferenceEvent): void
  settle(outcome: Settled['outcome']): Promise<void>
}

/**
 * Called only after the owner's existing effect/budget admission, immediately before infer.
 * The owner controls bounded cancellation and drains settlement before releasing its writer.
 * This records no cost delivery and must not wrap Jev's already canonical model.* records.
 */
export async function beginModelCall(
  session: SessionImpl,
  attribution: ModelCallAttribution,
): Promise<ModelCallHandle> {
  if (session.closingOrClosed) throw new CoreError('E_CLOSED', 'session closed')
  const ownerSignal = session.ac.signal
  const started: Started = {
    version: 1,
    scope: 'provider-call',
    ...structuredClone(attribution),
    id: attribution.id ?? session.d.ids.effectId(),
    stage: 'started',
    pricing: captureModelPriceQuote(session.d.provider, attribution, session.d.clock()),
  }
  if (!validateAgainst(ModelCallRecord, started).ok)
    throw new CoreError('E_ENVELOPE', 'invalid provider call attribution')
  let startedSeq: number
  try {
    ;({ firstSeq: startedSeq } = await session.locked(() =>
      session.append([session.ev(MODEL_CALL_EVENT, started, { ignorable: true })]),
    ))
  } catch (error) {
    if (session.turn) session.turn.ledgerFailed = true
    throw error
  }
  let usage: ModelCallUsage | null = null
  let ambiguousUsage = false
  let observedModel: string | null = null
  let settlement: Promise<void> | undefined
  const handle: ModelCallHandle = {
    id: started.id,
    startedSeq,
    observe(event) {
      if (settlement) return
      const model =
        event.type === 'sent'
          ? event.stamp.model.responseModel
          : event.type === 'usage' || event.type === 'error'
            ? event.response?.model
            : undefined
      // Retain the first genuine mismatch: a later requested-model frame cannot erase
      // evidence that this call's frozen requested-model quote is unsafe to apply.
      if (
        typeof model === 'string' &&
        model.length > 0 &&
        model.length <= 256 &&
        !/[\p{Cc}]/u.test(model) &&
        (observedModel === null || observedModel === started.model)
      )
        observedModel = model
      if (event.type !== 'usage' || ambiguousUsage) return
      const { tokens, credits, creditSource, billing, timing } = event
      const snapshot = {
        type: 'usage' as const,
        tokens,
        creditSource,
        ...(credits === undefined ? {} : { credits }),
        ...(billing === undefined ? {} : { billing }),
        ...(timing === undefined ? {} : { timing }),
      }
      const checked = validateAgainst<ModelCallUsage>(ModelCallUsage, snapshot)
      if (!checked.ok || (usage !== null && canonicalJson(usage) !== canonicalJson(checked.value))) {
        // No provider contract attests summing duplicate frames; contradictory evidence stays unknown.
        ambiguousUsage = true
        usage = null
      } else usage = structuredClone(checked.value)
    },
    settle(outcome) {
      ownerSignal.removeEventListener('abort', onCloseAbort)
      // append admits synchronously and the log serializes commits. An abort callback must
      // admit this row before close seals the writer; no phase state is changed here.
      settlement ??= session
        .append([
          session.ev(
            MODEL_CALL_EVENT,
            { ...started, stage: 'settled', startedSeq, outcome, usage, observedModel } satisfies Settled,
            { ignorable: true, sourceEventSeqs: [startedSeq] },
          ),
        ])
        .then(() => undefined)
        .catch((error: unknown) => {
          if (session.turn) session.turn.ledgerFailed = true
          throw new CoreError('E_STORAGE_FAULT', 'provider call settlement unavailable', { cause: error })
        })
      return settlement
    },
  }
  function onCloseAbort() {
    // Direct Core callers can close without a Host loop drain. Preserve the admitted call
    // before the writer seals; ordinary cancellation still uses the owner's bounded path.
    if (session.closingOrClosed) void handle.settle('cancelled').catch(() => undefined)
  }
  ownerSignal.addEventListener('abort', onCloseAbort, { once: true })
  if (ownerSignal.aborted) onCloseAbort()
  return handle
}
