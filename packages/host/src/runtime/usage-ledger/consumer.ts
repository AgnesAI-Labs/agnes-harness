import { existsSync } from 'node:fs'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { inline, read } from '../trace/provider-support.js'
import { openUsageLedgerJournal, UsageLedgerConflict } from './journal.js'
import type { UsageLedgerOwners } from './ports.js'

const refuse = (code: W.RuntimeError['code'], detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Usage ledger delivery refused',
    diagnosticId: 'host-usage-ledger',
    retryAdvice: { kind: 'never' },
  },
})
const same = (a: unknown, b: unknown) => jcs(a) === jcs(b)

/** Compose one selected C33 consumer with the original session-owned ledger write capability. */
export function createUsageLedgerConsumer(path: string, owners: UsageLedgerOwners) {
  owners = { ...owners }
  let journal: ReturnType<typeof openUsageLedgerJournal> | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const lifetime = new AbortController()
  // Serialize delivery through one connection; original seam/C33 owners also enforce durable idempotency.
  let tail: Promise<unknown> = Promise.resolve()
  const available = (context?: CallContext): Outcome<true> => {
    if (closed || context?.signal.aborted) return refuse('cancelled', 'usage_ledger_disposed')
    if (context && Date.parse(context.deadline) <= Date.now())
      return refuse('timeout', 'usage_ledger_deadline')
    return { ok: true, value: true }
  }
  async function consume(attempt: W.AttemptRef): Promise<Outcome<W.UsageRecordResult>> {
    const live = available()
    if (!live.ok) return live
    if (!owners.installer) return refuse('denied', 'usage_installer_owner_absent')
    if (!owners.state) return refuse('denied', 'usage_state_owner_absent')
    if (!owners.session) return refuse('denied', 'usage_session_owner_absent')
    if (!validateRuntime('AttemptRef', attempt).ok) return refuse('invalid_input', 'usage_attempt_invalid')
    const connected = await owners.installer.connect(attempt, lifetime.signal)
    if (!connected.ok) return connected
    const connection = connected.value
    const context = connection.context
    const { signal: _signal, ...wireContext } = context
    try {
      if (
        !validateRuntime('BindingRef', connection.binding).ok ||
        connection.binding.contract !== 'agh.usage' ||
        connection.binding.bindingId !== context.bindingId ||
        !validateRuntime('CallContextWire', wireContext).ok ||
        !validateRuntime('Id', connection.authorityId).ok
      )
        return refuse('denied', 'usage_installation_invalid')
      if (!connection.provider.control || !connection.provider.query)
        return refuse('denied', 'usage_provider_owner_absent')
      const current = available(context)
      if (!current.ok) return current
      const verified = await owners.state.verify(attempt, context)
      if (!verified.ok) return verified
      const source = structuredClone(verified.value)
      if (
        !validateRuntime('UsageRecordRequest', source.request).ok ||
        !same(source.request.attemptRef, attempt)
      )
        return refuse('denied', 'usage_state_source_mismatch')
      if (source.request.measurement.kind === 'corrected')
        return refuse('incompatible', 'usage_correction_owner_required')
      const claim = await owners.session.claim(source.request, context)
      if (!claim.ok) return claim
      if (claim.value.mode !== 'runtime-exclusive') return refuse('denied', 'usage_session_not_exclusive')
      if (!claim.value.ledger?.record) return refuse('denied', 'usage_ledger_owner_absent')
      const row = structuredClone(claim.value.row)
      const measurement = source.request.measurement
      if (
        !row.effectId ||
        !row.sessionKey ||
        !row.lane ||
        row.purpose !== 'inference' ||
        !Number.isSafeInteger(row.turn) ||
        row.turn < 0 ||
        !Number.isSafeInteger(row.step) ||
        row.step < 0 ||
        !same(row.billing ?? null, measurement.billing ?? null) ||
        !same(row.credits ?? null, measurement.credits ?? null) ||
        (measurement.creditSource !== undefined && row.creditSource !== measurement.creditSource) ||
        (measurement.actualModel !== null && row.model !== measurement.actualModel) ||
        Object.values(row.tokens).some((n) => !Number.isSafeInteger(n) || n < 0)
      )
        return refuse('denied', 'usage_session_source_mismatch')
      if (source.reservationRef !== null && !owners.budget)
        return refuse('denied', 'usage_budget_owner_absent')
      const before = available(context)
      if (!before.ok) return before
      journal ??= openUsageLedgerJournal(path)
      if (journal.pending().some((pending) => same(pending.run, attempt.run) && !same(pending, attempt)))
        return refuse('internal', 'usage_ledger_pending')
      const fingerprint = canonicalJsonDigest({
        source,
        row,
        binding: connection.binding,
        authorityId: connection.authorityId,
      })
      journal.prepare(attempt, row.effectId, fingerprint)
      const refs = RuntimeMethodSchemaRefs['agh.usage']
      const recorded = await connection.provider.control(
        { target: connection.binding, method: 'record', input: inline(refs.record.input, source.request) },
        context,
      )
      if (!recorded.ok) return recorded
      const result = read<W.UsageRecordResult>(recorded.value, refs.record.output, 'UsageRecordResult')
      if (!result.ok) return result
      if (
        result.value.factRefs.length !== 1 ||
        result.value.factRefs[0]?.authorityId !== connection.authorityId
      )
        return refuse('denied', 'usage_fact_source_mismatch')
      const queried = await connection.provider.query(
        {
          target: connection.binding,
          method: 'query',
          input: inline(refs.query.input, { scopeRef: context.scope, cursor: null, limit: 10000 }),
        },
        context,
      )
      if (!queried.ok) return queried
      if (queried.value.kind !== 'value') return refuse('denied', 'usage_query_unavailable')
      const page = read<W.UsageQueryResult>(queried.value.output, refs.query.output, 'UsageQueryResult')
      if (!page.ok) return page
      const reference = result.value.factRefs[0]
      const matches = page.value.items.filter((fact) => fact.usageId === reference.usageId)
      const fact = matches[0]
      if (
        matches.length !== 1 ||
        !fact ||
        canonicalJsonDigest(fact) !== reference.digest ||
        fact.actionId !== attempt.actionId ||
        fact.attemptId !== attempt.attemptId ||
        page.value.snapshot !== queried.value.snapshot
      )
        return refuse('denied', 'usage_fact_source_mismatch')
      const dimensions = await connection.resolve(fact.dimensions)
      if (!dimensions.ok) return dimensions
      const parsed = validateRuntime('UsageMeasurement', dimensions.value)
      const proof = fact.dimensions.kind === 'inline' ? fact.dimensions : fact.dimensions.blob
      if (
        !parsed.ok ||
        !same(parsed.value, measurement) ||
        proof.digest !== canonicalJsonDigest(parsed.value) ||
        proof.bytes !== Buffer.byteLength(jcs(parsed.value))
      )
        return refuse('denied', 'usage_measurement_source_mismatch')
      const expected =
        measurement.kind === 'reported'
          ? 'measured'
          : measurement.kind === 'estimated'
            ? 'estimated'
            : 'unknown'
      if (fact.certainty !== expected) return refuse('denied', 'usage_certainty_mismatch')
      const final = available(context)
      if (!final.ok) return final
      if (source.reservationRef !== null) {
        const settled = await owners.budget?.settle(
          { reservationRef: source.reservationRef, usageRefs: result.value.factRefs },
          context,
        )
        if (!settled) return refuse('denied', 'usage_budget_owner_absent')
        if (!settled.ok) return settled
        const parsedBudget = validateRuntime('BudgetSettleResult', settled.value)
        if (
          !parsedBudget.ok ||
          !same(parsedBudget.value.reservation.ref, source.reservationRef) ||
          parsedBudget.value.reservation.actionId !== attempt.actionId ||
          parsedBudget.value.reservation.attemptId !== attempt.attemptId ||
          !same(parsedBudget.value.reservation.usageRefs, result.value.factRefs) ||
          parsedBudget.value.reservation.held !== null ||
          parsedBudget.value.reservation.priceVersion !== null ||
          parsedBudget.value.reservation.settledAmount !== null ||
          parsedBudget.value.reservation.status !== (expected === 'unknown' ? 'unknown' : 'settled')
        )
          return refuse('denied', 'usage_budget_source_mismatch')
      }
      if (
        expected === 'unknown' ||
        measurement.credits === undefined ||
        measurement.creditSource === undefined
      )
        return refuse('unknown_effect', 'usage_ledger_unknown')
      const ready = available(context)
      if (!ready.ok) return ready
      const rechecked = await owners.state.verify(attempt, context)
      if (!rechecked.ok) return rechecked
      if (!same(rechecked.value, source)) return refuse('denied', 'usage_state_source_mismatch')
      const committing = available(context)
      if (!committing.ok) return committing
      // No new pricing. Preserve gateway zero, original estimates and complete evidence verbatim.
      await claim.value.ledger.record(row)
      journal.complete(attempt)
      return result
    } catch (error) {
      return refuse(
        error instanceof UsageLedgerConflict ? 'conflict' : 'internal',
        error instanceof UsageLedgerConflict ? 'usage_ledger_idempotency_conflict' : 'usage_ledger_failed',
      )
    } finally {
      connection.close()
    }
  }
  return {
    consume(attempt: W.AttemptRef): Promise<Outcome<W.UsageRecordResult>> {
      const captured = structuredClone(attempt)
      const pending = tail
        .then(() => consume(captured))
        .catch(() => refuse('internal', 'usage_owner_unavailable'))
      tail = pending
      return pending
    },
    pending(): W.AttemptRef[] {
      if (closed) throw new Error('Usage ledger consumer is disposed')
      if (!closed && !journal && existsSync(path)) journal = openUsageLedgerJournal(path)
      return journal?.pending() ?? []
    },
    close(): Promise<void> {
      closing ??= (async () => {
        closed = true
        lifetime.abort()
        await tail
        journal?.close()
      })()
      return closing
    },
  }
}
