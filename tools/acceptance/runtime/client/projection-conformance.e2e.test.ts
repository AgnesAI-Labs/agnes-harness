import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.ts'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { bindConformance } from './projection-conformance.ts'

const CONTRACT = 'agh.projection'
const PROVIDERS = ['default', 'reference']
// Recover kills a real provider process with SIGKILL twice for each provider, so this run needs more than
// the default timeout on slow hosts.
const CONTRACT_TIMEOUT_MS = 60_000

describe('default and reference projection providers: conformance', () => {
  it(
    'pass select, normal, deny, cancel, recover and dispose, the default marked as run on test stand-ins',
    async () => {
      const harness = createConformanceHarness()
      const request = { command: 'projection-conformance', contracts: [CONTRACT], providers: PROVIDERS }
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
            scenario === 'select'
              ? 'test-service-container'
              : providerId === 'default'
                ? 'restricted-effects'
                : null,
          ]),
        ),
      )
      // Every default pass names the test database it ran on; no reference pass claims one.
      expect(
        report.assertions.map((row) => row.diagnostic?.includes('test SQLite database') ?? false),
      ).toEqual(PROVIDERS.flatMap((providerId) => SCENARIOS.map(() => providerId === 'default')))
      expect(report.status).toBe('passed')
      expect(report.failures).toEqual([])
    },
    CONTRACT_TIMEOUT_MS,
  )
})
