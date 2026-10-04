import { CoreError, type EventInput, type SessionImpl, scanAll, sha256Hex } from '@agnes/core'
import type { LedgerEntry, RuntimeRecord } from '@agnes/jev-runtime'
import { type InferenceEvent, validateAgainst } from '@agnes/protocol'
import { InferenceEvent as InferenceEventSchema } from '@agnes/protocol/gen/model'
import { CostLedger } from '@agnes/protocol/gen/session-v1'

export const JEV_COST_OUTBOX = 'x/agnes/jev-cost-outbox'
export const JEV_COST_ACK = 'x/agnes/jev-cost-ack'

/** Preserve actual provider accounting. Missing usage stays unknown in the runtime record. */
export function projectJevCost(
  session: SessionImpl,
  entries: readonly LedgerEntry<number>[],
  record: RuntimeRecord,
): EventInput | undefined {
  if (record.kind !== 'model.settled' || record.settlement.usage === undefined) return undefined
  const requested = entries.find((entry) => entry.record.id === record.requested)?.record
  if (
    requested?.kind !== 'model.requested' ||
    requested.call.backend !== 'agnes-provider' ||
    requested.call.requestedModel === null
  )
    return undefined
  const checked = validateAgainst<InferenceEvent>(InferenceEventSchema, record.settlement.usage)
  if (!checked.ok || checked.value.type !== 'usage') return undefined
  const usage = checked.value
  const spend = {
    purpose: 'inference' as const,
    effectId: sha256Hex(JSON.stringify(['jev-model', session.key, session.lane, requested.id])),
    model: requested.call.requestedModel,
    tokens: usage.tokens,
    creditSource: usage.creditSource,
    ...(usage.credits === undefined ? {} : { credits: usage.credits }),
    ...(usage.billing === undefined ? {} : { billing: usage.billing }),
    ...(usage.timing === undefined ? {} : { timing: usage.timing }),
    ...(usage.response === undefined ? {} : { response: usage.response }),
    ...(record.settlement.error ? { interrupted: true } : {}),
  }
  return session.ev('cost/ledger', spend)
}

/** Auxiliary delivery metadata is in the same transaction as the authoritative settlement/cost. */
export function jevCostOutbox(session: SessionImpl, cost: EventInput, costSeq: number): EventInput {
  const spend = validateAgainst<CostLedger>(CostLedger, cost.data)
  if (!spend.ok) throw new CoreError('E_STORAGE_FAULT', 'Invalid Jev cost projection')
  return session.ev(
    JEV_COST_OUTBOX,
    {
      effectId: spend.value.effectId,
      costSeq,
      turn: session.state.openTurn.get(session.lane)?.turn ?? session.lastTurnNumber(),
      step: session.state.openStep.get(session.lane)?.step ?? 0,
    },
    { ignorable: true, sourceEventSeqs: [costSeq] },
  )
}

/**
 * Deliver only durable usage. The shared sink deduplicates effectId; acknowledgement loss may
 * redeliver that same identity, never a new charge. Failure prevents the next model admission.
 */
export async function drainJevCostOutbox(session: SessionImpl): Promise<void> {
  await session.locked(async () => {
    const rows = await scanAll((query) => session.scan(query), {
      type: ['cost/ledger', JEV_COST_OUTBOX, JEV_COST_ACK],
      // A history seed remains evidence; only its original writer delivers those cost receipts.
      fromSeq: (session.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: session.lastSeq,
    })
    const costs = new Map(rows.filter((row) => row.type === 'cost/ledger').map((row) => [row.seq, row]))
    const acknowledged = new Set(
      rows
        .filter((row) => row.type === JEV_COST_ACK)
        .map((row) => {
          const data = row.data as { effectId: string; costSeq: number }
          return JSON.stringify([data.effectId, data.costSeq])
        }),
    )
    for (const row of rows) {
      if (row.type !== JEV_COST_OUTBOX) continue
      const data = row.data as { effectId: string; costSeq: number; turn: number; step: number }
      if (acknowledged.has(JSON.stringify([data.effectId, data.costSeq]))) continue
      const cost = costs.get(data.costSeq)
      const checked = validateAgainst<CostLedger>(CostLedger, cost?.data)
      if (
        !cost ||
        typeof cost.lane !== 'string' ||
        !checked.ok ||
        checked.value.effectId !== data.effectId ||
        data.costSeq >= row.seq ||
        !Number.isSafeInteger(data.turn) ||
        data.turn < 0 ||
        !Number.isSafeInteger(data.step) ||
        data.step < 0
      )
        throw new CoreError('E_STORAGE_FAULT', 'Invalid Jev cost outbox binding')
      // The shared sink accepts flat transport timing; full timing remains in cost/ledger.
      const { timing, ...spend } = checked.value
      const flatTiming =
        timing &&
        Object.fromEntries(
          Object.entries(timing).filter(
            (entry): entry is [string, string | number] =>
              typeof entry[1] === 'number' || typeof entry[1] === 'string',
          ),
        )
      if (
        !(await session.d.runtime.ledgerRecord({
          ...spend,
          ...(flatTiming ? { timing: flatTiming } : {}),
          sessionKey: session.key,
          lane: cost.lane,
          turn: data.turn,
          step: data.step,
        }))
      )
        throw new CoreError(
          'E_BUDGET',
          'Usage ledger unavailable; pending Jev cost delivery blocks model spending',
        )
      await session.d.log.append([
        session.ev(
          JEV_COST_ACK,
          {
            effectId: data.effectId,
            costSeq: data.costSeq,
          },
          { ignorable: true, sourceEventSeqs: [data.costSeq] },
        ),
      ])
      acknowledged.add(JSON.stringify([data.effectId, data.costSeq]))
    }
  })
}
