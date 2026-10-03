import { describe, expect, it } from 'vitest'
import { runBillingContractScenario } from '../../../extension-api/testkit/runtime/contracts/billing.js'
import { runTraceContractScenario } from '../../../extension-api/testkit/runtime/contracts/trace.js'
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
