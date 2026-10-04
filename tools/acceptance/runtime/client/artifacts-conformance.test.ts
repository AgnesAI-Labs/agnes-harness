import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { bindConformance } from './artifacts-conformance.js'

const CONTRACTS = ['agh.blob', 'agh.artifacts']
const PROVIDERS = ['default', 'reference']
// Both stores write and read several MiB in each provider, more than the default timeout leaves on slow hosts.
const CONTRACT_TIMEOUT_MS = 60_000

// The reference stores also run the authority transfer suite under each contract.
const SUITES: Record<string, readonly string[]> = { default: [''], reference: ['', '/authority-transfer'] }
const fixture = (providerId: string, scenario: string) =>
  scenario === 'select' ? 'test-service-container' : providerId === 'default' ? 'restricted-effects' : null

describe('default and reference blob and artifacts services: conformance', () => {
  it(
    'pass select, normal, deny, cancel, recover and dispose, the defaults marked as run on test stand-ins',
    async () => {
      const harness = createConformanceHarness()
      const request = { command: 'artifacts-conformance', contracts: CONTRACTS, providers: PROVIDERS }
      expect(await bindConformance(harness, request)).toEqual({ contracts: CONTRACTS, providers: PROVIDERS })
      const report = await harness.run({
        ...request,
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
      const expected = CONTRACTS.flatMap((contract) =>
        PROVIDERS.flatMap((providerId) =>
          (SUITES[providerId] ?? []).flatMap((suite) =>
            SCENARIOS.map((scenario) => [
              `${contract}/${providerId}${suite}/${scenario}`,
              'passed',
              fixture(providerId, scenario),
            ]),
          ),
        ),
      )
      expect(report.assertions.map((row) => [row.id, row.status, row.fixture])).toEqual(expected)
      // Every default pass names the test authorization it ran on; no reference pass claims any.
      expect(
        report.assertions.map((row) => row.diagnostic?.includes('in place of Host authorization') ?? false),
      ).toEqual(expected.map(([id]) => String(id).includes('/default/')))
      expect(report.status).toBe('passed')
      expect(report.failures).toEqual([])
    },
    CONTRACT_TIMEOUT_MS,
  )
})
