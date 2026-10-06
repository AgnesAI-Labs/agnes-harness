import { registerSupervisorContract } from '../../../packages/extension-api/testkit/runtime/contracts/supervisor.js'
import type { ConformanceHarness } from '../../../packages/extension-api/testkit/runtime/harness.js'
import { openSupervisorHostFixture } from '../../../packages/host/test/runtime/fixtures/supervisor-contract.js'
import { getConformanceBuildIdentity } from './build-identity.js'

/** Claims only agh.supervisor. Every case runs against real State and real identity-issued contexts through the public SPI. */
export async function bindConformance(
  harness: ConformanceHarness,
  request: { command: string; contracts: readonly string[] | 'all'; providers: readonly string[] },
) {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.supervisor'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter(
    (id): id is 'default' | 'reference' => id === 'default' || id === 'reference',
  )
  for (const providerId of providers)
    registerSupervisorContract(harness, {
      providerId,
      command: request.command,
      build: getConformanceBuildIdentity(),
      open: () => openSupervisorHostFixture(providerId),
    })
  return { contracts: ['agh.supervisor'], providers }
}
