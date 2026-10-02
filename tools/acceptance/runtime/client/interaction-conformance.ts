import { bindInteractionContract } from '../../../../examples/runtime-reference/src/providers/interaction-contract.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'

const CONTRACT = 'agh.interaction'
const REFERENCE = 'reference'

// Only the reference store binds here. The default provider shares the State transaction and
// joins once that composition exists; until then a default request stays without evidence.
// The runner has no teardown, so the reference database lives until the process exits.
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
  bindInteractionContract(harness, request.command, { providerId: REFERENCE })
  return { contracts: [CONTRACT], providers: [REFERENCE] }
}
