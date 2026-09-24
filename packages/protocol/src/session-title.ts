import { type Static, Type } from '@sinclair/typebox'
import type { EventEnvelope } from '../gen/ts/session-v1.js'
import { validateAgainst } from './validate.js'

export const SESSION_TITLE_EVENT = 'x/host/session-title'

const identity = {
  turn: Type.Integer({ minimum: 1 }),
  startSeq: Type.Integer({ minimum: 1 }),
  route: Type.String({ minLength: 1, maxLength: 128 }),
  model: Type.String({ minLength: 1, maxLength: 256 }),
  prompt: Type.String({ maxLength: 6000 }),
  budgetCap: Type.Union([Type.Null(), Type.Number({ minimum: 0 })]),
  treeBudgetCap: Type.Union([Type.Null(), Type.Number({ exclusiveMinimum: 0 })]),
}

export const SessionTitleRecord = Type.Union([
  Type.Object({ ...identity, status: Type.Literal('pending') }, { additionalProperties: false }),
  Type.Object({ ...identity, status: Type.Literal('requested') }, { additionalProperties: false }),
  Type.Object(
    { ...identity, status: Type.Literal('generated'), title: Type.String({ minLength: 1, maxLength: 256 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...identity, status: Type.Literal('failed'), reason: Type.String({ maxLength: 128 }) },
    { additionalProperties: false },
  ),
])
export type SessionTitleRecord = Static<typeof SessionTitleRecord>

/** A model/extension cannot forge Host metadata by emitting a similarly named event. */
export function readSessionTitle(event: EventEnvelope): SessionTitleRecord | undefined {
  if (
    event.type !== SESSION_TITLE_EVENT ||
    event.origin !== 'system' ||
    event.trust !== 'trusted' ||
    event.ignorable !== true ||
    (event.lane ?? 'main') !== 'main' ||
    !validateAgainst(SessionTitleRecord, event.data).ok
  )
    return undefined
  return event.data as SessionTitleRecord
}
