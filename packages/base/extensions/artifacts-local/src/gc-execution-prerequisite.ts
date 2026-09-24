import {
  type ArtifactGcExecutionPrerequisite,
  type ArtifactGcHostCandidate,
  type ArtifactGcPreparationRuntime,
  type ArtifactGcReachabilitySnapshotIdentity,
  isPreparedArtifactGcExecutionPrerequisite,
  prepareArtifactGcExecutionPrerequisite as prepareCorePrerequisite,
} from '@agnes/core/artifacts'
import { nodeArtifactGcPreparationRuntime } from '@agnes/system-node'

export type {
  ArtifactGcExecutionPrerequisite,
  ArtifactGcHostCandidate,
  ArtifactGcPreparationRuntime,
  ArtifactGcReachabilitySnapshotIdentity,
}
export { isPreparedArtifactGcExecutionPrerequisite }

export function prepareArtifactGcExecutionPrerequisite(
  input: Parameters<typeof prepareCorePrerequisite>[0],
): ArtifactGcExecutionPrerequisite {
  return prepareCorePrerequisite(input, nodeArtifactGcPreparationRuntime)
}
