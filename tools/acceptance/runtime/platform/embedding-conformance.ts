import { embeddingProviderDigest } from '../../../../packages/ai/test/runtime/embedding-fixture.js'
import { embeddingProcessDriver } from '../../../../packages/ai/test/runtime/embedding-process.js'
import {
  type ConformanceHarness,
  contracts as publicContracts,
} from '../../../../packages/extension-api/testkit/index.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from '../build-identity.js'
import type { ConformanceBindRequest } from '../run-conformance.js'

export async function bindConformance(harness: ConformanceHarness, request: ConformanceBindRequest) {
  const contracts =
    request.contracts === 'all' || request.contracts.includes('agh.embedding') ? ['agh.embedding'] : []
  const providers = request.providers.filter((p) => p === 'default' || p === 'reference')
  if (!contracts.length) return { contracts, providers }
  const build = getConformanceBuildIdentity()
  for (const kind of providers as ('default' | 'reference')[])
    publicContracts.registerEmbeddingContract(harness, {
      providerId: kind,
      providerDigest: embeddingProviderDigest(kind),
      configDigest: canonicalJsonDigest({
        kind,
        fixture: 'restricted-effects',
        usage: 'public-usage-restricted-source',
      }),
      releaseSetDigest: build.buildDigest,
      build,
      command: request.command,
      driver: (scenario) => embeddingProcessDriver(kind, scenario),
    })
  return { contracts, providers }
}
