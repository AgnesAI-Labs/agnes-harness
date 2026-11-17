import { createHash } from 'node:crypto'
import { type CostLedger, chargeToMicrocredits, type Event, hasChildControl } from '@agnes/core'
import { readSessionTitle, SESSION_TITLE_EVENT, validateAgainst, validateEvent } from '@agnes/protocol'
import { type Static, Type } from '@sinclair/typebox'
import type { HostSession } from '../lifecycle/host.js'

export const TITLE_COST_EVENT = 'x/host/title-cost'
const sequence = Type.Integer({ minimum: 1 })
const reservation = Type.Object(
  {
    permitId: Type.String({ minLength: 1, maxLength: 256 }),
    rootTaskId: Type.String({ minLength: 1, maxLength: 1024 }),
    requestHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    writerGeneration: sequence,
  },
  { additionalProperties: false },
)
const proofSchema = Type.Object(
  {
    version: Type.Literal(1),
    effectId: Type.String({ minLength: 1, maxLength: 128 }),
    sourceTurn: sequence,
    startSeq: sequence,
    model: Type.String({ minLength: 1, maxLength: 256 }),
    refresh: Type.Optional(
      Type.Object({ endSeq: sequence, expectedRevision: sequence }, { additionalProperties: false }),
    ),
    reservation: Type.Optional(reservation),
  },
  { additionalProperties: false },
)
export type TitleCostProof = Static<typeof proofSchema>

/** Persisted identities are derived from the source, never the current foreground operation. */
export function titleEffectId(session: HostSession, startSeq: number, refresh?: TitleCostProof['refresh']) {
  const parts = [
    session.key,
    session.lane,
    startSeq,
    ...(refresh ? [refresh.endSeq, refresh.expectedRevision] : []),
  ]
  return `${refresh ? 'title-refresh' : 'title'}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}

function trusted(row: Event, session: HostSession): boolean {
  return (
    row.origin === 'system' &&
    row.trust === 'trusted' &&
    (row.lane ?? 'main') === session.lane &&
    validateEvent(row).ok
  )
}

/** No provider or reservation is created here: only the persisted original cost can be reconciled. */
export async function settleTitleReservation(
  session: HostSession,
  proof: TitleCostProof,
  spend: CostLedger,
  costSeq: number,
  alive: () => boolean = () => true,
) {
  const permit = proof.reservation
  if (!permit || !alive()) return
  const storage = session.d.log.storage
  if (!hasChildControl(storage)) throw new Error('title reservation storage unavailable')
  if (storage.peekReservation) {
    const current = await storage.peekReservation(permit.permitId)
    if (
      !current ||
      current.rootTaskId !== permit.rootTaskId ||
      current.effectId !== proof.effectId ||
      current.requestHash !== permit.requestHash ||
      current.writerGeneration !== permit.writerGeneration
    )
      throw new Error('title reservation identity mismatch')
  }
  if (!alive()) return
  await storage.settleOrigin({
    permitId: permit.permitId,
    writerGeneration: permit.writerGeneration,
    originSessionKey: session.key,
    originCostSeq: costSeq,
    actualMicro: spend.credits === undefined ? null : chargeToMicrocredits(spend.credits),
    complete: spend.credits !== undefined,
    creditSource: spend.credits === undefined ? 'unknown' : spend.creditSource,
  })
}

/** Recover every title generation, including paid failures and superseded original titles. */
export async function recoverTitleCosts(
  session: HostSession,
  fromSeq: number,
  alive: () => boolean,
  onError: (error: unknown) => void,
) {
  const toSeq = session.lastSeq
  const proofs = new Map<string, TitleCostProof>()
  const legacy = new Map<string, { sourceTurn: number; startSeq: number; model: string }>()
  const starts = new Map<number, number>()
  const accepted = new Set<number>()
  let cursor = fromSeq
  while (cursor <= toSeq && alive()) {
    const rows = await session.scan({
      type: [TITLE_COST_EVENT, SESSION_TITLE_EVENT, 'turn/start'],
      fromSeq: cursor,
      toSeq,
      limit: 100,
    })
    if (!alive()) return
    if (!rows.length) break
    for (const row of rows) {
      if (!trusted(row, session)) continue
      if (row.type === 'turn/start') starts.set(row.seq, (row.data as { turn: number }).turn)
      const title = readSessionTitle(row)
      if (title?.status === 'generated') accepted.add(row.seq)
      if (
        title &&
        (title.status === 'generated' || title.status === 'failed') &&
        !legacy.has(titleEffectId(session, title.startSeq))
      )
        legacy.set(titleEffectId(session, title.startSeq), {
          sourceTurn: title.turn,
          startSeq: title.startSeq,
          model: title.model,
        })
      if (
        row.type === TITLE_COST_EVENT &&
        row.ignorable === true &&
        validateAgainst(proofSchema, row.data).ok
      ) {
        const proof = row.data as TitleCostProof
        if (
          proof.effectId === titleEffectId(session, proof.startSeq, proof.refresh) &&
          (!proof.reservation ||
            proof.reservation.rootTaskId === `${session.key}:${session.lane}:${proof.startSeq}`)
        )
          proofs.set(proof.effectId, proof)
      }
    }
    const last = rows.at(-1)
    if (!last || last.seq < cursor) break
    cursor = last.seq + 1
  }
  cursor = fromSeq
  const seen = new Set<string>()
  while (cursor <= toSeq && alive()) {
    const rows = await session.scan({ type: 'cost/ledger', fromSeq: cursor, toSeq, limit: 100 })
    if (!alive()) return
    if (!rows.length) break
    for (const row of rows) {
      if (!alive()) return
      if (!trusted(row, session)) continue
      const spend = row.data as CostLedger
      const proof = proofs.get(spend.effectId)
      const source = proof ?? legacy.get(spend.effectId)
      if (
        spend.purpose !== 'title' ||
        !source ||
        spend.sourceTurn !== source.sourceTurn ||
        spend.model !== source.model ||
        source.startSeq < fromSeq ||
        source.startSeq >= row.seq ||
        starts.get(source.startSeq) !== source.sourceTurn ||
        seen.has(spend.effectId)
      )
        continue
      if (proof?.refresh) {
        const completed = session.state.completedTurns.get(proof.refresh.endSeq)
        if (
          completed?.lane !== session.lane ||
          completed.turn !== proof.sourceTurn ||
          completed.startSeq !== proof.startSeq ||
          proof.refresh.endSeq >= row.seq ||
          proof.refresh.expectedRevision >= row.seq ||
          !accepted.has(proof.refresh.expectedRevision)
        )
          continue
      }
      seen.add(spend.effectId)
      try {
        if (proof) await settleTitleReservation(session, proof, spend, row.seq, alive)
      } catch (error) {
        onError(error)
      }
      if (!alive()) return
      try {
        if (
          !(await session.d.runtime.billingRecord({
            ...spend,
            sessionKey: session.key,
            lane: session.lane,
            turn: source.sourceTurn,
            step: 0,
          }))
        )
          onError(new Error('title usage ledger unavailable'))
      } catch (error) {
        onError(error)
      }
    }
    const last = rows.at(-1)
    if (!last || last.seq < cursor) break
    cursor = last.seq + 1
  }
}
