import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BillingEntry, PriceQuote } from '@agnes/protocol/runtime'
import { RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createBillingTraceNetworkFixture } from '../../../extension-api/testkit/runtime/contracts/billing.js'
import { inline } from '../../src/runtime/trace/provider-support.js'
import { billingInput, createBillingTraceConsumer, refundInput } from './billing-trace-fixture.js'

describe.each(['default', 'reference'] as const)('billing %s', (kind) => {
  it.each(['posted', 'unknown-refund'] as const)(
    'settles once; refuses key changes, over-refund, foreign currency and conflicting callback (%s)',
    async (mode) => {
      let deliveries = 0
      const remote = createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const part of req) chunks.push(Buffer.from(part))
        deliveries++
        const input = JSON.parse(Buffer.concat(chunks).toString())
        if (mode === 'unknown-refund' && input.kind === 'refund') {
          req.socket.destroy()
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ...JSON.parse(Buffer.concat(chunks).toString()), status: 'posted' }))
      })
      await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
      const directory = mkdtempSync(join(tmpdir(), 'billing-local-')),
        consumer = await createBillingTraceConsumer({
          createEffects: createBillingTraceNetworkFixture,
          directory,
          kind,
          service: 'billing',
          port: (remote.address() as { port: number }).port,
        })
      try {
        if (billingInput.quoteRef.kind !== 'inline') throw new Error('fixture quote absent')
        const quote = billingInput.quoteRef.value as unknown as PriceQuote
        for (const invalid of [
          { ...quote, priceVersion: 'unknown-price' },
          { ...quote, amount: { ...quote.amount, units: '101' } },
          {
            ...quote,
            lineItems: quote.lineItems.map((line) => ({
              ...line,
              amount: { ...line.amount, currency: 'EUR' },
            })),
          },
        ]) {
          const rejected = await consumer.action('post', {
            ...billingInput,
            quoteRef: inline(RuntimeMethodSchemaRefs['agh.pricing'].quote.output, invalid),
          })
          expect(rejected.error?.code).toBe(
            invalid.priceVersion === 'unknown-price' ? 'incompatible' : 'invalid_input',
          )
        }
        expect(deliveries).toBe(0)
        const first = await consumer.action('post', billingInput, 'drain')
        expect(first.outcome).toBe('succeeded')
        expect(await consumer.action('post', billingInput)).toEqual(first)
        expect(
          (await consumer.action('post', { ...billingInput, chargeKey: 'second-key' })).error?.code,
        ).toBe('conflict')
        const changed = await consumer.action('post', {
          ...billingInput,
          usageRefs: [{ ...billingInput.usageRefs[0], usageId: 'another' }],
        })
        expect(changed.error?.code).toBe('conflict')
        const entry = first.result?.kind === 'inline' ? (first.result.value as unknown as BillingEntry) : null
        expect(entry?.status).toBe('posted')
        if (!entry) throw new Error('posted entry absent')
        const matchingReceipt = {
          chargeRef: refundInput(entry.entryId).chargeRef,
          evidenceRef: inline(RuntimeMethodSchemaRefs['agh.billing'].post.output, {
            ...entry,
            paymentReceipt: null,
          }),
        }
        const expectedReconciled = inline(RuntimeMethodSchemaRefs['agh.billing'].reconcile.output, entry)
        expect((await consumer.action('reconcile', matchingReceipt)).result).toEqual(expectedReconciled)
        expect((await consumer.action('reconcile', matchingReceipt)).result).toEqual(expectedReconciled)
        const refund = refundInput(entry.entryId),
          returned = await consumer.action('refund', refund)
        expect(returned.outcome).toBe(mode === 'posted' ? 'succeeded' : 'unknown_effect')
        expect(await consumer.action('refund', refund)).toEqual(returned)
        expect((await consumer.action('refund', { ...refund, reason: 'changed' })).error?.code).toBe(
          'conflict',
        )
        expect(
          (
            await consumer.action('refund', {
              ...refund,
              refundKey: 'excess',
              amount: { ...refund.amount, units: '61' },
            })
          ).error?.code,
        ).toBe('denied')
        expect(
          (
            await consumer.action('refund', {
              ...refund,
              refundKey: 'eur',
              amount: { ...refund.amount, currency: 'EUR' },
            })
          ).error?.code,
        ).toBe('denied')
        const callback = await consumer.action('reconcile', {
          chargeRef: refund.chargeRef,
          evidenceRef: inline(RuntimeMethodSchemaRefs['agh.billing'].post.output, {
            ...entry,
            status: 'rejected',
            paymentReceipt: null,
          }),
        })
        expect(callback.error?.code).toBe('conflict')
        expect(deliveries).toBe(2)
      } finally {
        await consumer.close()
        await new Promise<void>((resolve) => remote.close(() => resolve()))
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
