import { describe, expect, it } from 'vitest'
import { contracts } from '../../../packages/extension-api/testkit/index.js'
import { createPricingContractFixture } from './fixtures/pricing.js'

for (const kind of ['default', 'reference'] as const)
  describe(`pricing public contract ${kind}`, () => {
    for (const scenario of ['select', 'normal', 'deny', 'cancel', 'dispose'] as const)
      it(scenario, async () => {
        const result = await contracts.runPricingContractScenario(scenario, async () =>
          createPricingContractFixture(kind),
        )
        expect(result.providerDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(result.configDigest).toMatch(/^[0-9a-f]{64}$/)
      })
    it('refuses to report recovery when a real fresh-process consumer is absent', async () => {
      await expect(
        contracts.runPricingContractScenario('recover', async () => createPricingContractFixture(kind)),
      ).rejects.toThrow('real process recovery consumer is missing')
    })
  })
