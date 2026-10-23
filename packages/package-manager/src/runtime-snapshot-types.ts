import type { PackageContributionSummary, PluginCapabilities, PluginMetadata } from '@agnes/protocol'
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

/**
 * The pin and snapshot bookkeeping alone, decoded and shape-checked but with no tree hashed. Enough to
 * decide whether anything needs releasing or collecting; the write that follows verifies under the lock.
 */
export type RuntimePinRecords = Readonly<{
  pins: readonly Readonly<{
    pinId: string
    purpose: RuntimePinPurpose
    packageId: string
    snapshotId: string
    integrity: string
    treeIntegrity: string
  }>[]
  snapshotIds: readonly string[]
}>

export type RuntimeSnapshotStore = PackageStore

export type SnapshotRecord = {
  /** The current envelope includes its format version in the snapshot identity. */
  version: 2
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
