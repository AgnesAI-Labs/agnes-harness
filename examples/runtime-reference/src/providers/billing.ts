import { createHash } from 'node:crypto'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as R from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import {
  cabinet,
  deliver,
  type RemotePort,
  referenceFactory,
  rejection,
  serial,
  unserial,
  until,
} from './billing-trace-runtime.js'

export interface ReferenceBillingDeployment {
  readonly path: string
  readonly authorityId: string
  readonly packageDigest: string
  readonly configSchema: R.SchemaRef
  readonly priceVersions: readonly string[]
  readonly accounting?: {
    readUsage(ref: R.UsageFactRef, call: CallContext): Promise<Outcome<R.UsageFact>>
    reservation(request: R.BillingPostRequest, call: CallContext): Promise<Outcome<R.DomainObjectRef>>
    settle(request: R.BudgetSettleRequest, call: CallContext): Promise<Outcome<R.BudgetSettleResult>>
  }
  readonly outbound: RemotePort
  authorize(
    call: CallContext,
    method: string,
    input: R.BillingPostRequest | R.BillingRefundRequest | R.BillingReconcileRequest,
  ): Promise<boolean>
  readResponse(reference: R.BytesRef, call: CallContext): Promise<Uint8Array>
  verifyEvidence(reference: R.DataRef, call: CallContext): Promise<Outcome<R.BillingEntry>>
}
type Book = {
  rows: {
    owner: string
    key: string
    signature: string
    entry: R.BillingEntry
    confirmation: string | null
    origins?: string[]
  }[]
}
export function createReferenceBillingFactory(d: ReferenceBillingDeployment) {
  d = {
    ...d,
    priceVersions: d.priceVersions.slice(),
    ...(d.accounting ? { accounting: { ...d.accounting } } : {}),
    outbound: { ...d.outbound, target: structuredClone(d.outbound.target) },
  }
  const schemas = RuntimeMethodSchemaRefs['agh.billing']
  return referenceFactory('agh.billing', d.packageDigest, d.configSchema, () => {
    const book = cabinet<Book>(d.path, { rows: [] })
    const locate = (ref: R.DomainObjectRef, owner: string) => {
      const row = book.view().rows.find((r) => r.entry.entryId === ref.id && r.owner === owner)
      if (
        !row ||
        ref.authorityId !== d.authorityId ||
        ref.revision !== 1 ||
        ref.typeId !== 'agh.billing/entry@1'
      )
        return null
      return row.entry
    }
    function confirm(
      id: string,
      owner: string,
      remote: R.BillingEntry,
      receipt: R.DataRef,
    ): Outcome<R.BillingEntry> {
      return book.change((doc) => {
        const row = doc.rows.find((r) => r.entry.entryId === id && r.owner === owner)
        if (!row) return rejection('denied', 'billing_balance')
        const immutable = ({ status: _s, paymentReceipt: _p, ...rest }: R.BillingEntry) => rest
        const stamp = canonicalJsonDigest(remote)
        if (
          !['posted', 'rejected'].includes(remote.status) ||
          jcs(immutable(remote)) !== jcs(immutable(row.entry)) ||
          (row.confirmation !== null && row.confirmation !== stamp)
        )
          return rejection('conflict', 'idempotency_conflict')
        if (row.confirmation === null) {
          row.entry.status = remote.status
          row.entry.paymentReceipt = receipt
          row.confirmation = stamp
        }
        return { ok: true, value: row.entry }
      })
    }
    return {
      async act(frame, ctx, probe): Promise<Outcome<R.DataRef>> {
        const method = frame.method as keyof typeof schemas,
          refs = schemas[method]
        const parsed = unserial<R.BillingPostRequest | R.BillingRefundRequest | R.BillingReconcileRequest>(
          frame.input,
          refs.input,
          method === 'post'
            ? 'BillingPostRequest'
            : method === 'refund'
              ? 'BillingRefundRequest'
              : 'BillingReconcileRequest',
        )
        if (!(await until(d.authorize(ctx.call, method, parsed), ctx.call)) || ctx.call.signal.aborted)
          return rejection('denied', 'permission_absent')
        const owner = canonicalJsonDigest({ scope: ctx.call.scope, principal: ctx.call.principalRef })
        if (method === 'reconcile') {
          const command = parsed as R.BillingReconcileRequest,
            entry = locate(command.chargeRef, owner)
          if (!entry) return rejection('denied', 'billing_balance')
          const verified = await until(d.verifyEvidence(command.evidenceRef, ctx.call), ctx.call)
          if (!verified.ok) return verified
          if (ctx.call.signal.aborted || !(await until(d.authorize(ctx.call, method, parsed), ctx.call)))
            return rejection('denied', 'permission_absent')
          const output = confirm(entry.entryId, owner, verified.value, command.evidenceRef)
          return output.ok ? { ok: true, value: serial(refs.output, output.value) } : output
        }
        const origins: string[] = []
        let candidate: R.BillingEntry
        if (method === 'post') {
          const command = parsed as R.BillingPostRequest
          const previous = book.view().rows.find(
            (r) =>
              r.key ===
              canonicalJsonDigest({
                owner,
                authorityId: d.authorityId,
                account: { authorityId: command.accountRef.authorityId, id: command.accountRef.id },
                key: command.chargeKey,
              }),
          )
          if (previous) {
            if (previous.signature !== canonicalJsonDigest(command))
              return rejection('conflict', 'idempotency_conflict')
            return ['posted', 'rejected'].includes(previous.entry.status)
              ? { ok: true, value: serial(refs.output, previous.entry) }
              : rejection('unknown_effect', 'effect_unknown')
          }
          const quote = unserial<R.PriceQuote>(
            command.quoteRef,
            RuntimeMethodSchemaRefs['agh.pricing'].quote.output,
            'PriceQuote',
          )
          if (!d.priceVersions.includes(quote.priceVersion)) return rejection('incompatible', 'price_version')
          if (
            !/^(0|[1-9][0-9]*)$/.test(quote.amount.units) ||
            quote.amount.scale !== 6 ||
            !quote.amount.currency
          )
            return rejection('invalid_input', 'billing_money')
          let subtotal = 0n
          for (const line of quote.lineItems) {
            for (const item of [line.unitPrice, line.amount])
              if (
                !/^(0|[1-9][0-9]*)$/.test(item.units) ||
                item.scale !== quote.amount.scale ||
                item.currency !== quote.amount.currency
              )
                return rejection('invalid_input', 'billing_money')
            subtotal += BigInt(line.amount.units)
          }
          if (subtotal !== BigInt(quote.amount.units)) return rejection('invalid_input', 'billing_money')
          const usages = command.usageRefs.map((r) => `${r.authorityId}/${r.usageId}`)
          if (!usages.length || new Set(usages).size !== usages.length)
            return rejection('invalid_input', 'billing_usage')
          if (!d.accounting) return rejection('denied', 'billing_accounting_absent')
          const verifiedFacts: R.UsageFact[] = []
          for (const ref of command.usageRefs) {
            if (ctx.call.signal.aborted) return rejection('denied', 'permission_absent')
            const fetched = await until(d.accounting.readUsage(ref, ctx.call), ctx.call)
            if (!fetched.ok) return fetched
            const checked = validateRuntime('UsageFact', fetched.value)
            if (
              !checked.ok ||
              checked.value.usageId !== ref.usageId ||
              canonicalJsonDigest(checked.value) !== ref.digest
            )
              return rejection('conflict', 'billing_usage_source')
            const leaf = structuredClone(checked.value)
            const identity = canonicalJsonDigest({
              authorityId: ref.authorityId,
              actionId: leaf.actionId,
              attemptId: leaf.attemptId,
              externalRequest: {
                system: leaf.externalRequest.system,
                requestId: leaf.externalRequest.requestId,
              },
            })
            if (origins.includes(identity)) return rejection('conflict', 'idempotency_conflict')
            origins.push(identity)
            verifiedFacts.push(leaf)
          }
          const original = await until(d.accounting.reservation(command, ctx.call), ctx.call)
          if (!original.ok) return original
          if (ctx.call.signal.aborted) return rejection('denied', 'permission_absent')
          const settled = await until(
            d.accounting.settle(
              {
                reservationRef: original.value,
                usageRefs: command.usageRefs,
              },
              ctx.call,
            ),
            ctx.call,
          )
          if (!settled.ok) return settled
          if (verifiedFacts.some((f) => f.certainty === 'unknown'))
            return rejection('unknown_effect', 'billing_usage_unknown')
          const valid = validateRuntime('BudgetSettleResult', settled.value)
          if (!valid.ok) return rejection('conflict', 'billing_settlement_source')
          const budget = valid.value.reservation
          if (budget.status !== 'settled' || budget.settledAmount === null)
            return rejection('unknown_effect', 'billing_settlement_unknown')
          const pairs = [
            [budget.ref, original.value],
            [budget.accountRef, command.accountRef],
            [budget.usageRefs, command.usageRefs],
            [budget.settledAmount, quote.amount],
          ] as const
          if (
            pairs.some(([a, b]) => canonicalJsonDigest(a) !== canonicalJsonDigest(b)) ||
            budget.priceVersion !== quote.priceVersion ||
            verifiedFacts.some((f) => f.actionId !== budget.actionId || f.attemptId !== budget.attemptId)
          )
            return rejection('conflict', 'billing_settlement_source')
          const identity = {
            owner,
            authorityId: d.authorityId,
            key: command.chargeKey,
            account: { authorityId: command.accountRef.authorityId, id: command.accountRef.id },
          }
          candidate = {
            kind: 'charge',
            entryId: canonicalJsonDigest(identity),
            chargeKey: command.chargeKey,
            accountRef: command.accountRef,
            amount: quote.amount,
            quoteRef: command.quoteRef,
            usageRefs: command.usageRefs,
            reversesEntryId: null,
            paymentReceipt: null,
            status: 'pending',
            externalRequestId: canonicalJsonDigest({
              owner,
              key: command.chargeKey,
              account: { authorityId: command.accountRef.authorityId, id: command.accountRef.id },
            }),
          }
        } else {
          const command = parsed as R.BillingRefundRequest,
            source = locate(command.chargeRef, owner)
          if (!source) return rejection('denied', 'billing_balance')
          if (!/^(0|[1-9][0-9]*)$/.test(command.amount.units))
            return rejection('invalid_input', 'billing_money')
          candidate = {
            ...source,
            kind: 'refund',
            chargeKey: command.refundKey,
            entryId: canonicalJsonDigest({
              owner,
              key: command.refundKey,
              account: { authorityId: source.accountRef.authorityId, id: source.accountRef.id },
            }),
            amount: command.amount,
            reversesEntryId: source.entryId,
            status: 'pending',
            paymentReceipt: null,
            externalRequestId: canonicalJsonDigest({
              owner,
              key: command.refundKey,
              account: { authorityId: source.accountRef.authorityId, id: source.accountRef.id },
            }),
          }
        }
        const index = canonicalJsonDigest({
            owner,
            authorityId: d.authorityId,
            account: { authorityId: candidate.accountRef.authorityId, id: candidate.accountRef.id },
            key: candidate.chargeKey,
          }),
          signature = canonicalJsonDigest(parsed)
        let first = false
        const prepared = book.change((doc) => {
          const old = doc.rows.find((r) => r.key === index)
          if (old)
            return old.signature === signature
              ? { ok: true as const, value: old.entry }
              : rejection('conflict', 'idempotency_conflict')
          if (
            candidate.kind === 'charge' &&
            doc.rows.some(
              (r) => r.entry.kind === 'charge' && r.entry.status !== 'rejected' && !r.origins?.length,
            )
          )
            return rejection('denied', 'billing_balance')
          if (
            candidate.kind === 'charge' &&
            doc.rows.some(
              (r) =>
                r.owner === owner &&
                r.entry.kind === 'charge' &&
                r.entry.status !== 'rejected' &&
                r.entry.usageRefs.some((a) =>
                  candidate.usageRefs.some((b) => a.authorityId === b.authorityId && a.usageId === b.usageId),
                ),
            )
          )
            return rejection('conflict', 'idempotency_conflict')
          if (
            candidate.kind === 'charge' &&
            doc.rows.some(
              (r) =>
                r.entry.status !== 'rejected' && (r.origins ?? []).some((origin) => origins.includes(origin)),
            )
          )
            return rejection('conflict', 'idempotency_conflict')
          if (candidate.kind === 'refund') {
            const source = doc.rows.find(
              (r) => r.owner === owner && r.entry.entryId === candidate.reversesEntryId,
            )?.entry
            if (
              source?.kind !== 'charge' ||
              source.status !== 'posted' ||
              source.amount.currency !== candidate.amount.currency ||
              source.amount.scale !== candidate.amount.scale
            )
              return rejection('denied', 'billing_balance')
            let available = BigInt(source.amount.units)
            for (const r of doc.rows)
              if (
                r.owner === owner &&
                r.entry.reversesEntryId === source.entryId &&
                r.entry.status !== 'rejected'
              )
                available -= BigInt(r.entry.amount.units)
            if (available < BigInt(candidate.amount.units)) return rejection('denied', 'billing_balance')
          }
          first = true
          doc.rows.push({ owner, key: index, signature, entry: candidate, confirmation: null, origins })
          return { ok: true as const, value: candidate }
        })
        if (!prepared.ok) return prepared
        if (ctx.call.signal.aborted || !(await until(d.authorize(ctx.call, method, parsed), ctx.call)))
          return rejection('denied', 'permission_absent')
        if (['posted', 'rejected'].includes(prepared.value.status))
          return { ok: true, value: serial(refs.output, prepared.value) }
        const uncertain = () => {
          book.change((doc) => {
            const row = doc.rows.find((r) => r.key === index)
            if (row?.entry.status === 'pending') row.entry.status = 'unknown'
          })
          return rejection('unknown_effect', 'effect_unknown')
        }
        if (probe || !first) return uncertain()
        try {
          const wire = await deliver(d.outbound, prepared.value, ctx)
          if (!wire.ok || wire.value.status < 200 || wire.value.status >= 300) return uncertain()
          const returned = await until(d.readResponse(wire.value.bodyRef, ctx.call), ctx.call)
          if (
            createHash('sha256').update(returned).digest('hex') !== wire.value.bodyRef.digest ||
            returned.length !== wire.value.bodyRef.bytes
          ) {
            uncertain()
            return rejection('conflict', 'idempotency_conflict')
          }
          const data = JSON.parse(new TextDecoder().decode(returned)),
            checked = validateRuntime('BillingEntry', data)
          if (!checked.ok) {
            uncertain()
            return rejection('conflict', 'idempotency_conflict')
          }
          const output = confirm(
            prepared.value.entryId,
            owner,
            checked.value,
            serial(RuntimeMethodSchemaRefs['agh.network'].request.output, wire.value),
          )
          if (!output.ok) uncertain()
          return output.ok ? { ok: true, value: serial(refs.output, output.value) } : output
        } catch {
          return uncertain()
        }
      },
      owners: () =>
        book
          .view()
          .rows.filter((r) => r.confirmation === null)
          .map((r) => r.entry.entryId),
      finish: () => book.close(),
    }
  })
}
