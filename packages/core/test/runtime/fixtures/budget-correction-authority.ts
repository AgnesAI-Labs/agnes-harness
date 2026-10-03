import { jcs } from '@agnes/protocol'
import {
  type BudgetReservation,
  type BudgetSettleRequest,
  canonicalJsonDigest,
  type DomainObjectRef,
  type UsageFact,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type BudgetSettlementEvent,
  type BudgetSettlementSource,
  verifiedSettlementEvent,
} from '../../../src/runtime/budget/corrections.js'
import {
  BudgetAuthorityFault,
  type BudgetStore,
  createBudgetReservations,
  type VerifiedSettlement,
} from '../../../src/runtime/budget/reservations.js'
import { budgetFixture } from './budget-authority.js'

/** Restricted source over the original SQLite transaction; production installation is separate. */
export function budgetCorrectionFixture(path?: string) {
  const base = budgetFixture(path)
  base.db.exec(
    'CREATE TABLE IF NOT EXISTS settlement_events(seq INTEGER PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL)',
  )
  const fail = (message: string): never => {
    throw new BudgetAuthorityFault('integrity', message)
  }
  const usage = (input: BudgetSettleRequest, value: VerifiedSettlement, reservation: BudgetReservation) => {
    const origins: string[] = []
    for (const ref of input.usageRefs) {
      const fact = base.get<UsageFact>('usage-fact', ref.usageId)
      if (
        !fact ||
        !validateRuntime('UsageFact', fact).ok ||
        ref.authorityId !== 'fixture-usage' ||
        canonicalJsonDigest(fact) !== ref.digest ||
        fact.actionId !== reservation.actionId ||
        fact.attemptId !== reservation.attemptId
      )
        fail('Original immutable Usage source differs')
      origins.push(fact!.originKey)
    }
    if (jcs(origins) !== jcs(value.origins)) fail('Usage origins are not the actual original owners')
    const original = base.get<{ input: BudgetSettleRequest; value: VerifiedSettlement }>(
      'verified-charge',
      value.sourceDigest,
    )
    if (!original || jcs(original.input) !== jcs(input) || jcs(original.value) !== jcs(value))
      fail('Original Usage replacement capability is absent')
  }
  const latest = (reference: DomainObjectRef): BudgetSettlementSource | undefined => {
    const rows = base.db.prepare('SELECT seq,body,digest FROM settlement_events ORDER BY seq').all() as {
      seq: number
      body: string
      digest: string
    }[]
    const heads = new Map<string, BudgetSettlementSource>()
    let seq = 0
    for (const row of rows) {
      if (row.seq !== ++seq) fail('Settlement chain sequence gap')
      const event = JSON.parse(row.body) as BudgetSettlementEvent,
        source = { eventDigest: row.digest, event }
      verifiedSettlementEvent(source)
      if (
        jcs(event) !== row.body ||
        (heads.get(event.input.reservationRef.id)?.eventDigest ?? null) !== event.previous
      )
        fail('Settlement chain original bytes or previous event differ')
      if (jcs(event.result.reservation.ref) !== jcs(event.input.reservationRef))
        fail('Event changes reservation owner')
      usage(event.input, event.settlement, event.result.reservation)
      heads.set(event.input.reservationRef.id, source)
    }
    const found = heads.get(reference.id)
    if (found && jcs(found.event.input.reservationRef) !== jcs(reference))
      fail('Historical reservation fullref differs')
    return found
  }
  const store: BudgetStore = {
    transaction: (ctx, body) =>
      base.store.transaction(ctx, (tx) =>
        body({
          ...tx,
          settlement: (input, reservation, context) => {
            const actual = tx.settlement(input, reservation, context)
            usage(input, actual, reservation)
            return actual
          },
          latestSettlement: latest,
          appendSettlementSource: (event, expected) => {
            if (
              (latest(event.input.reservationRef)?.eventDigest ?? null) !== expected ||
              event.previous !== expected
            )
              throw new BudgetAuthorityFault('conflict', 'Original settlement append CAS differs')
            usage(event.input, event.settlement, event.result.reservation)
            const json = validateRuntime('JsonValue', event)
            if (!json.ok)
              throw new BudgetAuthorityFault('integrity', 'Settlement event is not canonical JSON')
            const body = jcs(event),
              digest = canonicalJsonDigest(json.value)
            base.db.prepare('INSERT INTO settlement_events(body,digest) VALUES(?,?)').run(body, digest)
            return digest
          },
        }),
      ),
  }
  return {
    ...base,
    store,
    operations: createBudgetReservations(store),
    latest,
    observe: (
      reservation: BudgetReservation,
      units: string,
      replaces: string | null = null,
      certainty: 'known' | 'unknown' = 'known',
      origins: readonly string[] = ['actual-request-one'],
    ) => {
      const value: VerifiedSettlement = {
        sourceDigest: canonicalJsonDigest({
          reservation: reservation.ref,
          units,
          replaces,
          certainty,
          origins: [...origins],
        }),
        amount:
          reservation.priceVersion === null
            ? null
            : { currency: 'EUR', scale: 6, units: (BigInt(units) * 10n).toString() },
        priceVersion: reservation.priceVersion,
        units: [{ unit: 'token', value: units }],
        origins: [...origins],
        certainty,
        replacesEventDigest: replaces,
      }
      base.measurement(value, reservation.actionId)
      const input = { reservationRef: reservation.ref, usageRefs: base.usageRefs() }
      const prior = base.get('verified-charge', value.sourceDigest)
      if (prior !== undefined && jcs(prior) !== jcs({ input, value }))
        fail('Immutable verified Usage source differs')
      if (prior === undefined) base.put('verified-charge', value.sourceDigest, { input, value })
      return input
    },
    events: () =>
      base.db.prepare('SELECT seq,body,digest FROM settlement_events ORDER BY seq').all() as {
        seq: number
        body: string
        digest: string
      }[],
  }
}
