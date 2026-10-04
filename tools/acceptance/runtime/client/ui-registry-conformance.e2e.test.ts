import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { bindConformance } from './ui-registry-conformance.js'

// Recover kills a real client process with SIGKILL and starts a second one, so this run is heavy and
// needs more than the default timeout on slow hosts.
const CONTRACT_TIMEOUT_MS = 30_000

describe('web client default ui registry: conformance', () => {
  it(
    'passes select, normal, deny, cancel, recover and dispose against the recording host',
    async () => {
      const harness = createConformanceHarness()
      const request = { command: 'default-ui-registry-conformance', providers: ['default'] }
      const bound = await bindConformance(harness, { ...request, contracts: ['agh.ui-registry'] })
      expect(bound).toEqual({ contracts: ['agh.ui-registry'], providers: ['default'] })
      const report = await harness.run({
        ...request,
        contracts: ['agh.ui-registry'],
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
      expect(report.assertions.map((item) => [item.scenario, item.status, item.fixture])).toEqual(
        SCENARIOS.map((scenario) => [scenario, 'passed', 'test-client-host']),
      )
      expect(report.status).toBe('passed')
    },
    CONTRACT_TIMEOUT_MS,
  )
})
