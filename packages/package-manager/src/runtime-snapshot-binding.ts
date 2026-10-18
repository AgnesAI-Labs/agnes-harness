import { PackageError } from './errors.js'
import { canonical, capabilityHash } from './integrity.js'
import type { LockEntry } from './lockfile.js'
import type { SnapshotRecord } from './runtime-snapshot-types.js'

export function hasSnapshotTrust(entry: LockEntry, record: SnapshotRecord): boolean {
  return (
    entry.trust === 'builtin' ||
    (entry.state.trusted !== null &&
      entry.trustDecision?.integrity === entry.integrity &&
      entry.trustDecision.capabilityHash === record.capabilityHash)
  )
}

/** A retained record cannot borrow a current approval for a different execution source. */
export function assertCurrentBinding(record: SnapshotRecord, entry?: LockEntry): void {
  if (!entry || entry.integrity !== record.integrity) return
  if (
    entry.version !== record.packageVersion ||
    canonical(entry.source) !== canonical(record.source) ||
    entry.treeIntegrity !== record.treeIntegrity ||
    capabilityHash(entry) !== record.capabilityHash
  )
    throw new PackageError('E_LOCK_MISMATCH', 'runtime snapshot store requires recovery', {
      detail: { reason: 'snapshot-installed-binding' },
    })
}
