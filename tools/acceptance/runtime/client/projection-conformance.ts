import { bindProjectionContract } from '../../../../examples/runtime-reference/src/providers/projection-contract.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { withConformanceBuild } from '../build-identity.js'

const CONTRACT = 'agh.projection'
const REFERENCE = 'reference'

// Only the reference store binds here. The default provider's six cases run in the core recovery
// test over a labelled test database until it is composed with the Host storage; a default request
// stays without evidence. The runner has no teardown, so the database lives until the process exits.
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
  bindProjectionContract(withConformanceBuild(harness), request.command, { providerId: REFERENCE })
  return { contracts: [CONTRACT], providers: [REFERENCE] }
}
