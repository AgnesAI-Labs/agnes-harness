import type { AuthorizedPorts, LegacyContributionInput } from '@agnes/plugin-runtime/host'
import type { AssemblyGraph, CommunityContractDefinition } from '@agnes/protocol/runtime'
import { candidateLifecycle } from '../../../src/runtime/assembly/candidate.js'
import {
  createHostScopedDependencies,
  type HostSelectedProvider,
} from '../../../src/runtime/scoped-dependencies.js'

/** Test-only initialization ports, not implementations of the 52 business service contracts. */
export async function memoryAssemblyLifecycle(
  input: {
    graph: AssemblyGraph
    plan: {
      targetReleaseSet: {
        releaseSetId: string
        schemasRef: { value: { contracts: readonly CommunityContractDefinition[] } }
      }
    }
  },
  options: {
    pause?: boolean
    failReady?: boolean
    failRelease?: boolean
    contributions?: readonly LegacyContributionInput[]
  } = {},
) {
  const root = createHostScopedDependencies([])
  const released: string[] = [],
    mounted: string[] = [],
    readied: string[] = []
  let begin = () => {}
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  let waiting = false
  const providers: HostSelectedProvider[] = input.graph.bindings.map(({ binding, descriptor }) => ({
    binding,
    major: descriptor.major,
    scope: descriptor.scope,
    features: descriptor.features,
    packageDigest: descriptor.packageDigest,
    ownerId: binding.providerId,
    permissions: [],
    capabilities: descriptor.capabilities.map((capability) => capability.capability),
    requires: descriptor.requires.map((requirement) => ({ ...requirement, capture: 'instance' as const })),
    ...('contractDefinition' in descriptor ? { contractDefinition: descriptor.contractDefinition } : {}),
    operations: descriptor.operations,
    create(ports: AuthorizedPorts) {
      mounted.push(`${ports.generationId}/${ports.providerId}`)
    },
    async ready(ports: AuthorizedPorts) {
      if (!waiting) {
        waiting = true
        begin()
        if (options.pause)
          await new Promise<void>((resolve) => {
            if (ports.signal?.aborted) resolve()
            else ports.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        if (options.failReady) throw new Error('synthetic ready failure')
      }
      readied.push(ports.providerId)
    },
    owners: [
      {
        id: binding.providerId,
        release() {
          released.push(binding.providerId)
          if (options.failRelease) throw new Error('synthetic owner release failure')
        },
      },
    ],
  }))
  await root.publish({
    generationId: 'fixture-current',
    providers: [
      {
        binding: {
          bindingId: 'fixture-current-binding',
          contract: 'agh.fixture-current',
          logicalName: 'default',
          providerId: 'fixture-current',
        },
        major: 1,
        scope: 'runtime',
        features: [],
        packageDigest: 'a'.repeat(64),
        ownerId: 'fixture-current',
        permissions: [],
      },
    ],
  })
  const publication = {
    generationId: `candidate:${input.plan.targetReleaseSet.releaseSetId}`,
    providers,
    contracts: input.plan.targetReleaseSet.schemasRef.value.contracts,
    contributions: options.contributions ?? [],
  }
  const lifecycle = candidateLifecycle(root, publication)
  return {
    lifecycle,
    root,
    publication,
    released,
    mounted,
    readied,
    started,
    async cleanup() {
      await lifecycle.close()
      await root.close('fixture-current')
    },
  }
}
