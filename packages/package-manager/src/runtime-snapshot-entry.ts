import { PackageError } from './errors.js'
import { capabilityHash, snapshotHash } from './integrity.js'
import type { LockEntry } from './lockfile.js'
import type { SnapshotRecord } from './runtime-snapshot-types.js'

export function runtimeSnapshotId(value: {
  packageId: string
  version: string
  integrity: string
  treeIntegrity: string
  capabilityHash: string
  recordVersion: 2
}): string {
  return `sha256-${snapshotHash(value)}`
}

export function contributionCeiling(record: SnapshotRecord): string[] {
  return [
    ...new Set(
      record.contributions.flatMap((c) => (c.kind === 'extension' ? Object.keys(c.capabilities ?? {}) : [])),
    ),
  ]
}
export function recordEntry(record: SnapshotRecord): LockEntry {
  return {
    version: record.packageVersion,
    source: structuredClone(record.source),
    integrity: record.integrity,
    trust: 'trusted',
    license: record.license,
    state: { installed: new Date(0).toISOString(), trusted: null, enabled: false },
    dependencies: structuredClone(record.dependencies),
    previous: null,
    contributions: structuredClone(record.contributions),
    ...(record.metadata ? { metadata: structuredClone(record.metadata) } : {}),
    ...(record.agents ? { agents: structuredClone(record.agents) } : {}),
    ...(record.application ? { application: structuredClone(record.application) } : {}),
    ...(record.declaredCapabilities === undefined
      ? {}
      : { declaredCapabilities: structuredClone(record.declaredCapabilities) }),
    treeIntegrity: record.treeIntegrity,
    ...(record.releasedAt ? { releasedAt: record.releasedAt } : {}),
  } as LockEntry
}

export function recordFromEntry(packageId: string, entry: LockEntry): SnapshotRecord {
  if (!entry.treeIntegrity || !entry.contributions)
    throw new PackageError('E_LOCK_MISMATCH', 'runtime snapshot store requires recovery', {
      detail: { reason: 'snapshot-migration-required' },
    })
  const hash = capabilityHash(entry)
  return {
    version: 2,
    snapshotId: runtimeSnapshotId({
      packageId,
      version: entry.version,
      integrity: entry.integrity,
      treeIntegrity: entry.treeIntegrity,
      capabilityHash: hash,
      recordVersion: 2,
    }),
    packageId,
    packageVersion: entry.version,
    integrity: entry.integrity,
    treeIntegrity: entry.treeIntegrity,
    capabilityHash: hash,
    source: structuredClone(entry.source),
    license: entry.license,
    releasedAt: entry.releasedAt ?? null,
    dependencies: structuredClone(entry.dependencies),
    contributions: structuredClone(entry.contributions),
    ...(entry.metadata ? { metadata: structuredClone(entry.metadata) } : {}),
    ...(entry.agents ? { agents: structuredClone(entry.agents) } : {}),
    ...(entry.application ? { application: structuredClone(entry.application) } : {}),
    ...(entry.declaredCapabilities === undefined
      ? {}
      : { declaredCapabilities: structuredClone(entry.declaredCapabilities) }),
  }
}
