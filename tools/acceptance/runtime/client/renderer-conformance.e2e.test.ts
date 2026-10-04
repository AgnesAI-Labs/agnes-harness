import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.ts'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { bindConformance } from './renderer-conformance.ts'

const CONTRACT = 'agh.renderer'
// Recover kills a real client process with SIGKILL and starts a second one for each provider, so this
// run needs more than the default timeout on slow hosts.
const CONTRACT_TIMEOUT_MS = 60_000

const PROVIDERS = ['default', 'reference']

describe('default and reference renderers: conformance', () => {
  it(
    'pass select, normal, deny, cancel, recover and dispose',
    async () => {
      const harness = createConformanceHarness()
      const request = { command: 'renderer-conformance', contracts: [CONTRACT], providers: PROVIDERS }
      expect(await bindConformance(harness, request)).toEqual({ contracts: [CONTRACT], providers: PROVIDERS })
      const report = await harness.run({
        ...request,
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
      expect(
        report.assertions.map((row) => [
          row.providerId,
          row.scenario,
          row.status,
          row.fixture,
          row.diagnostic,
        ]),
      ).toEqual(
        PROVIDERS.flatMap((providerId) =>
          SCENARIOS.map((scenario) => [providerId, scenario, 'passed', 'test-client-host', undefined]),
        ),
      )
      expect(report.status).toBe('passed')
      expect(report.failures).toEqual([])
    },
    CONTRACT_TIMEOUT_MS,
  )
})
