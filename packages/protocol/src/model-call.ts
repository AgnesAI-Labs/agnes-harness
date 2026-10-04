import { type Static, Type } from '@sinclair/typebox'
import { Billing, ModelPriceQuote, Timing, TokenCounts } from '../gen/ts/model.js'
import type { EventEnvelope } from '../gen/ts/session-v1.js'
import { validModelPriceQuote } from './model-pricing.js'
import { validateAgainst, validateEvent } from './validate.js'

/** One invocation of Provider.infer, not the adapter's hidden HTTP/auth retry attempts. */
export const MODEL_CALL_EVENT = 'x/core/model-call'

const attribution = {
  version: Type.Literal(1),
  id: Type.String({ minLength: 1, maxLength: 512 }),
  scope: Type.Literal('provider-call'),
  purpose: Type.Union(
    (['inference', 'compaction', 'title', 'media'] as const).map((value) => Type.Literal(value)),
  ),
  parentEffectId: Type.String({ minLength: 1, maxLength: 512 }),
  route: Type.String({ minLength: 1, maxLength: 128 }),
  model: Type.String({ minLength: 1, maxLength: 256 }),
  sourceTurn: Type.Integer({ minimum: 1 }),
  sourceStep: Type.Integer({ minimum: 0 }),
  pricing: Type.Optional(Type.Union([ModelPriceQuote, Type.Null()])),
}

/** Provider usage only; response headers, request bodies and estimated fallback tokens are excluded. */
export const ModelCallUsage = Type.Object(
  {
    type: Type.Literal('usage'),
    tokens: TokenCounts,
    credits: Type.Optional(Type.Number({ minimum: 0 })),
    creditSource: Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]),
    billing: Type.Optional(Billing),
    timing: Type.Optional(Timing),
  },
  { additionalProperties: false },
)
export type ModelCallUsage = Static<typeof ModelCallUsage>

export const ModelCallRecord = Type.Union([
  Type.Object({ ...attribution, stage: Type.Literal('started') }, { additionalProperties: false }),
  Type.Object(
    {
      ...attribution,
      stage: Type.Literal('settled'),
      startedSeq: Type.Integer({ minimum: 1 }),
      outcome: Type.Union(
        (['completed', 'failed', 'cancelled', 'unknown'] as const).map((value) => Type.Literal(value)),
      ),
      usage: Type.Union([ModelCallUsage, Type.Null()]),
      observedModel: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    },
    { additionalProperties: false },
  ),
])
export type ModelCallRecord = Static<typeof ModelCallRecord>

/** Trusted accounting metadata is read independently of the ignorable extension event envelope. */
export function readModelCall(event: EventEnvelope): ModelCallRecord | undefined {
  if (
    event.type !== MODEL_CALL_EVENT ||
    event.origin !== 'system' ||
    event.trust !== 'trusted' ||
    event.ignorable !== true ||
    !Number.isSafeInteger(event.seq) ||
    event.seq < 1 ||
    !validateEvent(event).ok ||
    !validateAgainst(ModelCallRecord, event.data).ok
  )
    return undefined
  const record = event.data as ModelCallRecord
  if (
    [record.id, record.parentEffectId, record.route, record.model].some((value) => /[\p{Cc}]/u.test(value)) ||
    !Number.isSafeInteger(record.sourceTurn) ||
    !Number.isSafeInteger(record.sourceStep)
  )
    return undefined
  if (
    record.pricing !== undefined &&
    record.pricing !== null &&
    (!validModelPriceQuote(record.pricing) ||
      record.pricing.admittedAt > Date.parse(event.ts) ||
      record.pricing.route !== record.route ||
      record.pricing.model !== record.model)
  )
    return undefined
  if (
    record.stage === 'settled' &&
    (!Number.isSafeInteger(record.startedSeq) ||
      record.startedSeq >= event.seq ||
      event.sourceEventSeqs?.length !== 1 ||
      event.sourceEventSeqs[0] !== record.startedSeq ||
      (record.observedModel !== null && /[\p{Cc}]/u.test(record.observedModel)))
  )
    return undefined
  return record
}
