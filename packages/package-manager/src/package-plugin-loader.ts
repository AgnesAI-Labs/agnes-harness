import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  normalizePluginExport,
  type PackageSnapshotCandidateRef,
  type PackageSnapshotVerifier,
  type VerifiedRowEntry,
  VerifiedRowError,
} from '@agnes/plugin-runtime/host'
import { PackageError } from './errors.js'
import { canonical, freezeData, readStaticJson } from './integrity.js'
import type { InstalledInventory, InstalledPackage } from './inventory.js'
import { type AgnesPluginManifestEntry, parseAgnesPluginEntries } from './plugin-manifest.js'
import type { RuntimePin, RuntimeSnapshot } from './runtime-snapshots.js'
import { hashDirectory } from './sources.js'

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
  throw new PackageError('E_LOCK_MISMATCH', 'runtime snapshot changed while loading plugins', {
    detail: { reason },
  })
}

function assertSnapshotTree(snapshot: RuntimeSnapshot, reason: string): void {
  let digest: string
  try {
    digest = hashDirectory(snapshot.directory, { exclude: [] })
  } catch {
    integrityFailure(reason)
  }
  if (digest !== snapshot.treeIntegrity) integrityFailure(reason)
}

function readDeclarations(snapshot: RuntimeSnapshot): readonly Readonly<AgnesPluginManifestEntry>[] {
  const pkg = readStaticJson(join(snapshot.directory, 'package.json'))
  if (pkg.name !== snapshot.packageId || pkg.version !== snapshot.version)
    integrityFailure('snapshot-package-identity')
  const agnes = pkg.agnes
  if (agnes === undefined) return Object.freeze([])
  if (!agnes || typeof agnes !== 'object' || Array.isArray(agnes)) stateFailure('plugin-manifest')
  if ((agnes as Readonly<Record<string, unknown>>).extensions !== undefined)
    stateFailure('legacy-extension-format')
  try {
    return parseAgnesPluginEntries(snapshot.packageId, (agnes as Readonly<Record<string, unknown>>).plugins)
  } catch {
    stateFailure('plugin-manifest')
  }
}

function normalizeExport(
  module: Readonly<Record<string, unknown>>,
  declaration: Readonly<AgnesPluginManifestEntry>,
): VerifiedRowEntry {
  if (!Object.hasOwn(module, declaration.export))
    stateFailure('plugin-export-missing', { export: declaration.export })
  try {
    return normalizePluginExport(module[declaration.export] as never)
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
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) stateFailure('generation')
  assertSnapshotTree(input.snapshot, 'snapshot-stale')
  const declarations = readDeclarations(input.snapshot)
  if (!declarations.length) return Object.freeze([])
  if (declarations.some((declaration) => declaration.runtime === 'isolated'))
    stateFailure('isolated-runtime-unavailable')
  const declarationSnapshot = canonical(declarations)

  let imported: Readonly<Record<string, unknown>> | undefined
  let importFailed = false
  try {
    imported = await input.importModule(input.snapshot)
  } catch {
    importFailed = true
  }

  assertSnapshotTree(input.snapshot, 'snapshot-changed')
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
  assertSnapshotTree(input.snapshot, 'snapshot-changed')
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
      return verifySource(source?.generation === candidate.generation ? source : undefined, candidate)
    },
  })
}

function verifySource(
  source: Readonly<RuntimePluginSnapshot> | undefined,
  candidate: Readonly<PackageSnapshotCandidateRef>,
) {
  if (!source) {
    throw new VerifiedRowError(
      'E_SNAPSHOT_UNAVAILABLE',
      `no installed snapshot authority for ${candidate.packageId}`,
    )
  }
  assertSnapshotTree(source.snapshot, 'snapshot-changed')
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
