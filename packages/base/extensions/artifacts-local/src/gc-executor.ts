import { join } from 'node:path'
import {
  type ArtifactGcExecutionLease,
  type ArtifactGcExecutionPermit,
  type ArtifactGcExecutionResult,
  type ArtifactGcPhysicalDelete,
  authorizeLinuxArtifactGcExecution,
  authorizeMacOSArtifactGcExecution,
  authorizeWindowsArtifactGcExecution,
  executeArtifactGc as executeCoreArtifactGc,
} from '@agnes/core/artifacts'
import { deletePrivateArtifactSync } from '@agnes/system-node'

export type {
  ArtifactGcExecutionLease,
  ArtifactGcExecutionPermit,
  ArtifactGcExecutionResult,
  ArtifactGcPhysicalDelete,
}
export {
  authorizeLinuxArtifactGcExecution,
  authorizeMacOSArtifactGcExecution,
  authorizeWindowsArtifactGcExecution,
}

export function executeArtifactGc(
  prerequisite: ArtifactGcExecutionPermit,
  lease: ArtifactGcExecutionLease,
  physicalDelete: ArtifactGcPhysicalDelete = deletePrivateArtifactSync,
): Promise<ArtifactGcExecutionResult> {
  return executeCoreArtifactGc(prerequisite, lease, physicalDelete, (dataDir) =>
    join(dataDir, 'artifacts', 'sha256'),
  )
}
