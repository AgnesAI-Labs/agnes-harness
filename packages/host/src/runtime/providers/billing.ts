import { createHash } from 'node:crypto'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { type BillingAccountingPorts, settleBillingUsage } from '../billing/accounting.js'
import { BillingConflict, BillingRefusal, openSettlementOutbox } from '../billing/settlement-outbox.js'
import {
  inline,
  type ManagedOutbound,
  providerFactory,
  read,
  refused,
  send,
  wait,
} from '../trace/provider-support.js'

export type BillingDeployment = {
  path: string
  authorityId: string
  packageDigest: string
  configSchema: W.SchemaRef
  priceVersions: readonly string[]
  accounting?: BillingAccountingPorts
  authorize(
    context: CallContext,
    method: string,
    input: W.BillingPostRequest | W.BillingRefundRequest | W.BillingReconcileRequest,
  ): Promise<boolean>
  outbound: ManagedOutbound
  readResponse(ref: W.BytesRef, context: CallContext): Promise<Uint8Array>
  verifyEvidence(ref: W.DataRef, context: CallContext): Promise<Outcome<W.BillingEntry>>
}
export function createBillingFactory(deployment: BillingDeployment) {
  deployment = {
    ...deployment,
    priceVersions: [...deployment.priceVersions],
    ...(deployment.accounting
      ? {
          accounting: {
            ...deployment.accounting,
            ...(deployment.accounting.pricing ? { pricing: { ...deployment.accounting.pricing } } : {}),
          },
        }
      : {}),
    outbound: { ...deployment.outbound, target: structuredClone(deployment.outbound.target) },
  }
  const refs = RuntimeMethodSchemaRefs['agh.billing']
  return providerFactory('agh.billing', deployment.packageDigest, deployment.configSchema, () => {
    const outbox = openSettlementOutbox(deployment.path, deployment.authorityId)
    async function execute(
      frame: W.ActionFrame,
      context: ActionContext,
      lookupOnly: boolean,
    ): Promise<Outcome<W.DataRef>> {
      const method = frame.method
      const name =
        method === 'post'
          ? 'BillingPostRequest'
          : method === 'refund'
            ? 'BillingRefundRequest'
            : 'BillingReconcileRequest'
      const schema = method === 'post' ? refs.post : method === 'refund' ? refs.refund : refs.reconcile
      const decoded = read<W.BillingPostRequest | W.BillingRefundRequest | W.BillingReconcileRequest>(
        frame.input,
        schema.input,
        name,
      )
      if (!decoded.ok) return decoded
      if (
        !(await wait(deployment.authorize(context.call, method, decoded.value), context.call)) ||
        context.call.signal.aborted
      )
        return refused('denied', 'permission_absent')
      const owner = canonicalJsonDigest({ scope: context.call.scope, principal: context.call.principalRef })
      let origins: string[] = []
      let entered = false,
        entry: W.BillingEntry | undefined
      try {
        if (method === 'reconcile') {
          const request = decoded.value as W.BillingReconcileRequest
          entry = outbox.inspect(request.chargeRef, owner)
          const proof = await wait(deployment.verifyEvidence(request.evidenceRef, context.call), context.call)
          if (!proof.ok) return proof
          if (
            context.call.signal.aborted ||
            !(await wait(deployment.authorize(context.call, method, request), context.call))
          )
            return refused('denied', 'permission_absent')
          return {
            ok: true,
            value: inline(
              schema.output,
              outbox.accept(entry.entryId, owner, proof.value, request.evidenceRef),
            ),
          }
        }
        if (method === 'post') {
          const request = decoded.value as W.BillingPostRequest
          const replay = outbox.replay(
            owner,
            request.accountRef,
            request.chargeKey,
            canonicalJsonDigest(request),
          )
          if (replay)
            return ['posted', 'rejected'].includes(replay.status)
              ? { ok: true, value: inline(schema.output, replay) }
              : refused('unknown_effect', 'effect_unknown')
          const quote = read<W.PriceQuote>(
            request.quoteRef,
            RuntimeMethodSchemaRefs['agh.pricing'].quote.output,
            'PriceQuote',
          )
          if (!quote.ok) return quote
          if (!deployment.priceVersions.includes(quote.value.priceVersion))
            return refused('incompatible', 'price_version')
          if (
            !/^(0|[1-9][0-9]*)$/u.test(quote.value.amount.units) ||
            quote.value.amount.scale !== 6 ||
            !quote.value.amount.currency
          )
            return refused('invalid_input', 'billing_money')
          if (
            quote.value.lineItems.some((line) =>
              [line.amount, line.unitPrice].some(
                (money) =>
                  money.currency !== quote.value.amount.currency ||
                  money.scale !== quote.value.amount.scale ||
                  !/^(0|[1-9][0-9]*)$/.test(money.units),
              ),
            ) ||
            quote.value.lineItems.reduce((sum, line) => sum + BigInt(line.amount.units), 0n) !==
              BigInt(quote.value.amount.units)
          )
            return refused('invalid_input', 'billing_money')
          if (
            new Set(request.usageRefs.map((r) => `${r.authorityId}/${r.usageId}`)).size !==
              request.usageRefs.length ||
            request.usageRefs.length === 0
          )
            return refused('invalid_input', 'billing_usage')
          if (!deployment.accounting) return refused('denied', 'billing_accounting_absent')
          const settled = await wait(
            settleBillingUsage(deployment.accounting, request, quote.value, context.call),
            context.call,
          )
          if (!settled.ok) return settled
          origins = settled.value
          entry = {
            entryId: canonicalJsonDigest({
              owner,
              authorityId: deployment.authorityId,
              key: request.chargeKey,
              account: { authorityId: request.accountRef.authorityId, id: request.accountRef.id },
            }),
            accountRef: request.accountRef,
            chargeKey: request.chargeKey,
            kind: 'charge',
            amount: quote.value.amount,
            quoteRef: request.quoteRef,
            usageRefs: request.usageRefs,
            reversesEntryId: null,
            status: 'pending',
            externalRequestId: canonicalJsonDigest({
              owner,
              key: request.chargeKey,
              account: { authorityId: request.accountRef.authorityId, id: request.accountRef.id },
            }),
            paymentReceipt: null,
          }
        } else {
          const request = decoded.value as W.BillingRefundRequest,
            charge = outbox.inspect(request.chargeRef, owner)
          if (!/^(0|[1-9][0-9]*)$/u.test(request.amount.units))
            return refused('invalid_input', 'billing_money')
          entry = {
            ...charge,
            entryId: canonicalJsonDigest({
              owner,
              key: request.refundKey,
              account: { authorityId: charge.accountRef.authorityId, id: charge.accountRef.id },
            }),
            chargeKey: request.refundKey,
            kind: 'refund',
            amount: request.amount,
            reversesEntryId: charge.entryId,
            status: 'pending',
            externalRequestId: canonicalJsonDigest({
              owner,
              key: request.refundKey,
              account: { authorityId: charge.accountRef.authorityId, id: charge.accountRef.id },
            }),
            paymentReceipt: null,
          }
        }
        const intent = outbox.prepare(
          owner,
          entry.chargeKey,
          canonicalJsonDigest(decoded.value),
          entry,
          origins,
        )
        entry = intent.entry
        if (
          !(await wait(deployment.authorize(context.call, method, decoded.value), context.call)) ||
          context.call.signal.aborted
        )
          return refused('denied', 'permission_absent')
        if (['posted', 'rejected'].includes(entry.status))
          return { ok: true, value: inline(schema.output, entry) }
        if (!intent.created || lookupOnly) {
          outbox.uncertain(entry.entryId, owner)
          return refused('unknown_effect', 'effect_unknown')
        }
        entered = true
        const delivery = await send(deployment.outbound, entry, context)
        if (!delivery.ok || delivery.value.status < 200 || delivery.value.status >= 300) {
          outbox.uncertain(entry.entryId, owner)
          return refused('unknown_effect', 'effect_unknown')
        }
        const bytes = await wait(deployment.readResponse(delivery.value.bodyRef, context.call), context.call)
        if (
          bytes.byteLength !== delivery.value.bodyRef.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== delivery.value.bodyRef.digest
        )
          throw new BillingConflict('receipt bytes mismatch')
        const verified = validateRuntime('BillingEntry', JSON.parse(new TextDecoder().decode(bytes)))
        if (!verified.ok) throw new BillingConflict('invalid receipt')
        const posted = outbox.accept(
          entry.entryId,
          owner,
          verified.value,
          inline(RuntimeMethodSchemaRefs['agh.network'].request.output, delivery.value),
        )
        return { ok: true, value: inline(schema.output, posted) }
      } catch (error) {
        if (entered && entry) outbox.uncertain(entry.entryId, owner)
        return refused(
          error instanceof BillingConflict
            ? 'conflict'
            : error instanceof BillingRefusal
              ? 'denied'
              : entered
                ? 'unknown_effect'
                : 'internal',
          error instanceof BillingConflict
            ? 'idempotency_conflict'
            : error instanceof BillingRefusal
              ? 'billing_balance'
              : entered
                ? 'effect_unknown'
                : 'storage_failure',
        )
      }
    }
    return { execute, pending: () => outbox.pending(), close: () => outbox.close() }
  })
}
