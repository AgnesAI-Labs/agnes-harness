import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BillingEntry, BudgetSettleResult, PriceQuote } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createBillingTraceNetworkFixture } from '../../../extension-api/testkit/runtime/contracts/billing.js'
import type { BillingAccountingPorts } from '../../src/runtime/billing/accounting.js'
import { inline } from '../../src/runtime/trace/provider-support.js'
import {
  billingInput,
  createBillingTraceConsumer,
  fixturePricingInput,
  refundInput,
  syntheticUsage,
} from './billing-trace-fixture.js'

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

describe.each(['default', 'reference'] as const)('billing verified accounting %s', (kind) => {
  it('requires original Usage and a matching known Budget settlement before sending, and claims origins across corrected fact IDs', async () => {
    let deliveries = 0
    const peer = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      deliveries++
      res.end(JSON.stringify({ ...JSON.parse(Buffer.concat(chunks).toString()), status: 'posted' }))
    })
    await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
    const directory = mkdtempSync(join(tmpdir(), 'billing-accounting-'))
    let fact = structuredClone(syntheticUsage)
    let mismatch = ''
    const reservationRef = {
      authorityId: 'synthetic-budget',
      typeId: 'agh.budget/reservation@1',
      id: 'synthetic-reservation',
      revision: 1,
    }
    if (billingInput.quoteRef.kind !== 'inline') throw new Error('quote absent')
    const quote = billingInput.quoteRef.value as unknown as PriceQuote
    const accounting: BillingAccountingPorts = {
      pricing: {
        async input() {
          if (mismatch === 'pricing-input')
            return { ok: true, value: { ...fixturePricingInput, priceVersion: 'later-price' } }
          return { ok: true, value: fixturePricingInput }
        },
        async quote() {
          if (mismatch === 'pricing-denied')
            return {
              ok: false,
              error: {
                code: 'denied',
                detailCode: 'pricing_not_current',
                message: 'Synthetic pricing denied',
                diagnosticId: 'fixture',
                retryAdvice: { kind: 'never' },
              },
            }
          if (mismatch === 'pricing-ref')
            return { ok: true, value: { ...billingInput.quoteRef, digest: 'f'.repeat(64) } }
          if (mismatch === 'pricing-amount')
            return {
              ok: true,
              value: inline(RuntimeMethodSchemaRefs['agh.pricing'].quote.output, {
                ...quote,
                amount: { ...quote.amount, units: '101' },
              }),
            }
          return { ok: true, value: billingInput.quoteRef }
        },
      },
      async readUsage() {
        return { ok: true, value: fact }
      },
      async reservation() {
        return { ok: true, value: reservationRef }
      },
      async settle(input) {
        const value: BudgetSettleResult = {
          reservation: {
            ref: reservationRef,
            actionId: fact.actionId,
            attemptId: fact.attemptId,
            accountRef: billingInput.accountRef,
            parentReservationRef: null,
            scopeIds: ['synthetic-scope'],
            unitsByKind: [],
            held: quote.amount,
            priceVersion: quote.priceVersion,
            status: 'settled',
            revision: 2,
            expiresAt: '2099-01-01T00:00:00.000Z',
            settledAmount: quote.amount,
            usageRefs: input.usageRefs,
          },
          balance: null,
        }
        if (mismatch === 'unknown') {
          value.reservation.status = 'unknown'
          value.reservation.settledAmount = null
        }
        if (mismatch === 'units-only') value.reservation.settledAmount = null
        if (mismatch === 'price') value.reservation.priceVersion = 'later-price'
        if (mismatch === 'amount') value.reservation.settledAmount = { ...quote.amount, units: '101' }
        if (mismatch === 'currency') value.reservation.settledAmount = { ...quote.amount, currency: 'EUR' }
        if (mismatch === 'account')
          value.reservation.accountRef = { ...billingInput.accountRef, id: 'foreign' }
        if (mismatch === 'attempt') value.reservation.attemptId = 'foreign'
        if (mismatch === 'refs') value.reservation.usageRefs = []
        return { ok: true, value }
      },
    }
    let consumer = await createBillingTraceConsumer({
      directory,
      kind,
      service: 'billing',
      port: (peer.address() as { port: number }).port,
      createEffects: createBillingTraceNetworkFixture,
      accounting,
    })
    try {
      fact.certainty = 'unknown'
      const unknown = {
        ...billingInput,
        usageRefs: [{ ...billingInput.usageRefs[0]!, digest: canonicalJsonDigest(fact) }],
      }
      expect((await consumer.action('post', unknown)).outcome).toBe('unknown_effect')
      fact = structuredClone(syntheticUsage)
      expect((await consumer.action('post', unknown)).error?.code).toBe('conflict')
      for (mismatch of [
        'pricing-denied',
        'pricing-input',
        'pricing-ref',
        'pricing-amount',
        'unknown',
        'units-only',
        'price',
        'amount',
        'currency',
        'account',
        'attempt',
        'refs',
      ]) {
        const result = await consumer.action('post', billingInput)
        expect(result.error?.code).toBe(
          mismatch === 'pricing-denied'
            ? 'denied'
            : ['unknown', 'units-only'].includes(mismatch)
              ? 'unknown_effect'
              : 'conflict',
        )
      }
      expect(deliveries).toBe(0)
      const savedPricing = accounting.pricing
      if (!savedPricing) throw new Error('Pricing fixture absent')
      delete accounting.pricing
      await consumer.close()
      consumer = await createBillingTraceConsumer({
        directory,
        kind,
        service: 'billing',
        port: (peer.address() as { port: number }).port,
        createEffects: createBillingTraceNetworkFixture,
        accounting,
      })
      expect((await consumer.action('post', billingInput)).error).toMatchObject({
        code: 'denied',
        detailCode: 'billing_pricing_absent',
      })
      expect(deliveries).toBe(0)
      accounting.pricing = savedPricing
      await consumer.close()
      consumer = await createBillingTraceConsumer({
        directory,
        kind,
        service: 'billing',
        port: (peer.address() as { port: number }).port,
        createEffects: createBillingTraceNetworkFixture,
        accounting,
      })
      mismatch = ''
      const first = await consumer.action('post', billingInput)
      expect(first.outcome).toBe('succeeded')
      fact = {
        ...fact,
        usageId: 'synthetic-correction',
        externalRequest: { ...fact.externalRequest, requestDigest: canonicalJsonDigest({ changed: true }) },
      }
      const corrected = {
        ...billingInput,
        chargeKey: 'corrected-charge',
        usageRefs: [
          { ...billingInput.usageRefs[0]!, usageId: fact.usageId, digest: canonicalJsonDigest(fact) },
        ],
      }
      expect((await consumer.action('post', corrected)).error?.code).toBe('conflict')
      expect(await consumer.action('post', billingInput)).toEqual(first)
      expect(deliveries).toBe(1)
      await consumer.close()
      // Model the prior outbox format, which never persisted original origin identities.
      const legacy = new DatabaseSync(join(directory, 'billing.sqlite'))
      if (kind === 'default') legacy.exec('DELETE FROM usage_origins')
      else {
        const row = legacy.prepare('SELECT value FROM cabinet WHERE slot=1').get()
        const book = JSON.parse(String(row?.value))
        for (const entry of book.rows) delete entry.origins
        legacy.prepare('UPDATE cabinet SET value=? WHERE slot=1').run(JSON.stringify(book))
      }
      legacy.close()
      consumer = await createBillingTraceConsumer({
        directory,
        kind,
        service: 'billing',
        port: (peer.address() as { port: number }).port,
        createEffects: createBillingTraceNetworkFixture,
        accounting,
      })
      expect(await consumer.action('post', billingInput)).toEqual(first)
      expect((await consumer.action('post', corrected)).error?.code).toBe('denied')
      fact = structuredClone(syntheticUsage)
      expect(
        (await consumer.action('post', { ...billingInput, chargeKey: 'legacy-new-key' })).error?.code,
      ).toBe('denied')
      expect(deliveries).toBe(1)
    } finally {
      await consumer.close()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('cancels pending pricing without settling a budget or writing an outbound intent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'billing-pricing-cancel-'))
    let entered: () => void = () => {},
      release: () => void = () => {}
    const received = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let settled = false
    const consumer = await createBillingTraceConsumer({
      directory,
      kind,
      service: 'billing',
      port: 1,
      createEffects: createBillingTraceNetworkFixture,
      accounting: {
        readUsage: async () => ({ ok: true, value: structuredClone(syntheticUsage) }),
        pricing: {
          input: async () => ({ ok: true, value: fixturePricingInput }),
          async quote() {
            entered()
            await held
            return { ok: true, value: billingInput.quoteRef }
          },
        },
        reservation: async () => ({
          ok: true,
          value: {
            authorityId: 'synthetic-budget',
            typeId: 'agh.budget/reservation@1',
            id: 'synthetic-reservation',
            revision: 1,
          },
        }),
        async settle() {
          settled = true
          throw new Error('Cancelled pricing must not settle')
        },
      },
    })
    try {
      const pending = consumer.action('post', billingInput)
      await received
      consumer.cancel()
      release()
      const result = await pending
      expect(result.outcome).not.toBe('succeeded')
      expect(settled).toBe(false)
      const outbox = new DatabaseSync(join(directory, 'billing.sqlite'))
      try {
        if (kind === 'default') expect(outbox.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n).toBe(0)
        else {
          const row = outbox.prepare('SELECT value FROM cabinet WHERE slot=1').get()
          expect(JSON.parse(String(row?.value)).rows).toEqual([])
        }
      } finally {
        outbox.close()
      }
    } finally {
      release()
      await consumer.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('fails closed when the accounting adapters are absent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'billing-accounting-absent-'))
    const consumer = await createBillingTraceConsumer({
      directory,
      kind,
      service: 'billing',
      port: 1,
      accounting: null,
      createEffects: createBillingTraceNetworkFixture,
    })
    try {
      expect((await consumer.action('post', billingInput)).error).toMatchObject({
        code: 'denied',
        detailCode: 'billing_accounting_absent',
      })
    } finally {
      await consumer.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

it.each(['100', '317'])(
  'matches results, actual price %s, settlement facts and refusal codes across independent billing providers consuming public services',
  async (pricingRate) => {
    const directory = mkdtempSync(join(tmpdir(), 'billing-accounting-cross-'))
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      res.end(JSON.stringify({ ...JSON.parse(Buffer.concat(chunks).toString()), status: 'posted' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const results: unknown[] = [],
      facts: unknown[] = [],
      failures: unknown[] = []
    try {
      for (const kind of ['default', 'reference'] as const) {
        const consumer = await createBillingTraceConsumer({
          directory: join(directory, kind),
          kind,
          service: 'billing',
          port: (server.address() as { port: number }).port,
          accountingChain: true,
          pricingRate,
          createEffects: createBillingTraceNetworkFixture,
        })
        try {
          const input = await consumer.prepareAccounting()
          if (input.quoteRef.kind !== 'inline') throw new Error('Computed quote absent')
          const quoted = input.quoteRef.value as unknown as PriceQuote
          for (const changed of [
            { ...quoted, inputDigest: 'f'.repeat(64) },
            {
              ...quoted,
              amount: { ...quoted.amount, units: '318' },
              lineItems: quoted.lineItems.map((line) => ({
                ...line,
                amount: { ...line.amount, units: '318' },
                unitPrice: { ...line.unitPrice, units: '318' },
              })),
            },
            { ...quoted, lineItems: quoted.lineItems.map((line) => ({ ...line, ruleId: 'foreign-rule' })) },
          ]) {
            expect(
              (
                await consumer.action('post', {
                  ...input,
                  chargeKey: 'forged-quote',
                  quoteRef: inline(RuntimeMethodSchemaRefs['agh.pricing'].quote.output, changed),
                })
              ).error,
            ).toMatchObject({ code: 'conflict', detailCode: 'billing_pricing_source' })
          }
          expect(consumer.accountingStats()).toMatchObject({ origins: 0, settled: '0' })
          const result = await consumer.action('post', input)
          expect(result.outcome).toBe('succeeded')
          expect(
            result.result?.kind === 'inline' && (result.result.value as unknown as BillingEntry).amount.units,
          ).toBe(pricingRate)
          expect(consumer.accountingStats()).toMatchObject({
            origins: 1,
            settled: pricingRate,
            pricingProviderId: pricingRate === '100' ? 'synthetic.catalog' : 'synthetic.replacement-catalog',
            measurements: [
              {
                kind: 'inline',
                value: {
                  billing: { usdMicros: Number(pricingRate), source: 'estimated', subscription: false },
                  credits: 0,
                  creditSource: 'gateway',
                },
              },
            ],
          })
          results.push(result)
          facts.push(consumer.accountingStats())
          const changed = await consumer.action('post', {
            ...input,
            accountRef: { ...input.accountRef, revision: 2 },
          })
          failures.push({
            outcome: changed.outcome,
            code: changed.error?.code,
            detail: changed.error?.detailCode,
          })
        } finally {
          await consumer.close()
        }
      }
      expect(results[0]).toEqual(results[1])
      expect(facts[0]).toEqual(facts[1])
      expect(failures[0]).toEqual(failures[1])
      expect(failures[0]).toMatchObject({ code: 'conflict' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
