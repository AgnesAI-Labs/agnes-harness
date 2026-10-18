import type { PackageContributionSummary, PluginCapabilities, PluginMetadata } from '@agnes/protocol'
import type { InventoryVerificationCache } from './inventory.js'
import type { LockEntry } from './lockfile.js'
import type { PackageStore } from './store.js'

export type RuntimePinPurpose = 'active' | 'candidate' | 'recovery' | 'rollback' | 'turn'

export type RuntimeSnapshotSelector =
  | Readonly<{ kind: 'installed'; expectedIntegrity: string; expectedTreeIntegrity: string }>
  | Readonly<{ kind: 'previous'; expectedIntegrity: string; expectedTreeIntegrity: string }>
  | Readonly<{
      kind: 'snapshot'
      snapshotId: string
      expectedIntegrity: string
      expectedTreeIntegrity: string
    }>

export type RuntimeSnapshot = Readonly<{
  snapshotId: string
  profile: string
  packageId: string
  version: string
  integrity: string
  treeIntegrity: string
  capabilityHash: string
  directory: string
  agents?: NonNullable<LockEntry['agents']>
  application?: NonNullable<LockEntry['application']>
  metadata?: PluginMetadata
  contributions: readonly PackageContributionSummary[]
  /** Sealed with capabilityHash at trust or development load. Pins leave these unset. */
  dependencies?: Readonly<Record<string, string>>
  declaredCapabilities?: PluginCapabilities
}>

export type RuntimePin = Readonly<{
  pinId: string
  operationId: string
  purpose: RuntimePinPurpose
  snapshot: RuntimeSnapshot
}>

export type RuntimeSnapshotPinRequest = Readonly<{
  pinId: string
  operationId: string
  packageId: string
  purpose: RuntimePinPurpose
  selector: RuntimeSnapshotSelector
}>

export type RuntimeSnapshotCollection = Readonly<{
  removed: readonly string[]
  retained: readonly string[]
}>

export type RuntimeSnapshotStore = PackageStore & {
  /** Read-only inspection reuse after full tree verification; mutation paths leave this unset. */
  verificationCache?: InventoryVerificationCache
}

export type SnapshotRecord = {
  /** Missing/1 retains the original identity; 2 includes the record format in its identity.
   * Early builds with agents/application also wrote 1 and remain readable. */
  version?: 1 | 2
  snapshotId: string
  packageId: string
  packageVersion: string
  integrity: string
  treeIntegrity: string
  capabilityHash: string
  source: LockEntry['source']
  license: string
  releasedAt: string | null
  dependencies: Record<string, string>
  agents?: NonNullable<LockEntry['agents']>
  application?: NonNullable<LockEntry['application']>
  metadata?: PluginMetadata
  contributions: PackageContributionSummary[]
  declaredCapabilities?: NonNullable<LockEntry['declaredCapabilities']>
}
export type PinRecord = {
  pinId: string
  operationId: string
  purpose: RuntimePinPurpose
  packageId: string
  snapshotId: string
  requestHash: string
}
export type RuntimeState = {
  version: 1
  snapshots: Record<string, SnapshotRecord>
  pins: Record<string, PinRecord>
}
export type CreateJournal = {
  version: 1
  kind: 'create'
  transactionId: string
  stage: string
  snapshot: SnapshotRecord
  pin: PinRecord
}
export type GcJournal = {
  version: 1
  kind: 'gc'
  transactionId: string
  trash: string
  snapshot: SnapshotRecord
}
export type RuntimeJournal = CreateJournal | GcJournal
