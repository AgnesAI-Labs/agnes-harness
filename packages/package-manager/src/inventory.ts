import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type PackageBlocker,
  type PackageContributionSummary,
  type PackagePresentation,
  validatePluginMetadata,
} from '@agnes/protocol'
import { collectRead, collectReadAsync } from './cooperative-read.js'
import { PackageError } from './errors.js'
import { inspectVerifiedTree } from './inspect.js'
import { canonical, capabilityHash, freezeData, readStaticJson, snapshotHash } from './integrity.js'
import type { LockEntry, Lockfile } from './lockfile.js'
import { readPackagePresentation } from './package-presentation.js'
import { capabilityPolicyBlockers, readPluginCapabilityPolicy } from './plugin-capabilities.js'
import type { AgnesPluginKind } from './plugin-manifest.js'
import {
  enforceSourceConfiguration,
  officialCatalogVerifier,
  readPackageSourceConfiguration,
  recordProvenance,
} from './provenance.js'
import { hashDirectory, packageDir, parseSource } from './sources.js'
import { previousPackageDir } from './store.js'
import { verifyWorkspace } from './workspace.js'

export type InstalledPackage = Readonly<{
  id: string
  localFailure?: string
  localReloadRequired?: boolean
  entry: LockEntry
  directory: string | null
  presentation?: PackagePresentation
  capabilityHash: string
  trusted: boolean
  enabled: boolean
  kinds?: readonly AgnesPluginKind[]
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

/** Identity/integrity reasons stay fatal: they mean the installed bytes are not what the lock recorded. */
const FATAL_INSPECTION_REASONS: ReadonlySet<string> = new Set([
  'source-identity',
  'adapter-metadata',
  'adapter-integrity',
  'excluded-directory',
])
/**
 * One classification for "this package's own contents are unusable": a PackageError raised by static
 * inspection (E_EXT_LOAD/E_API_RANGE with a reason) blocks that package row instead of the daemon.
 */
function packageShapeReason(error: unknown): string | undefined {
  if (!(error instanceof PackageError)) return undefined
  if (error.legacyCode !== 'E_EXT_LOAD' && error.legacyCode !== 'E_API_RANGE') return undefined
  const reason = error.detail.reason
  if (typeof reason !== 'string' || FATAL_INSPECTION_REASONS.has(reason)) return undefined
  return reason
}

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
/** Cached static inspection is keyed by freshly hashed bytes, the full lock entry and ceiling.
 * It never caches a tree's validity, trust decision, activation state or a failed inspection. */
type VerifiedPackageDirectory = {
  capabilityHash: string
  blockers: readonly PackageBlocker[]
  kinds?: readonly AgnesPluginKind[]
}
export type InventoryVerificationCache = Map<string, VerifiedPackageDirectory>

/** Shared immutable-tree verification for installed inventory and runtime snapshots. */
export function verifyPackageDirectory(
  id: string,
  entry: LockEntry,
  directory: string,
  ceiling: readonly string[],
  cache?: InventoryVerificationCache,
): VerifiedPackageDirectory {
  const hash = capabilityHash(entry)
  if (
    entry.contributions === undefined ||
    entry.treeIntegrity === undefined ||
    !existsSync(directory) ||
    !entry.treeIntegrity
  )
    throw new PackageError('E_LOCK_MISMATCH', 'installed inventory tree differs from lock', {
      detail: { id },
    })
  const treeIntegrity = hashDirectory(directory, { exclude: [] })
  if (treeIntegrity !== entry.treeIntegrity)
    throw new PackageError('E_LOCK_MISMATCH', 'installed inventory tree differs from lock', {
      detail: { id },
    })
  if (
    entry.provenance &&
    (entry.provenance.treeIntegrity !== entry.treeIntegrity ||
      entry.provenance.version !== entry.version ||
      canonical(entry.provenance.source) !== canonical(entry.source))
  )
    throw new PackageError('E_LOCK_MISMATCH', 'Package provenance differs from installed snapshot', {
      code: 'E_PACKAGE_PROVENANCE',
    })
  const source = parseSource(entry.source.ref)
  const key =
    source.type !== 'workspace' && source.type !== 'local' && cache
      ? canonical({ id, directory, entry, ceiling, treeIntegrity })
      : undefined
  if (key) {
    const warm = cache?.get(key)
    if (warm) return warm
  }
  let checked: ReturnType<typeof inspectVerifiedTree>
  try {
    checked = inspectVerifiedTree(
      {
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
      },
      treeIntegrity,
    )
  } catch (error) {
    if (isReservedRowIdPackageError(error))
      return { capabilityHash: hash, blockers: [RESERVED_WEB_ROW_BLOCKER] }
    if (error instanceof PackageError && error.detail.reason === 'legacy-extension-format')
      return { capabilityHash: hash, blockers: [LEGACY_EXTENSION_BLOCKER] }
    const reason = packageShapeReason(error)
    if (reason !== undefined)
      return {
        capabilityHash: hash,
        blockers: [{ code: 'incompatible', references: [reason, 'docs/guide/packages.md'] }],
      }
    throw error
  }
  if (
    checked.preview.id !== id ||
    canonical(checked.preview.contributions) !== canonical(entry.contributions) ||
    canonical(checked.preview.dependencies) !== canonical(entry.dependencies) ||
    canonical(checked.preview.metadata) !== canonical(entry.metadata) ||
    canonical(checked.preview.declaredCapabilities) !== canonical(entry.declaredCapabilities)
  )
    throw new PackageError('E_LOCK_MISMATCH', 'installed inventory metadata differs from lock', {
      detail: { id },
    })
  const result = freezeData({
    capabilityHash: hash,
    blockers: checked.preview.blockers,
    ...(checked.preview.kinds === undefined ? {} : { kinds: checked.preview.kinds }),
  })
  if (key && cache) {
    const oldest = cache.keys().next().value
    if (cache.size >= 128 && oldest !== undefined) cache.delete(oldest)
    cache.set(key, result)
  }
  return result
}
function verifiedRollbackTarget(
  id: string,
  entry: LockEntry,
  options: {
    dataDir: string
    profile: string
    ceiling: readonly string[]
    verificationCache?: InventoryVerificationCache
  },
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
  ) {
    // A legacy entry's version/integrity-only previous names no retained tree: no rollback target,
    // and the row already carries its migration blocker. A modern entry's previous must be complete.
    if (entry.contributions === undefined) return null
    throw new PackageError('E_LOCK_MISMATCH', 'previous package snapshot is incomplete', {
      detail: { id, reason: 'previous-incomplete' },
    })
  }
  const snapshot = { ...structuredClone(previous), previous: null } as LockEntry
  let verified: ReturnType<typeof verifyPackageDirectory>
  try {
    verified = verifyPackageDirectory(
      id,
      snapshot,
      previousPackageDir(options, id),
      options.ceiling,
      options.verificationCache,
    )
  } catch (error) {
    if (isReservedRowIdPackageError(error)) return null
    throw error
  }
  if (verified.blockers.length) return null
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
function* inventoryReadSteps(
  lock: Lockfile,
  options: {
    dataDir: string
    profileDir: string
    ceiling?: readonly string[]
    verificationCache?: InventoryVerificationCache
    builtinDirectory?: (id: string) => string | undefined
  },
): Generator<void, InstalledInventory, void> {
  const packages: InstalledPackage[] = [],
    paths = new Set<string>()
  const capabilityPolicy = readPluginCapabilityPolicy(options.profileDir)
  const sourceConfig = readPackageSourceConfiguration(options.profileDir)
  const verifyCatalog = officialCatalogVerifier(sourceConfig)
  for (const [id, entry] of Object.entries(lock.packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    yield
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
    const blockers: PackageBlocker[] = capabilityPolicyBlockers(entry.declaredCapabilities, capabilityPolicy)
    if (
      entry.source.type === 'local' &&
      entry.source.ref.startsWith('local:workspace/') &&
      lock.policySnapshot.workspacePackages === 'deny'
    )
      blockers.push({ code: 'policy', references: ['workspace-packages-denied'] })
    let provenance = entry.provenance
    let hash = capabilityHash(entry)
    let kinds: readonly AgnesPluginKind[] | undefined
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
        options.verificationCache,
      )
      provenance = verifyCatalog(
        id,
        recordProvenance(
          entry.source,
          {
            dir: directory,
            version: entry.version,
            integrity: entry.integrity,
            dependencies: entry.dependencies,
            ...(entry.provenance ? { provenance: entry.provenance } : {}),
          },
          entry.treeIntegrity,
        ),
      )
      if (entry.trust !== 'builtin') enforceSourceConfiguration(sourceConfig, provenance)
      hash = verified.capabilityHash
      kinds = verified.kinds
      blockers.push(
        ...verified.blockers.filter(
          (b) => !(entry.source.type === 'workspace' && b.references.includes('use-trust-workspace')),
        ),
      )
    }
    let metadata = entry.metadata
    if (entry.trust === 'builtin' && directory && existsSync(join(directory, 'package.json'))) {
      const pkg = readStaticJson(join(directory, 'package.json'))
      const author = (pkg.agnes as { metadata?: unknown } | undefined)?.metadata
      if (author !== undefined) {
        const checked = validatePluginMetadata(author)
        if (!checked.ok) throw new PackageError('E_EXT_LOAD', 'Invalid builtin plugin metadata')
        metadata = checked.value
      }
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
    let presentation: PackagePresentation | undefined
    if (directory && existsSync(join(directory, 'package.json'))) {
      try {
        presentation = readPackagePresentation(directory, entry.trust === 'builtin', entry.contributions)
      } catch {
        /* Supplementary author display data must not change activation/blocker semantics. */
      }
    }
    packages.push({
      id,
      entry: { ...entry, ...(provenance ? { provenance } : {}), ...(metadata ? { metadata } : {}) },
      directory,
      ...(presentation ? { presentation } : {}),
      capabilityHash: hash,
      trusted,
      enabled: entry.state.enabled,
      ...(kinds === undefined ? {} : { kinds }),
      contributions: entry.contributions ?? [],
      blockers,
      verifiedRollbackTarget: verifiedRollbackTarget(id, entry, {
        dataDir: options.dataDir,
        profile: lock.profile,
        ceiling: options.ceiling ?? lock.policySnapshot.capabilityCeiling,
        ...(options.verificationCache ? { verificationCache: options.verificationCache } : {}),
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

/** Synchronous transaction readers and async readers share every verification and refusal. */
export function readInventory(...args: Parameters<typeof inventoryReadSteps>): InstalledInventory {
  return collectRead(inventoryReadSteps(...args))
}
export function readInventoryAsync(
  ...args: Parameters<typeof inventoryReadSteps>
): Promise<InstalledInventory> {
  return collectReadAsync(inventoryReadSteps(...args))
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
  'directory' | 'verifiedRollbackTarget' | 'localFailure' | 'localReloadRequired'
> & {
  verifiedRollbackTarget: Readonly<{
    version: string
    integrity: string
    capabilityHash: string
    treeIntegrity: string
  }> | null
})[] {
  return packages
    .filter((p) => !(p.entry.source.type === 'local' && p.directory === null))
    .map(
      ({
        directory: _directory,
        verifiedRollbackTarget: rollback,
        localFailure: _failure,
        localReloadRequired: _pending,
        ...p
      }) => ({
        ...p,
        verifiedRollbackTarget: rollback && {
          version: rollback.version,
          integrity: rollback.integrity,
          capabilityHash: rollback.capabilityHash,
          treeIntegrity: rollback.treeIntegrity,
        },
      }),
    )
}
