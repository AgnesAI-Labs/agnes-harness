import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type {
  HostPluginImporterFactory,
  PackageSnapshotCandidateRef,
  RuntimeTarget,
  VerifiedRowEntry,
} from '@agnes/plugin-runtime/host'
import type { PackageModule } from './assemble/packages.js'
import type { HostBuiltinRowClaim, HostPrivatePluginTreeInput } from './assemble/seams-cordis.js'

type PackageTrust = 'builtin' | 'trusted'

type TargetPluginIdentity = Readonly<{
  packageId: string
  exportName: string
  snapshotId?: string
}>

export type RuntimeTargetClaimLoaderOptions = Readonly<{
  /** The canonical candidate target. Only its ordinary rows can receive a claim. */
  target: RuntimeTarget
  /** Immutable snapshots already selected by RuntimePluginCatalogue for this exact target. */
  sources: readonly Readonly<RuntimePluginSnapshot>[]
  /**
   * Candidate-local package loading. Production callers normally delegate this to
   * loadRuntimePackage(), then pass its module; this loader must never receive a live Host module
   * map or mutable package gate.
   */
  load(source: Readonly<RuntimePluginSnapshot>): Promise<PackageModule | undefined>
  /** Host-owned package inventory authority. Target data cannot select its own trust tier. */
  trust(source: Readonly<RuntimePluginSnapshot>): PackageTrust | undefined
}>

/** Exact, candidate-local claims suitable for assembleOrdinaryPluginTree(). */
export type RuntimeTargetClaims = Readonly<{
  privateInput: Pick<HostPrivatePluginTreeInput, 'builtinClaims'>
  pluginImporter: HostPluginImporterFactory
}>

function fail(reason: string): never {
  throw new Error(`E_RUNTIME_TARGET_CLAIM: ${reason}`)
}

function sourceKey(packageId: string): string {
  return packageId
}

function candidateFor(
  source: Readonly<RuntimePluginSnapshot>,
  exportName: string,
): PackageSnapshotCandidateRef {
  return Object.freeze({
    packageId: source.snapshot.packageId,
    snapshotId: source.snapshot.snapshotId,
    exportName,
    generation: source.generation,
  })
}

function parsePlugin(plugin: string): TargetPluginIdentity {
  if (plugin.startsWith('builtin:')) {
    const value = plugin.slice('builtin:'.length)
    const slash = value.lastIndexOf('/')
    if (slash <= 0 || slash === value.length - 1) fail(`invalid builtin plugin identity ${plugin}`)
    return Object.freeze({ packageId: value.slice(0, slash), exportName: value.slice(slash + 1) })
  }
  const slash = plugin.lastIndexOf('/')
  const at = slash > 0 ? plugin.lastIndexOf('@', slash) : -1
  if (at <= 0 || slash <= at + 1 || slash === plugin.length - 1) {
    fail(`invalid snapshot plugin identity ${plugin}`)
  }
  return Object.freeze({
    packageId: plugin.slice(0, at),
    snapshotId: plugin.slice(at + 1, slash),
    exportName: plugin.slice(slash + 1),
  })
}

function sameCandidate(
  actual: Readonly<PackageSnapshotCandidateRef> | undefined,
  expected: Readonly<PackageSnapshotCandidateRef>,
): boolean {
  return (
    actual?.packageId === expected.packageId &&
    actual.snapshotId === expected.snapshotId &&
    actual.exportName === expected.exportName &&
    actual.generation === expected.generation
  )
}

type Claim = Readonly<{
  row: RuntimeTarget['tree']['rows'][number]
  entry: VerifiedRowEntry
  trust: PackageTrust
  snapshot: Readonly<PackageSnapshotCandidateRef>
}>

/**
 * Convert target rows into exact package-export claims without touching a live tree.
 *
 * The target says which export is wanted; immutable snapshot metadata and the host inventory say
 * whether that request is real and which trust factory may mount it. No module export that lacks a
 * target row is retained in the returned importer.
 */
export async function loadRuntimeTargetClaims(
  options: RuntimeTargetClaimLoaderOptions,
): Promise<RuntimeTargetClaims> {
  const sources = new Map<string, Readonly<RuntimePluginSnapshot>>()
  for (const source of options.sources) {
    const key = sourceKey(source.snapshot.packageId)
    if (sources.has(key)) fail(`multiple selected snapshots for ${source.snapshot.packageId}`)
    sources.set(key, source)
  }

  const claims = new Map<string, Claim>()
  const loaded = new Map<string, Promise<PackageModule | undefined>>()
  for (const row of options.target.tree.rows) {
    const identity = parsePlugin(row.plugin)
    const source = sources.get(sourceKey(identity.packageId))
    if (!source) {
      if (identity.snapshotId === undefined) continue
      fail(`target row ${row.id} has no selected snapshot for ${identity.packageId}`)
    }
    const trust = options.trust(source)
    if (trust !== 'builtin' && trust !== 'trusted')
      fail(`package trust unavailable for ${identity.packageId}`)
    if (!source.trusted) fail(`selected snapshot is not trusted for ${identity.packageId}`)
    if (
      trust === 'builtin'
        ? identity.snapshotId !== undefined
        : identity.snapshotId !== source.snapshot.snapshotId
    ) {
      fail(`target row ${row.id} plugin identity does not match package trust or snapshot`)
    }
    if (row.entryRevision !== source.snapshot.snapshotId) {
      fail(`target row ${row.id} entry revision does not match selected snapshot`)
    }
    if (claims.has(row.id)) fail(`duplicate target row ${row.id}`)

    let modulePromise = loaded.get(source.snapshot.packageId)
    if (!modulePromise) {
      modulePromise = options.load(source)
      loaded.set(source.snapshot.packageId, modulePromise)
    }
    const module = await modulePromise
    if (!module || module.id !== source.snapshot.packageId) {
      fail(`candidate loader did not return package ${source.snapshot.packageId}`)
    }
    const matching = (module.plugins ?? []).filter(
      (plugin) =>
        plugin.declaration.export === identity.exportName &&
        plugin.candidate?.exportName === identity.exportName,
    )
    if (matching.length !== 1) {
      fail(`target row ${row.id} has no unique claimed export ${identity.exportName}`)
    }
    const plugin = matching[0]
    if (!plugin || plugin.snapshotDigest !== source.snapshot.integrity) {
      fail(`target row ${row.id} export snapshot digest does not match selected snapshot`)
    }
    const snapshot = candidateFor(source, identity.exportName)
    if (!sameCandidate(plugin.candidate, snapshot)) {
      fail(`target row ${row.id} export candidate does not match selected snapshot`)
    }
    claims.set(row.id, Object.freeze({ row, entry: plugin.entry, trust, snapshot }))
  }

  const builtinClaims: HostBuiltinRowClaim[] = []
  const thirdParty = new Map<string, Claim>()
  for (const claim of claims.values()) {
    if (claim.trust === 'builtin') {
      builtinClaims.push(Object.freeze({ row: claim.row, entry: claim.entry }))
    } else {
      thirdParty.set(claim.row.id, claim)
    }
  }

  const pluginImporter: HostPluginImporterFactory = (mounts) => async (row) => {
    const claim = thirdParty.get(row.id)
    if (!claim || claim.row.mountIdentity !== row.mountIdentity) return undefined
    return mounts.verifyAndCreate({ row, entry: claim.entry, snapshot: claim.snapshot })
  }
  return Object.freeze({
    privateInput: Object.freeze({ builtinClaims: Object.freeze(builtinClaims) }),
    pluginImporter,
  })
}
