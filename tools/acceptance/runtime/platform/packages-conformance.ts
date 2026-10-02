import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { bindPackageContracts, claimedPackageProviders } from './packages.ts'

const SOURCE = 'agh.package-source'
const RESOLVER = 'agh.package-resolver'

function requested(contracts: readonly string[] | 'all', name: string): boolean {
  return contracts === 'all' || contracts.includes(name)
}

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  const source = requested(request.contracts, SOURCE)
  const resolver = requested(request.contracts, RESOLVER)
  if (!source && !resolver) return { contracts: [], providers: [] }
  const providers = claimedPackageProviders(request.providers, { source, resolver })
  if (providers.length > 0) {
    await bindPackageContracts(harness, request.command, request.providers, { source, resolver })
  }
  return {
    contracts: [...(source ? [SOURCE] : []), ...(resolver ? [RESOLVER] : [])],
    providers,
  }
}
