import { bindArtifactsContract } from '../../../../examples/runtime-reference/src/providers/artifacts-contract.ts'
import { bindBlobContract } from '../../../../examples/runtime-reference/src/providers/blob-contract.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'

const BINDERS = { 'agh.blob': bindBlobContract, 'agh.artifacts': bindArtifactsContract } as const
const REFERENCE = 'reference'

// Only the reference stores bind here. The default blob and artifacts services run their six cases in
// the Host tests with test authorization and ticket keys until they are composed with production
// ones; a default request stays without evidence. The runner has no teardown, so the stores live
// until the process exits.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  const contracts = (Object.keys(BINDERS) as (keyof typeof BINDERS)[]).filter(
    (contract) => request.contracts === 'all' || request.contracts.includes(contract),
  )
  if (!contracts.length || !request.providers.includes(REFERENCE)) return { contracts, providers: [] }
  for (const contract of contracts) BINDERS[contract](harness, request.command, { providerId: REFERENCE })
  return { contracts, providers: [REFERENCE] }
}
