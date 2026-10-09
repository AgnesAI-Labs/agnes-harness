export {
  type ArtifactGcExecutionPrerequisite,
  type ArtifactGcHostCandidate,
  type ArtifactGcPreparationRuntime,
  type ArtifactGcReachabilitySnapshotIdentity,
  isPreparedArtifactGcExecutionPrerequisite,
  prepareArtifactGcExecutionPrerequisite,
} from './gc-execution-prerequisite.js'
export {
  type ArtifactGcExecutionLease,
  type ArtifactGcExecutionPermit,
  type ArtifactGcExecutionResult,
  type ArtifactGcPhysicalDelete,
  authorizeLinuxArtifactGcExecution,
  authorizeMacOSArtifactGcExecution,
  authorizeWindowsArtifactGcExecution,
  executeArtifactGc,
} from './gc-executor.js'
export { type ArtifactGcScheduler, createArtifactGcScheduler } from './gc-scheduler.js'
export {
  type ArtifactGcFiveSourceSnapshot,
  type ArtifactGcRootOwner,
  type ArtifactGcRootOwnerSnapshot,
  collectArtifactGcFiveSourceSnapshot,
} from './gc-snapshot.js'
export {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactGcPlan,
  type ArtifactPlanEntry,
  type ArtifactReachabilityInput,
  type ArtifactRoot,
  type ArtifactRootSnapshot,
  type ArtifactRootSource,
  artifactStorePath,
  planArtifactGc,
  type StoredArtifactCandidate,
} from './reachability.js'
export {
  type ArtifactRetentionGcPlan,
  planRetainedArtifactGc,
  type RetainedArtifactCandidate,
} from './retention-selector.js'
