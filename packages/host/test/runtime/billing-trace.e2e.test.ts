import type { BillingEntry } from '@agnes/protocol/runtime'
import { RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { runBillingContractScenario } from '../../../extension-api/testkit/runtime/contracts/billing.js'
import { runTraceContractScenario } from '../../../extension-api/testkit/runtime/contracts/trace.js'
import { inline } from '../../src/runtime/trace/provider-support.js'
import { billingInput, exportInput } from './billing-trace-fixture.js'
import {
  billingContractDriver,
  billingTraceProcessDriver,
  traceContractDriver,
} from './billing-trace-process.js'

describe.each(['default', 'reference'] as const)('billing and OTLP real-process conformance %s', (kind) => {
  it.each(['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)(
    '%s validates two actual peers',
    async (scenario) => {
      const billing = await runBillingContractScenario(billingContractDriver(kind, scenario), scenario)
      const trace = await runTraceContractScenario(traceContractDriver(kind, scenario), scenario)
      expect(billing.length).toBeGreaterThan(0)
      expect(trace.length).toBeGreaterThan(0)
    },
    60000,
  )
  it.each(['billing', 'trace'] as const)(
    'kills %s after peer acceptance and never blindly sends again',
    async (service) => {
      const driver = billingTraceProcessDriver(service, kind, { crashAfterSend: true })
      try {
        await driver.start()
        await expect(
          driver.invoke(
            service === 'billing' ? 'post' : 'export',
            service === 'billing' ? billingInput : exportInput(),
          ),
        ).rejects.toThrow('provider process exited')
        expect(await driver.deliveries()).toBe(1)
        await driver.restart()
        const result = (await driver.invoke(
          service === 'billing' ? 'post' : 'export',
          service === 'billing' ? billingInput : exportInput(),
        )) as { outcome: string }
        expect(result.outcome).toBe('unknown_effect')
        expect(await driver.deliveries()).toBe(1)
      } finally {
        await driver.close()
      }
    },
    30000,
  )
})

describe.each(['default', 'reference'] as const)('public Usage/Budget to billing recovery %s', (kind) => {
  it.each(['usage', 'quote', 'budget', 'intent', 'send', 'callback'] as const)(
    'retains one original usage and settlement after SIGKILL at %s',
    async (boundary) => {
      const driver = billingTraceProcessDriver('billing', kind, {
        accountingChain: true,
        pricingRate: '317',
        ...(boundary === 'send' ? { crashAfterSend: true } : { crashBoundary: boundary }),
      })
      try {
        await driver.start()
        let input: typeof billingInput
        if (['usage', 'quote'].includes(boundary)) {
          await expect(driver.invoke('prepare-accounting')).rejects.toThrow('provider process exited')
          const cold = await driver.restart()
          expect(cold.pid).not.toBe(cold.previousPid)
          input = (await driver.invoke('prepare-accounting')) as typeof billingInput
        } else {
          input =
            boundary === 'send'
              ? (driver.input as typeof billingInput)
              : ((await driver.invoke('prepare-accounting')) as typeof billingInput)
        }
        if (!['usage', 'quote'].includes(boundary)) {
          await expect(driver.post(input)).rejects.toThrow('provider process exited')
          const cold = await driver.restart()
          expect(cold.pid).not.toBe(cold.previousPid)
        }
        const result = (await driver.post(input)) as {
          outcome: string
          result?: { kind: string; value: unknown }
        }
        expect(result.outcome).toBe(['intent', 'send'].includes(boundary) ? 'unknown_effect' : 'succeeded')
        const stats = (await driver.invoke('accounting-stats')) as {
          usageFacts: number
          origins: number
          settled: string
          reservation: { status: string; priceVersion: string }
        }
        expect(stats).toMatchObject({
          usageFacts: 1,
          origins: 1,
          settled: '317',
          pricingProviderId: 'synthetic.replacement-catalog',
          measurements: [
            {
              kind: 'inline',
              value: {
                billing: { usdMicros: 317, source: 'estimated', subscription: false },
                credits: 0,
                creditSource: 'gateway',
              },
            },
          ],
          reservation: { status: 'settled', priceVersion: 'synthetic-price-v1' },
        })
        expect(await driver.deliveries()).toBe(boundary === 'intent' ? 0 : 1)
        if (boundary !== 'intent') {
          const delivered = driver.records()[0]!.body as BillingEntry
          expect(delivered.amount.units).toBe('317')
          const proof = { ...delivered, status: 'posted' as const }
          const callback = {
            chargeRef: {
              authorityId: 'synthetic-billing',
              typeId: 'agh.billing/entry@1',
              id: delivered.entryId,
              revision: 1,
            },
            evidenceRef: inline(RuntimeMethodSchemaRefs['agh.billing'].post.output, proof),
          }
          const accepted = await driver.invoke('reconcile', callback)
          expect(await driver.invoke('reconcile', callback)).toEqual(accepted)
          expect((accepted as { outcome: string }).outcome).toBe('succeeded')
          expect(
            (
              (await driver.invoke('reconcile', {
                ...callback,
                evidenceRef: inline(RuntimeMethodSchemaRefs['agh.billing'].post.output, {
                  ...proof,
                  status: 'rejected',
                }),
              })) as { error: { code: string } }
            ).error.code,
          ).toBe('conflict')
          const finalCold = await driver.restart()
          expect(finalCold.pid).not.toBe(finalCold.previousPid)
          expect(((await driver.post(input)) as { outcome: string }).outcome).toBe('succeeded')
          expect(await driver.invoke('accounting-stats')).toEqual(stats)
          expect(await driver.deliveries()).toBe(1)
          await driver.restartPeer()
          expect(((await driver.post(input)) as { outcome: string }).outcome).toBe('succeeded')
          expect(await driver.deliveries()).toBe(1)
        } else {
          await driver.restart()
          expect(((await driver.post(input)) as { outcome: string }).outcome).toBe('unknown_effect')
          expect(await driver.invoke('accounting-stats')).toEqual(stats)
          expect(await driver.deliveries()).toBe(0)
        }
      } finally {
        await driver.close()
      }
    },
    60000,
  )
})
