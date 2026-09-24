import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PackageBlocker, PackageContributionSummary } from '@agnes/protocol'
import { PackageError } from './errors.js'
import { inspectStaged } from './inspect.js'
import { canonical, capabilityHash, freezeData, snapshotHash } from './integrity.js'
import type { LockEntry, Lockfile } from './lockfile.js'
import { hashDirectory, packageDir, parseSource } from './sources.js'
import { previousPackageDir } from './store.js'
import { verifyWorkspace } from './workspace.js'

export type InstalledPackage = Readonly<{
  id: string
  entry: LockEntry
  directory: string | null
  capabilityHash: string
  trusted: boolean
  enabled: boolean
  contributions: readonly PackageContributionSummary[]
  blockers: readonly PackageBlocker[]
  verifiedRollbackTarget: Readonly<{
    version: string
    integrity: string
    capabilityHash: string
    treeIntegrity: string
    directory: string
    contributions: readonly PackageContributionSummary[]
  }> | null
}>
export type InstalledInventory = Readonly<{
  profile: string
  hash: string
  packages: readonly InstalledPackage[]
}>
export { capabilityHash } from './integrity.js'

/** Closed-schema blocker used for legacy packages that claimed the daemon-owned web row space. */
export const RESERVED_WEB_ROW_BLOCKER: PackageBlocker = Object.freeze({
  code: 'incompatible',
  references: ['reserved-row-id:web:'],
})
export const LEGACY_EXTENSION_BLOCKER: PackageBlocker = Object.freeze({
  code: 'incompatible',
  references: ['legacy-extension-format:agnes.plugins-required'],
})

export function isReservedRowIdPackageError(error: unknown): boolean {
  return (
    error instanceof PackageError &&
    error.legacyCode === 'E_EXT_LOAD' &&
    error.detail.reason === 'reserved-row-id'
  )
}

export function isRuntimePackageEligible(
  row: Pick<InstalledPackage, 'enabled' | 'trusted' | 'blockers'>,
): boolean {
  return row.enabled && row.trusted && row.blockers.length === 0
}

/** A candidate/rollback snapshot may be prepared before enable, but never for an untrusted/blocked row. */
export function isSnapshotPackageEligible(row: Pick<InstalledPackage, 'trusted' | 'blockers'>): boolean {
  return row.trusted && row.blockers.length === 0
}
/** Shared immutable-tree verification for installed inventory and runtime snapshots. */
export function verifyPackageDirectory(
  id: string,
  entry: LockEntry,
  directory: string,
  ceiling: readonly string[],
): { capabilityHash: string; blockers: readonly PackageBlocker[] } {
  const hash = capabilityHash(entry)
  if (
    entry.contributions === undefined ||
    entry.treeIntegrity === undefined ||
    !existsSync(directory) ||
    hashDirectory(directory, { exclude: [] }) !== entry.treeIntegrity
  )
    throw new PackageError('E_LOCK_MISMATCH', 'installed inventory tree differs from lock', {
      detail: { id },
    })
  const source = parseSource(entry.source.ref)
  let checked: ReturnType<typeof inspectStaged>
  try {
    checked = inspectStaged({
      dir: directory,
      source,
      fetched: {
        dir: directory,
        version: entry.version,
        integrity: entry.integrity,
        license: entry.license,
        dependencies: entry.dependencies,
        ...(entry.releasedAt ? { releasedAt: entry.releasedAt } : {}),
      },
      ceiling,
    })
  } catch (error) {
    if (isReservedRowIdPackageError(error))
      return { capabilityHash: hash, blockers: [RESERVED_WEB_ROW_BLOCKER] }
    if (error instanceof PackageError && error.detail.reason === 'legacy-extension-format')
      return { capabilityHash: hash, blockers: [LEGACY_EXTENSION_BLOCKER] }
    throw error
  }
  if (
    checked.preview.id !== id ||
    canonical(checked.preview.contributions) !== canonical(entry.contributions) ||
    canonical(checked.preview.dependencies) !== canonical(entry.dependencies)
  )
    throw new PackageError('E_LOCK_MISMATCH', 'installed inventory metadata differs from lock', {
      detail: { id },
    })
  return { capabilityHash: hash, blockers: checked.preview.blockers }
}
function verifiedRollbackTarget(
  id: string,
  entry: LockEntry,
  options: { dataDir: string; profile: string; ceiling: readonly string[] },
): InstalledPackage['verifiedRollbackTarget'] {
  if (entry.previous === null) return null
  const previous = entry.previous
  if (
    !previous.source ||
    !previous.treeIntegrity ||
    !previous.contributions ||
    !previous.dependencies ||
    !previous.state ||
    !previous.license ||
    !previous.trust
  )
    throw new PackageError('E_LOCK_MISMATCH', 'previous package snapshot is incomplete', {
      detail: { id, reason: 'previous-incomplete' },
    })
  const snapshot = { ...structuredClone(previous), previous: null } as LockEntry
  let verified: ReturnType<typeof verifyPackageDirectory>
  try {
    verified = verifyPackageDirectory(id, snapshot, previousPackageDir(options, id), options.ceiling)
  } catch (error) {
    if (isReservedRowIdPackageError(error)) return null
    throw error
  }
  if (
    snapshot.state.trusted !== null &&
    (snapshot.trustDecision?.integrity !== snapshot.integrity ||
      snapshot.trustDecision.capabilityHash !== verified.capabilityHash)
  )
    throw new PackageError('E_WORKSPACE_UNTRUSTED', 'previous package trust snapshot differs from lock', {
      detail: { id },
    })
  return freezeData({
    version: snapshot.version,
    integrity: snapshot.integrity,
    capabilityHash: verified.capabilityHash,
    treeIntegrity: snapshot.treeIntegrity as string,
    directory: previousPackageDir(options, id),
    contributions: snapshot.contributions ?? [],
  })
}
/** Reads and verifies installed bytes; it never fetches, imports modules, or mutates the store. */
export function readInventory(
  lock: Lockfile,
  options: {
    dataDir: string
    profileDir: string
    ceiling?: readonly string[]
    builtinDirectory?: (id: string) => string | undefined
  },
): InstalledInventory {
  const packages: InstalledPackage[] = [],
    paths = new Set<string>()
  for (const [id, entry] of Object.entries(lock.packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let directory: string | null = packageDir(options.dataDir, lock.profile, id)
    if (paths.has(directory)) throw new PackageError('E_LOCK_MISMATCH', 'package store path collision')
    paths.add(directory)
    if (entry.trust === 'builtin') directory = options.builtinDirectory?.(id) ?? null
    if (entry.source.type === 'workspace') {
      parseSource(entry.source.ref)
      const workspace = verifyWorkspace(lock, options.profileDir)
      if (!workspace.ok) throw new PackageError('E_LOCK_MISMATCH', 'workspace inventory is not trusted')
      directory = resolve(workspace.deployDir, entry.source.ref.slice('workspace:'.length))
    }
    const blockers: PackageBlocker[] = []
    let hash = capabilityHash(entry)
    if (entry.contributions === undefined || entry.treeIntegrity === undefined)
      blockers.push({ code: 'unknown-contribution', references: ['static-inventory-migration-required'] })
    else {
      if (directory === null)
        throw new PackageError('E_LOCK_MISMATCH', 'installed inventory tree differs from lock', {
          detail: { id },
        })
      const verified = verifyPackageDirectory(
        id,
        entry,
        directory,
        options.ceiling ?? lock.policySnapshot.capabilityCeiling,
      )
      hash = verified.capabilityHash
      blockers.push(
        ...verified.blockers.filter(
          (b) => !(entry.source.type === 'workspace' && b.references.includes('use-trust-workspace')),
        ),
      )
    }
    const trusted =
      entry.trust === 'builtin' ||
      (entry.state.trusted !== null &&
        entry.trustDecision?.integrity === entry.integrity &&
        entry.trustDecision.capabilityHash === hash)
    if (entry.state.trusted !== null && entry.contributions !== undefined && !trusted)
      throw new PackageError('E_WORKSPACE_UNTRUSTED', 'installed trust snapshot differs from lock', {
        detail: { id },
      })
    packages.push({
      id,
      entry,
      directory,
      capabilityHash: hash,
      trusted,
      enabled: entry.state.enabled,
      contributions: entry.contributions ?? [],
      blockers,
      verifiedRollbackTarget: verifiedRollbackTarget(id, entry, {
        dataDir: options.dataDir,
        profile: lock.profile,
        ceiling: options.ceiling ?? lock.policySnapshot.capabilityCeiling,
      }),
    })
  }
  // Store paths and derived manifest data stay out of the hash so it only changes with the lock.
  const stable = stableInventoryRows(packages)
  // Clone before freezing so callers cannot mutate the original lock through the snapshot.
  return freezeData(
    JSON.parse(
      JSON.stringify({ profile: lock.profile, hash: `sha256-${snapshotHash(stable)}`, packages }),
    ) as InstalledInventory,
  )
}

/**
 * The row shape an inventory's `hash` is computed over: store paths and derived manifest data
 * excluded so it only changes with the lock. Every independent recomputation of this hash (e.g.
 * deployment resolution re-verifying `inventory.hash`) must narrow rows through this function
 * instead of re-deriving the shape, or the two hashes silently diverge whenever a field is added
 * to `InstalledPackage`/`verifiedRollbackTarget` that isn't part of the lock-derived identity.
 */
export function stableInventoryRows(packages: readonly InstalledPackage[]): readonly (Omit<
  InstalledPackage,
  'directory' | 'verifiedRollbackTarget'
> & {
  verifiedRollbackTarget: Readonly<{
    version: string
    integrity: string
    capabilityHash: string
    treeIntegrity: string
  }> | null
})[] {
  return packages.map(({ directory: _directory, verifiedRollbackTarget: rollback, ...p }) => ({
    ...p,
    verifiedRollbackTarget: rollback && {
      version: rollback.version,
      integrity: rollback.integrity,
      capabilityHash: rollback.capabilityHash,
      treeIntegrity: rollback.treeIntegrity,
    },
  }))
}
