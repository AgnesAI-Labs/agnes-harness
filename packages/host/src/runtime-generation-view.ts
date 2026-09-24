import type { RuntimePromptPreloader } from '@agnes/core'
import {
  type CurrentSessionRuntime,
  type HookPort,
  prepareOwnerReplacement,
  ResourceRegistry,
  ToolRegistry,
} from '@agnes/core'

export type GenerationRegistries = Readonly<{
  tools: ToolRegistry
  resources: ResourceRegistry
}>

export type GenerationRegistrySeed = Readonly<{
  tools: ToolRegistry
  resources: ResourceRegistry
}>

function copyRegistries(seed: GenerationRegistrySeed, owner?: string): GenerationRegistries {
  const tools = new ToolRegistry()
  for (const definition of seed.tools.list()) {
    const registered = seed.tools.resolve(definition.name)
    if (!registered || (owner && registered.source.source !== owner)) continue
    tools.add(definition, {
      source: registered.source.source,
      trust: registered.source.trust,
      ...(registered.packageIdentity === undefined ? {} : { packageIdentity: registered.packageIdentity }),
      ...(registered.packageVersion === undefined ? {} : { packageVersion: registered.packageVersion }),
      executionDomain: registered.executionDomain,
    })
  }
  const resources = new ResourceRegistry()
  for (const registered of seed.resources.snapshot()) {
    if (owner && registered.meta.source !== owner) continue
    resources.register(registered.entry, registered.meta)
  }
  return { tools, resources }
}

/** Replaces an owner in place so bound sessions never retain revoked tool wrappers. */
export function prepareGenerationOwnerReplacement(
  generation: GenerationRegistries,
  owner: string,
  seed: GenerationRegistrySeed,
) {
  const { tools, resources } = copyRegistries(seed, owner)
  return prepareOwnerReplacement(owner, [
    () => generation.tools.prepareOwnerReplacement(owner, tools),
    () => generation.resources.prepareOwnerReplacement(owner, resources),
  ])
}

/**
 * One pair of registries per published Core-registry revision — not the Kernel shared tables.
 *
 * `compositeRevision` is the durable identity of the complete target and may change for a
 * registry-neutral update (for example a web-only row).  It must therefore never be the cache key
 * for a session's Core view.
 */
export function generationRegistries(
  cache: Map<string, GenerationRegistries>,
  runtimeRegistryRevision: string,
  seed?: GenerationRegistrySeed,
): GenerationRegistries {
  const existing = cache.get(runtimeRegistryRevision)
  if (existing) return existing
  // A published generation snapshots attested registrations instead of sharing Kernel's tables.
  const { tools, resources } = seed
    ? copyRegistries(seed)
    : { tools: new ToolRegistry(), resources: new ResourceRegistry() }
  const created = Object.freeze({ tools, resources })
  cache.set(runtimeRegistryRevision, created)
  return created
}

export function publishedSessionRuntime(
  input: Readonly<{
    /** New key: only changes that alter Core registries create a new generation. */
    runtimeRegistryRevision?: string
    /** @deprecated Compatibility for callers that have not yet supplied the split revision. */
    compositeRevision?: string
    cache: Map<string, GenerationRegistries>
    hooks: HookPort
    seed?: GenerationRegistrySeed
    runtimePromptPreloader?: RuntimePromptPreloader
  }>,
): CurrentSessionRuntime {
  const revision = input.runtimeRegistryRevision ?? input.compositeRevision ?? 'unspecified'
  const registries = generationRegistries(input.cache, revision, input.seed)
  return Object.freeze({
    tools: registries.tools,
    hooks: input.hooks,
    resources: registries.resources,
    ...(input.runtimePromptPreloader ? { runtimePromptPreloader: input.runtimePromptPreloader } : {}),
  })
}
