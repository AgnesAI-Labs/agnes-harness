import {
  type ArtifactGcExecutionPrerequisite,
  type ArtifactGcReachabilitySnapshotIdentity,
  isPreparedArtifactGcExecutionPrerequisite,
} from './gc-execution-prerequisite.js'

const AUTHORIZED_PERMITS = new WeakSet<object>()

export type ArtifactGcExecutionResult = Readonly<{
  planHash: string
  deleted: readonly Readonly<{ sha256: string; bytes: number }>[]
}>

export type ArtifactGcExecutionPermit = Readonly<{
  mode: 'physical-delete'
  blocked: false
  authority: 'windows-private-handle-v1' | 'macos-openat-unlinkat-v1' | 'linux-openat-unlinkat-v1'
  planHash: string
  dataDir: string
  reachabilitySnapshot: ArtifactGcReachabilitySnapshotIdentity
  candidates: ArtifactGcExecutionPrerequisite['candidates']
}>

export type ArtifactGcExecutionLease = Readonly<{
  /** Hold the global roots/deletion lock and reject a stale five-source rescan before `run`. */
  withCurrentSnapshot<T>(snapshot: ArtifactGcReachabilitySnapshotIdentity, run: () => Promise<T>): Promise<T>
}>

export type ArtifactGcPhysicalDelete = (storeRoot: string, relativePath: string, sha256: string) => number

function authorize(
  prerequisite: ArtifactGcExecutionPrerequisite,
  authority: ArtifactGcExecutionPermit['authority'],
): ArtifactGcExecutionPermit {
  if (!isPreparedArtifactGcExecutionPrerequisite(prerequisite))
    throw new Error('artifact GC prerequisite is invalid')
  const permit = Object.freeze({
    mode: 'physical-delete' as const,
    blocked: false as const,
    authority,
    planHash: prerequisite.planHash,
    dataDir: prerequisite.dataDir,
    reachabilitySnapshot: prerequisite.reachabilitySnapshot,
    candidates: prerequisite.candidates,
  })
  AUTHORIZED_PERMITS.add(permit)
  return permit
}

/** Promotes a dry-run attestation only when the native same-handle Windows primitive is available. */
export function authorizeWindowsArtifactGcExecution(
  prerequisite: ArtifactGcExecutionPrerequisite,
  capabilityAvailable = false,
): ArtifactGcExecutionPermit {
  if (!capabilityAvailable) throw new Error('artifact GC physical delete capability is unavailable')
  return authorize(prerequisite, 'windows-private-handle-v1')
}

/** Promotes the same attestation for the macOS openat/unlinkat native capability. */
export function authorizeMacOSArtifactGcExecution(
  prerequisite: ArtifactGcExecutionPrerequisite,
  capabilityAvailable = false,
): ArtifactGcExecutionPermit {
  if (!capabilityAvailable) throw new Error('artifact GC physical delete capability is unavailable')
  return authorize(prerequisite, 'macos-openat-unlinkat-v1')
}

/** Promotes the same attestation for Linux openat/unlinkat with AF_ALG digest verification. */
export function authorizeLinuxArtifactGcExecution(
  prerequisite: ArtifactGcExecutionPrerequisite,
  capabilityAvailable = false,
): ArtifactGcExecutionPermit {
  if (!capabilityAvailable) throw new Error('artifact GC physical delete capability is unavailable')
  return authorize(prerequisite, 'linux-openat-unlinkat-v1')
}

function relativeArtifactPath(value: string, sha256: string): string {
  const expected = `artifacts/sha256/${sha256.slice(0, 2)}/${sha256}`
  if (value !== expected) throw new Error('artifact GC candidate path identity changed')
  return `${sha256.slice(0, 2)}/${sha256}`
}

/**
 * Executes a previously attested plan only while the root owner holds its exclusive lease. The
 * default platform primitive hashes the opened file, revalidates the parent entry, and deletes it
 * through the same trusted parent handle.
 */
export async function executeArtifactGc(
  prerequisite: ArtifactGcExecutionPermit,
  lease: ArtifactGcExecutionLease,
  physicalDelete: ArtifactGcPhysicalDelete,
  storeRootForDataDir: (dataDir: string) => string,
): Promise<ArtifactGcExecutionResult> {
  if (!AUTHORIZED_PERMITS.has(prerequisite)) throw new Error('artifact GC prerequisite is invalid')
  return lease.withCurrentSnapshot(prerequisite.reachabilitySnapshot, async () => {
    const storeRoot = storeRootForDataDir(prerequisite.dataDir)
    if (typeof storeRoot !== 'string' || !storeRoot) throw new Error('artifact GC store root is invalid')
    const deleted: Array<Readonly<{ sha256: string; bytes: number }>> = []
    for (const candidate of prerequisite.candidates) {
      const relativePath = relativeArtifactPath(candidate.rootRelativePath, candidate.sha256)
      const bytes = physicalDelete(storeRoot, relativePath, candidate.sha256)
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error('artifact GC physical delete returned an invalid byte count')
      deleted.push(Object.freeze({ sha256: candidate.sha256, bytes }))
    }
    return Object.freeze({ planHash: prerequisite.planHash, deleted: Object.freeze(deleted) })
  })
}
