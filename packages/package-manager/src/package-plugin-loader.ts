import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ProviderError } from '@agnes/extension-api'
import {
  normalizePluginExport,
  type PackageSnapshotCandidateRef,
  type PackageSnapshotVerifier,
  type VerifiedRowEntry,
  VerifiedRowError,
} from '@agnes/plugin-runtime/host'
import { parsePackageBundleContract } from './bundle-contract.js'
import { PackageError } from './errors.js'
import { canonical, freezeData, readStaticJson } from './integrity.js'
import type { InstalledInventory, InstalledPackage } from './inventory.js'
import { type AgnesPluginManifestEntry, parseAgnesPluginEntries } from './plugin-manifest.js'
import type { RuntimePin, RuntimeSnapshot } from './runtime-snapshots.js'
import { hashDirectoryAsync } from './sources.js'
import {
  invalidatePackageVerification,
  verifiedDirectoryDigest,
  verifiedDirectoryDigestAsync,
} from './verification-operation.js'

export interface PackagePluginModuleLoader {
  importModule(snapshot: RuntimeSnapshot): Promise<Readonly<Record<string, unknown>>>
}

export type LoadedPackagePlugin = Readonly<{
  declaration: Readonly<AgnesPluginManifestEntry>
  candidate: Readonly<PackageSnapshotCandidateRef>
  entry: VerifiedRowEntry
}>

export type LoadPackagePluginsInput = Readonly<{
  snapshot: RuntimeSnapshot
  generation: number
  importModule: PackagePluginModuleLoader['importModule']
}>

export type RuntimePluginSnapshot = Readonly<{
  snapshot: RuntimeSnapshot
  generation: number
  trusted: boolean
  /** Current installed identity is enabled for new sessions; retained pins may be false. */
  enabled?: boolean
}>

export function activeRuntimePinId(ref: Readonly<{ packageId: string; integrity: string }>): string {
  return `active:${createHash('sha256').update(`${ref.packageId}\0${ref.integrity}`).digest('hex')}`
}

/** The snapshot id a desired plugin row names for an installed package. */
export function installedRuntimeSnapshotId(pkg: InstalledPackage): string {
  return pkg.entry.integrity
}

/**
 * Every installed package a Host can load plugins from, keyed the way desired rows name them.
 * The tree integrity is re-verified when the module is loaded, so a package without one is skipped.
 */
export function runtimePluginSnapshotsFromInventory(
  inventory: InstalledInventory,
): readonly Readonly<RuntimePluginSnapshot>[] {
  const sources: Readonly<RuntimePluginSnapshot>[] = []
  for (const pkg of inventory.packages) {
    const treeIntegrity = pkg.entry.treeIntegrity
    if (!pkg.directory || !treeIntegrity) continue
    sources.push(
      Object.freeze({
        snapshot: Object.freeze({
          snapshotId: installedRuntimeSnapshotId(pkg),
          profile: inventory.profile,
          packageId: pkg.id,
          version: pkg.entry.version,
          integrity: pkg.entry.integrity,
          treeIntegrity,
          capabilityHash: pkg.capabilityHash,
          directory: pkg.directory,
          contributions: pkg.contributions,
          ...(pkg.entry.agents ? { agents: pkg.entry.agents } : {}),
          ...(pkg.entry.application ? { application: pkg.entry.application } : {}),
        }),
        generation: 1,
        trusted: pkg.trusted,
      }),
    )
    const previous = pkg.verifiedRollbackTarget
    if (previous && previous.integrity !== pkg.entry.integrity) {
      // The store keeps one previous version on disk so a failed upgrade can go back to it. It is
      // loadable only while the current entry is trusted, so untrusting the package also hides it.
      sources.push(
        Object.freeze({
          snapshot: Object.freeze({
            snapshotId: previous.integrity,
            profile: inventory.profile,
            packageId: pkg.id,
            version: previous.version,
            integrity: previous.integrity,
            treeIntegrity: previous.treeIntegrity,
            capabilityHash: previous.capabilityHash,
            directory: previous.directory,
            contributions: previous.contributions,
          }),
          generation: 1,
          trusted: pkg.trusted,
        }),
      )
    }
  }
  return Object.freeze(sources)
}

/** Verified declarative packages need no artificial executable row or active code pin. */
export function runtimePluginDataSourcesFromInventory(
  inventory: InstalledInventory,
): readonly RuntimePluginSnapshot[] {
  const packages = inventory.packages.filter((pkg) => {
    if (!pkg.enabled || !pkg.trusted || pkg.blockers.length || !pkg.directory || !pkg.entry.treeIntegrity)
      return false
    const manifest = readStaticJson(join(pkg.directory, 'package.json'))
    const agnes = (manifest.agnes ?? {}) as Record<string, unknown>
    if (parseAgnesPluginEntries(pkg.id, agnes.plugins).length) return false
    return (
      Object.keys(parsePackageBundleContract(pkg.id, agnes.bundles)).length > 0 ||
      pkg.entry.application !== undefined
    )
  })
  return runtimePluginSnapshotsFromInventory({ ...inventory, packages })
    .filter((source) =>
      packages.some(
        (pkg) => pkg.id === source.snapshot.packageId && pkg.entry.integrity === source.snapshot.integrity,
      ),
    )
    .map((source) => Object.freeze({ ...source, enabled: true }))
}

/** Only daemon-owned active pins may supply executable rows to a shared worker. */
export function runtimePluginSnapshotsFromPins(
  inventory: InstalledInventory,
  pins: readonly RuntimePin[],
): readonly Readonly<RuntimePluginSnapshot>[] {
  const trusted = new Set(
    inventory.packages.filter((pkg) => pkg.trusted && pkg.blockers.length === 0).map((pkg) => pkg.id),
  )
  const sources = new Map<string, RuntimePluginSnapshot>()
  for (const pin of pins) {
    if (
      pin.purpose !== 'active' ||
      pin.pinId !== activeRuntimePinId(pin.snapshot) ||
      pin.snapshot.profile !== inventory.profile ||
      !trusted.has(pin.snapshot.packageId)
    )
      continue
    const current = inventory.packages.find((pkg) => pkg.id === pin.snapshot.packageId)
    // A historical identity keeps its own bytes; reusing the installed identity must keep
    // its verified tree and capability binding too. Store reads additionally bind source/ref.
    if (
      current?.entry.integrity === pin.snapshot.integrity &&
      (current.entry.version !== pin.snapshot.version ||
        current.entry.treeIntegrity !== pin.snapshot.treeIntegrity ||
        current.capabilityHash !== pin.snapshot.capabilityHash)
    )
      throw new PackageError('E_LOCK_MISMATCH', 'active runtime pin differs from installed snapshot', {
        detail: { reason: 'active-pin-installed-binding' },
      })
    const key = `${pin.snapshot.packageId}\0${pin.snapshot.integrity}`
    const existing = sources.get(key)
    if (existing && existing.snapshot.treeIntegrity !== pin.snapshot.treeIntegrity)
      throw new PackageError('E_LOCK_MISMATCH', 'conflicting active runtime pins', {
        detail: { reason: 'active-pin-conflict' },
      })
    sources.set(
      key,
      Object.freeze({
        snapshot: Object.freeze({ ...pin.snapshot, snapshotId: pin.snapshot.integrity }),
        enabled: inventory.packages.some(
          (pkg) =>
            pkg.id === pin.snapshot.packageId &&
            pkg.enabled &&
            pkg.entry.integrity === pin.snapshot.integrity,
        ),
        generation: 1,
        trusted: true,
      }),
    )
  }
  return Object.freeze([...sources.values()])
}

function stateFailure(reason: string, detail: Record<string, unknown> = {}): never {
  throw new PackageError('E_EXT_LOAD', 'package plugin module cannot be loaded', {
    detail: { reason, ...detail },
  })
}

function integrityFailure(reason: string): never {
  invalidatePackageVerification()
  throw new PackageError('E_LOCK_MISMATCH', 'runtime snapshot changed while loading plugins', {
    detail: { reason },
  })
}

function assertSnapshotTree(snapshot: RuntimeSnapshot, reason: string): void {
  let digest: string
  try {
    digest = verifiedDirectoryDigest(snapshot.directory, snapshot)
  } catch {
    integrityFailure(reason)
  }
  if (digest !== snapshot.treeIntegrity) integrityFailure(reason)
}

async function assertSnapshotTreeAsync(snapshot: RuntimeSnapshot, reason: string): Promise<void> {
  try {
    if ((await hashDirectoryAsync(snapshot.directory, { exclude: [] })) !== snapshot.treeIntegrity)
      integrityFailure(reason)
  } catch {
    integrityFailure(reason)
  }
}

function readDeclarations(
  snapshot: RuntimeSnapshot,
  pkg = readStaticJson(join(snapshot.directory, 'package.json')),
): readonly Readonly<AgnesPluginManifestEntry>[] {
  if (pkg.name !== snapshot.packageId || pkg.version !== snapshot.version)
    integrityFailure('snapshot-package-identity')
  const agnes = pkg.agnes
  if (agnes === undefined) return Object.freeze([])
  if (!agnes || typeof agnes !== 'object' || Array.isArray(agnes)) stateFailure('plugin-manifest')
  if ((agnes as Readonly<Record<string, unknown>>).extensions !== undefined)
    stateFailure('legacy-extension-format')
  try {
    return parseAgnesPluginEntries(snapshot.packageId, (agnes as Readonly<Record<string, unknown>>).plugins)
  } catch (error) {
    if (error instanceof ProviderError) throw error
    stateFailure('plugin-manifest')
  }
}

/** Static admission only. Loading still verifies again immediately before and after import. */
export function preflightPackagePlugins(input: Pick<LoadPackagePluginsInput, 'snapshot' | 'generation'>) {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) stateFailure('generation')
  assertSnapshotTree(input.snapshot, 'snapshot-stale')
  return preflightMetadata(input)
}

export async function preflightPackagePluginsAsync(
  input: Pick<LoadPackagePluginsInput, 'snapshot' | 'generation'>,
) {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) stateFailure('generation')
  try {
    if (
      (await verifiedDirectoryDigestAsync(input.snapshot.directory, input.snapshot)) !==
      input.snapshot.treeIntegrity
    )
      integrityFailure('snapshot-stale')
  } catch {
    integrityFailure('snapshot-stale')
  }
  return preflightMetadata(input)
}

function preflightMetadata(input: Pick<LoadPackagePluginsInput, 'snapshot' | 'generation'>) {
  const pkg = readStaticJson(join(input.snapshot.directory, 'package.json'))
  const declarations = readDeclarations(input.snapshot, pkg)
  if (declarations.some((declaration) => declaration.runtime === 'isolated'))
    stateFailure('isolated-runtime-unavailable')
  const dependencyIds = new Set<string>()
  if (declarations.length) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = pkg[field]
      if (dependencies === undefined) continue
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
        stateFailure('plugin-dependencies')
      for (const [id, range] of Object.entries(dependencies)) {
        if (typeof range !== 'string' || !range.trim()) stateFailure('plugin-dependencies')
        dependencyIds.add(id)
      }
    }
  }
  return Object.freeze({ declarations, dependencyIds: Object.freeze([...dependencyIds]) })
}

function normalizeExport(
  module: Readonly<Record<string, unknown>>,
  declaration: Readonly<AgnesPluginManifestEntry>,
): VerifiedRowEntry {
  if (!Object.hasOwn(module, declaration.export))
    stateFailure('plugin-export-missing', { export: declaration.export })
  try {
    return normalizePluginExport(module[declaration.export] as never, declaration)
  } catch {
    stateFailure('plugin-export-shape', { export: declaration.export })
  }
}

/**
 * Load the named Cordis exports declared by an already verified immutable runtime snapshot.
 *
 * Legacy extension declarations are intentionally absent from this path: package inspection may
 * translate their static data, but only `agnes.plugins` can cause executable plugin installation.
 */
export async function loadPackagePlugins(
  input: LoadPackagePluginsInput,
): Promise<readonly LoadedPackagePlugin[]> {
  // Static readers can reuse exact bytes within their operation; import is an independent gate.
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) stateFailure('generation')
  await assertSnapshotTreeAsync(input.snapshot, 'snapshot-stale')
  const { declarations } = preflightMetadata(input)
  if (!declarations.length) return Object.freeze([])
  const declarationSnapshot = canonical(declarations)

  let imported: Readonly<Record<string, unknown>> | undefined
  let importFailed = false
  try {
    imported = await input.importModule(input.snapshot)
  } catch {
    importFailed = true
  }

  await assertSnapshotTreeAsync(input.snapshot, 'snapshot-changed')
  if (canonical(readDeclarations(input.snapshot)) !== declarationSnapshot)
    integrityFailure('snapshot-manifest-changed')
  if (importFailed) stateFailure('module-import')
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) stateFailure('module-namespace')

  const loaded = declarations.map((declaration) =>
    freezeData({
      declaration,
      candidate: {
        packageId: input.snapshot.packageId,
        snapshotId: input.snapshot.snapshotId,
        exportName: declaration.export,
        generation: input.generation,
      },
      entry: normalizeExport(imported as Readonly<Record<string, unknown>>, declaration),
    }),
  )
  await assertSnapshotTreeAsync(input.snapshot, 'snapshot-changed')
  return Object.freeze(loaded)
}

/** Build the verification authority from PackageManager-owned immutable runtime snapshots. */
export function createPackageSnapshotVerifier(
  sources: readonly Readonly<RuntimePluginSnapshot>[],
): PackageSnapshotVerifier {
  const byKey = new Map<string, Readonly<RuntimePluginSnapshot>>()
  for (const source of sources) {
    if (!Number.isSafeInteger(source.generation) || source.generation < 1) stateFailure('generation')
    const key = snapshotKey({
      packageId: source.snapshot.packageId,
      snapshotId: source.snapshot.snapshotId,
      exportName: '',
      generation: source.generation,
    })
    if (byKey.has(key)) stateFailure('duplicate-snapshot')
    byKey.set(key, freezeData(source))
  }
  return Object.freeze({
    async verify(candidate: Readonly<PackageSnapshotCandidateRef>) {
      return verifySource(byKey.get(snapshotKey({ ...candidate, exportName: '' })), candidate)
    },
  })
}

/** A verifier that resolves the installed source on every call, so trust and removal are current. */
export function createLivePackageSnapshotVerifier(
  lookup: (packageId: string, snapshotId: string) => Readonly<RuntimePluginSnapshot> | undefined,
): PackageSnapshotVerifier {
  return Object.freeze({
    async verify(candidate: Readonly<PackageSnapshotCandidateRef>) {
      const source = lookup(candidate.packageId, candidate.snapshotId)
      const before = canonical(source)
      const result = await verifySource(
        source?.generation === candidate.generation ? source : undefined,
        candidate,
      )
      // Async IO cannot carry an old trust/activation authority across a concurrent publication.
      if (canonical(lookup(candidate.packageId, candidate.snapshotId)) !== before)
        throw new VerifiedRowError('E_SNAPSHOT_UNAVAILABLE', 'snapshot authority changed during verification')
      return result
    },
  })
}

async function verifySource(
  source: Readonly<RuntimePluginSnapshot> | undefined,
  candidate: Readonly<PackageSnapshotCandidateRef>,
) {
  if (!source) {
    throw new VerifiedRowError(
      'E_SNAPSHOT_UNAVAILABLE',
      `no installed snapshot authority for ${candidate.packageId}`,
    )
  }
  await assertSnapshotTreeAsync(source.snapshot, 'snapshot-changed')
  const exports = readDeclarations(source.snapshot).map(({ export: exportName }) => exportName)
  return freezeData({
    packageId: source.snapshot.packageId,
    snapshotId: source.snapshot.snapshotId,
    generation: source.generation,
    digest: source.snapshot.integrity,
    exports,
    trusted: source.trusted,
  })
}

function snapshotKey(candidate: Readonly<PackageSnapshotCandidateRef>): string {
  return `${candidate.packageId}\0${candidate.snapshotId}\0${candidate.generation}`
}
