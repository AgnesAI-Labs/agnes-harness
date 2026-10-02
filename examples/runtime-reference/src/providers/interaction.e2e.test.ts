import { createConformanceHarness, SCENARIOS } from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'
import type { InteractionContractPort } from '../../../../packages/extension-api/testkit/runtime/contracts/interaction.js'
import { INTERACTION_PROVIDER } from './interaction.js'
import { bindInteractionContract } from './interaction-contract.js'

// Recover kills real provider processes with SIGKILL, so every run of the contract is heavy.
// Each run starts two provider processes; the default timeout leaves too little room on slow hosts.
const CONTRACT_TIMEOUT_MS = 30_000

describe('reference interaction: conformance', () => {
  async function runContract(change: (port: InteractionContractPort) => InteractionContractPort) {
    const harness = createConformanceHarness()
    const bound = bindInteractionContract(harness, 'reference-interaction-conformance', { change })
    try {
      return await harness.run({
        contracts: ['agh.interaction'],
        providers: [INTERACTION_PROVIDER.id],
        command: 'reference-interaction-conformance',
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
    'fails a scenario whose observations break the contract',
    async () => {
      const report = await runContract((port) => ({
        ...port,
        normal: async (context) => ({ ...(await port.normal(context)), woken: 2 }),
      }))
      expect(
        report.assertions.filter((item) => item.status === 'failed').map((item) => item.scenario),
      ).toEqual(['normal'])
      expect(report.status).toBe('failed')
    },
    CONTRACT_TIMEOUT_MS,
  )
})
