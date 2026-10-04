import { describe, expect, it } from 'vitest'
import { contracts } from '../../../packages/extension-api/testkit/index.js'
import { createConformanceHarness } from '../../../packages/extension-api/testkit/runtime/harness.js'
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

for (const kind of ['default', 'reference'] as const)
  it(`${kind} rejects evidence attributed to an unexecuted provider`, async () => {
    const harness = createConformanceHarness()
    contracts.registerPricingContract(harness, {
      providerId: 'foreign.unexecuted.provider',
      command: 'pricing-binding-test',
      releaseSetDigest: 'a'.repeat(64),
      build: {
        codeSha: 'fixture-build',
        buildDigest: 'b'.repeat(64),
        lockDigest: 'c'.repeat(64),
        specVersion: '1.0.0',
        sdkVersion: '1.0.0',
        sdkDigest: 'd'.repeat(64),
        platform: 'darwin-arm64',
      },
      async create() {
        return createPricingContractFixture(kind)
      },
    })
    const report = await harness.run({
      contracts: ['agh.pricing'],
      providers: ['foreign.unexecuted.provider'],
      command: 'pricing-binding-test',
      clock: { startedAt: '2026-10-04T00:00:00.000Z', finishedAt: '2026-10-04T00:00:01.000Z' },
    })
    const normal = report.assertions.find((assertion) => assertion.scenario === 'normal')
    expect(normal).toBeDefined()
    expect(normal?.status).toBe('failed')
  })
