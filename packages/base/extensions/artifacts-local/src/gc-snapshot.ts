import {
  type ArtifactGcFiveSourceSnapshot,
  type ArtifactGcRootOwner,
  type ArtifactGcRootOwnerSnapshot,
  collectArtifactGcFiveSourceSnapshot as collectCoreSnapshot,
} from '@agnes/core/artifacts'
import { nodeArtifactGcPreparationRuntime } from '@agnes/system-node'

export type { ArtifactGcFiveSourceSnapshot, ArtifactGcRootOwner, ArtifactGcRootOwnerSnapshot }

export function collectArtifactGcFiveSourceSnapshot(
  owners: readonly ArtifactGcRootOwner[],
): Promise<ArtifactGcFiveSourceSnapshot> {
  return collectCoreSnapshot(owners, nodeArtifactGcPreparationRuntime.sha256Utf8)
}
