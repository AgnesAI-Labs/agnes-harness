import { bindUIRegistryContract } from '../../../../examples/runtime-reference/src/providers/ui-registry.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'

const CONTRACT = 'agh.ui-registry'
const REFERENCE = 'reference'

// Only the reference registry binds here. The web client's registry joins once it offers the factory;
// until then a default request stays without evidence.
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
  await bindUIRegistryContract(harness, request.command, { providerId: REFERENCE })
  return { contracts: [CONTRACT], providers: [REFERENCE] }
}
