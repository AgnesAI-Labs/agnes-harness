import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type { CompositeTargetStore } from './storage/composite-target-store.js'

export type ProbedRuntimeTargetPublish = Readonly<{
  store: CompositeTargetStore
  artifact: RuntimeTargetArtifact
  pins?: readonly string[]
  probe(artifact: RuntimeTargetArtifact): Promise<void>
}>

/**
 * Probe the already-encoded artifact, then persist that same payload. The target is never rebuilt
 * after probe.
 */
export async function publishProbedRuntimeTarget(options: ProbedRuntimeTargetPublish): Promise<void> {
  const artifact = Object.freeze({
    encoding: 'base64' as const,
    canonicalBase64: options.artifact.canonicalBase64,
    digest: options.artifact.digest,
    identity: Object.freeze({ ...options.artifact.identity }),
  })
  decodeRuntimeTargetArtifact(artifact)
  for (const pin of options.pins ?? []) options.store.pin(pin)
  await options.probe(artifact)
  const remaining = new Set(options.store.pins())
  for (const pin of options.pins ?? []) {
    if (!remaining.has(pin)) throw new Error(`E_RUNTIME_TARGET_PIN: pin ${pin} missing after probe`)
  }
  options.store.publishDesired(artifact)
  options.store.sweepPins()
}
