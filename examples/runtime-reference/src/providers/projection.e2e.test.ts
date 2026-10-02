import { createConformanceHarness, SCENARIOS } from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'
import type { ProjectionContractPort } from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import { PROJECTION_PROVIDER } from './projection.js'
import { bindProjectionContract } from './projection-contract.js'

// Recover kills real provider processes with SIGKILL, so every run of the contract is heavy.
// Each run starts two provider processes; the default timeout leaves too little room on slow hosts.
const CONTRACT_TIMEOUT_MS = 30_000

describe('reference projection: conformance', () => {
  async function runContract(change: (port: ProjectionContractPort) => ProjectionContractPort) {
    const harness = createConformanceHarness()
    const bound = bindProjectionContract(harness, 'reference-projection-conformance', { change })
    try {
      return await harness.run({
        contracts: ['agh.projection'],
        providers: [PROJECTION_PROVIDER.id],
        command: 'reference-projection-conformance',
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
    } finally {
      bound.close()
    }
  }

  it(
    'passes select, normal, deny, cancel, recover and dispose',
    async () => {
      const report = await runContract((port) => port)
      expect(report.assertions.map((item) => [item.scenario, item.status])).toEqual(
        SCENARIOS.map((scenario) => [scenario, 'passed']),
      )
      expect(report.status).toBe('passed')
      expect(report.failures).toEqual([])
    },
    CONTRACT_TIMEOUT_MS,
  )

  it(
    'fails exactly the scenario whose observation leaks a resync',
    async () => {
      const report = await runContract((port) => ({
        ...port,
        deny: async (context) => {
          const seen = await port.deny(context)
          return { ...seen, refusals: seen.refusals.map((code) => (code === 'resync_required' ? '' : code)) }
        },
      }))
      expect(
        report.assertions.filter((item) => item.status === 'failed').map((item) => item.scenario),
      ).toEqual(['deny'])
    },
    CONTRACT_TIMEOUT_MS,
  )
})
