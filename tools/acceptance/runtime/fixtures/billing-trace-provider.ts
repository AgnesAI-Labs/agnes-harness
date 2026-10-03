import { createBillingTraceNetworkFixture } from '../../../../packages/extension-api/testkit/runtime/contracts/billing.js'
import {
  type BillingTraceFixtureOptions,
  createBillingTraceConsumer,
} from '../../../../packages/host/test/runtime/billing-trace-fixture.js'

// Test-only entry point; product provider modules have no executable main.
const options = JSON.parse(process.argv[2] ?? '') as BillingTraceFixtureOptions
const consumer = await createBillingTraceConsumer({
  ...options,
  createEffects: createBillingTraceNetworkFixture,
})
process.send?.({ ready: true, pid: process.pid, descriptor: consumer.descriptor })
process.on('message', async (data: { id: number; method: string; input: unknown; mode?: string }) => {
  try {
    let result: unknown
    switch (data.method) {
      case 'prepare-accounting':
        result = await consumer.prepareAccounting()
        break
      case 'accounting-stats':
        result = consumer.accountingStats()
        break
      case 'retire-price':
        consumer.retirePrice()
        break
      case 'record':
        result = await consumer.record(data.input, data.mode)
        break
      case 'export':
      case 'post':
      case 'refund':
      case 'reconcile':
        result = await consumer.action(data.method, data.input, data.mode)
        break
      case 'cancel':
        consumer.cancel()
        break
      case 'revoke':
        consumer.revoke()
        break
      case 'consent':
        consumer.changeConsent(data.input as 'ANON')
        break
      case 'stop':
        await consumer.stop()
        break
      case 'close':
        await consumer.close()
        break
      default:
        throw new Error('unknown fixture operation')
    }
    process.send?.({ id: data.id, result })
  } catch (error) {
    process.send?.({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
})
