import type { LockEntry, Lockfile } from './lockfile.js'

/** Read-only input/output contracts; no dependency on the Host resolver. */
export type LockState = {
  packages: Record<
    string,
    {
      version: string
      integrity: string
      trust: LockEntry['trust']
      enabled: boolean
      provides?: NonNullable<LockEntry['provides']>
      capabilities?: unknown
      releasedAt?: string
    }
  >
  workspace?: { path: string; hash: string; manifestId: string }
}
export type PolicySnapshotInput = {
  policy: Lockfile['policySnapshot']
  hash: string
  seams: Lockfile['seams']
  provider: Lockfile['provider']
}
