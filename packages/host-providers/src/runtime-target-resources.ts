import {
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type ResourceGenerationInput,
  type RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import type {
  ResourceGeneration,
  ResourceGenerationCandidate,
  ResourceGenerationCandidateScope,
  ResourceGenerationCell,
} from './resource-generation-cell.js'

/**
 * The exact, canonical resource half of a RuntimeTarget handed to a Host-owned factory.
 *
 * This deliberately is still JSON. `@agnes/host` does not import the worker-only resource-control
 * bootstrap package, so this primitive must not invent an MCP or Skills conversion. The Host
 * assembly boundary supplies a factory that knows how to create its resource generation from this
 * verified snapshot; a later production integration owns that conversion and its policy.
 */
export type RuntimeTargetResourceFactoryInput = Readonly<{
  target: ResourceGenerationInput['target']
  resources: ResourceGenerationInput['resources']
  rows: ResourceGenerationInput['rows']
}>

export type RuntimeTargetResourceFactory<Resources> = Readonly<{
  create(
    input: RuntimeTargetResourceFactoryInput,
    scope: ResourceGenerationCandidateScope,
  ): Resources | Promise<Resources>
  health?(
    resources: Resources,
    input: RuntimeTargetResourceFactoryInput,
    scope: ResourceGenerationCandidateScope,
  ): void | Promise<void>
}>

export type RuntimeTargetResourceCandidate<Resources> = Readonly<{
  target: RuntimeTarget
  input: RuntimeTargetResourceFactoryInput
  /** Atomically consume this only inside the owning RuntimeState exchange. */
  consume(): ResourceGeneration<Resources>
  /** Idempotently clean an unpublished generation, including factory-registered cleanup. */
  abort(): Promise<void>
}>

function verifiedTarget(value: unknown): RuntimeTarget {
  // RuntimeTarget is a structural TypeScript type at this Host boundary. Its codec is the single
  // authority for rejecting raw/non-JSON inputs, missing fixed row slots and identity mismatches.
  return decodeRuntimeTargetArtifact(encodeRuntimeTargetArtifact(value as RuntimeTarget))
}

function factoryInput(resource: ResourceGenerationInput): RuntimeTargetResourceFactoryInput {
  return Object.freeze({
    target: resource.target,
    resources: resource.resources,
    rows: resource.rows,
  })
}

/**
 * Stage a resource generation from the resource half of one complete RuntimeTarget.
 *
 * The supplied cell owns candidate one-shot enforcement and cleanup. This function neither reads
 * nor writes a current generation; publication remains the sole responsibility of RuntimeState.
 */
export async function stageRuntimeTargetResourceCandidate<Resources>(
  options: Readonly<{
    target: unknown
    cell: ResourceGenerationCell<Resources>
    factory: RuntimeTargetResourceFactory<Resources>
  }>,
): Promise<RuntimeTargetResourceCandidate<Resources>> {
  const target = verifiedTarget(options.target)
  const input = factoryInput(target.resource)
  const prepared = await options.cell.prepare(
    (scope) => options.factory.create(input, scope),
    (resources, scope) => options.factory.health?.(resources, input, scope),
  )
  let candidate: ResourceGenerationCandidate<Resources> | undefined = prepared
  let aborting: Promise<void> | undefined

  return Object.freeze({
    target,
    input,
    consume(): ResourceGeneration<Resources> {
      if (!candidate)
        throw new Error('E_RUNTIME_TARGET_RESOURCE_CANDIDATE_FINALIZED: candidate is no longer staged')
      const current = candidate
      candidate = undefined
      return options.cell.consumeCandidate(current)
    },
    abort(): Promise<void> {
      if (!candidate) return aborting ?? Promise.resolve()
      const current = candidate
      candidate = undefined
      aborting = options.cell.discardCandidate(current)
      return aborting
    },
  })
}
