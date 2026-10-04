import { bindEventsContract } from '../../../../examples/runtime-reference/src/providers/events-contract.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { withConformanceBuild } from '../build-identity.js'

const CONTRACT = 'agh.events'
const REFERENCE = 'reference'

// Only the reference store binds here. Product code has no agh.events provider yet: the daemon domain
// store keeps a dispatch outbox but serves neither subscribe nor publish, so a default request stays
// without evidence. The runner has no teardown, so the database lives until the process exits.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes(CONTRACT))
    return { contracts: [], providers: [] }
  if (!request.providers.includes(REFERENCE)) return { contracts: [CONTRACT], providers: [] }
  bindEventsContract(withConformanceBuild(harness), request.command, { providerId: REFERENCE })
  return { contracts: [CONTRACT], providers: [REFERENCE] }
}
