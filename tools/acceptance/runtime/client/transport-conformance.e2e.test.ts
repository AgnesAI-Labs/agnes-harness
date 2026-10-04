import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { bindConformance } from './transport-conformance.js'

const CONTRACT = 'agh.transport'
const PROVIDERS = ['default', 'reference']
// Every scenario starts real loopback listeners, one over TLS, and drives them with the SDK client.
const CONTRACT_TIMEOUT_MS = 60_000

describe('default and reference runtime client transports: conformance', () => {
  it(
    'pass select, normal, deny, cancel, recover and dispose, the default marked as run on test stand-ins',
    async () => {
      const harness = createConformanceHarness()
      const request = { command: 'transport-conformance', contracts: [CONTRACT], providers: PROVIDERS }
      expect(await bindConformance(harness, request)).toEqual({ contracts: [CONTRACT], providers: PROVIDERS })
      const report = await harness.run({
        ...request,
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
      expect(report.assertions.map((row) => [row.providerId, row.scenario, row.status, row.fixture])).toEqual(
        PROVIDERS.flatMap((providerId) =>
          SCENARIOS.map((scenario) => [
            providerId,
            scenario,
            'passed',
            providerId === 'default' ? 'restricted-effects' : null,
          ]),
        ),
      )
      // Every default pass names the stand-in owner and credentials it ran on; no reference pass claims one.
      expect(report.assertions.map((row) => row.diagnostic?.includes('recording owner') ?? false)).toEqual(
        PROVIDERS.flatMap((providerId) => SCENARIOS.map(() => providerId === 'default')),
      )
      expect(report.status).toBe('passed')
      expect(report.failures).toEqual([])
    },
    CONTRACT_TIMEOUT_MS,
  )
})
