import { bindChannelContract } from '../../../../examples/runtime-reference/src/providers/channel-contract.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { withConformanceBuild } from '../build-identity.js'

const CONTRACT = 'agh.channel'
const REFERENCE = 'reference'

// Only the reference webhook channel binds here. A default provider joins once its owners and its client
// ingress exist; until then a default request stays without evidence. The runner has no teardown, so the
// reference stores live until the process exits.
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
  bindChannelContract(withConformanceBuild(harness), request.command, { providerId: REFERENCE })
  return { contracts: [CONTRACT], providers: [REFERENCE] }
}
