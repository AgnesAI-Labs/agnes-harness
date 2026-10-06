import { expect, it } from 'vitest'
import { runSupervisorContractScenario } from '../../../extension-api/testkit/runtime/contracts/supervisor.js'
import { SCENARIOS } from '../../../extension-api/testkit/runtime/evidence.js'
import { openSupervisorHostFixture } from './fixtures/supervisor-contract.js'

/** Scenarios whose real consumer has not landed yet. Each later PR removes its entry. */
const PENDING: Readonly<Record<string, string>> = {
  normal: 'supervisor_drive_consumer_unavailable',
  recover: 'supervisor_cold_state_consumer_unavailable',
}

for (const kind of ['default', 'reference'] as const)
  for (const scenario of SCENARIOS)
    it(`supervisor contract reference=${kind === 'reference'} scenario=${scenario}`, async () => {
      const run = runSupervisorContractScenario(scenario, () => openSupervisorHostFixture(kind))
      const pending = PENDING[scenario]
      if (pending) await expect(run).rejects.toThrow(pending)
      else expect((await run).providerDigest).toMatch(/^[a-f0-9]{64}$/)
    }, 30_000)
