import {
  decodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact as HostRuntimeTargetArtifact,
  type RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import { type RuntimeTargetArtifact, validateRuntimeStaleFrame } from '@agnes/protocol'

export type VerifiedRuntimeTargetDelivery = Readonly<{
  artifact: HostRuntimeTargetArtifact
  target: RuntimeTarget
}>

function immutableArtifact(value: RuntimeTargetArtifact): HostRuntimeTargetArtifact {
  return Object.freeze({
    encoding: 'base64',
    canonicalBase64: value.canonicalBase64,
    digest: value.digest,
    identity: Object.freeze({ ...value.identity }),
  })
}

/**
 * Worker-side adapter for Task 8's sole live delivery shape. It validates the closed wire envelope,
 * verifies the exact canonical bytes through plugin-runtime's one codec, and snapshots the artifact
 * so a caller cannot mutate the value that Task 9's latest-wins slot will retain.
 */
export function adaptRuntimeStaleFrame(value: unknown): VerifiedRuntimeTargetDelivery {
  const checked = validateRuntimeStaleFrame(value)
  if (!checked.ok)
    throw Object.assign(new Error('E_RUNTIME_STALE_FRAME: invalid runtime.stale frame'), {
      code: 'E_RUNTIME_STALE_FRAME' as const,
      errors: checked.errors,
    })
  const artifact = immutableArtifact(checked.value.artifact)
  return Object.freeze({ artifact, target: decodeRuntimeTargetArtifact(artifact) })
}
