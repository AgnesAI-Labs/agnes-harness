import {
  createPluginRow,
  DYNAMIC_SEAM_NAMES,
  type DynamicSeamName,
  E_ROW_IMPORT,
  type ExactExtrasPolicy,
  type HostPluginImporterFactory,
  type PackageSnapshotCandidateRef,
  type PackageSnapshotVerifier,
  type VerifiedExtrasEnvelope,
  type VerifiedRowEntry,
  VerifiedRowError,
} from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'
import type { PresetDoc } from '../presets/types.js'
import type { ResolvedProfile } from '../profile/types.js'
import type { PackageModule, SeamInitContext } from './packages.js'
import type { HostBuiltinRowClaim } from './seams-cordis.js'

export const HOST_SEAM_INIT = 'host:seam-init' as const
export const REQUIRED_SEAM_ROW_IDS = Object.freeze(DYNAMIC_SEAM_NAMES.map((name) => `seam:${name}`))

export type BuiltSeamRows = Readonly<{
  rows: readonly ReturnType<typeof createPluginRow>[]
  builtinClaims: readonly Readonly<HostBuiltinRowClaim>[]
  thirdPartyClaims: readonly Readonly<HostThirdPartyRowClaim>[]
  exactExtras: ExactExtrasPolicy
  thirdPartyExtras: Readonly<Record<string, VerifiedExtrasEnvelope>>
}>

export type HostThirdPartyRowClaim = Readonly<{
  row: ReturnType<typeof createPluginRow>
  entry: VerifiedRowEntry
  snapshot: Readonly<PackageSnapshotCandidateRef>
}>

/** Compile the eight profile-selected runtime seams into ordinary Cordis rows. */
export function buildSeamRows(
  input: Readonly<{
    profile: ResolvedProfile
    modules: ReadonlyMap<string, PackageModule>
    preset: PresetDoc
    contextFor(owner: string, seam: DynamicSeamName): SeamInitContext
  }>,
): BuiltSeamRows {
  const expectedExtras = new Map<
    string,
    Readonly<{ slot: string; revision: string; values: Readonly<Record<string, unknown>> }>
  >()
  const claims: HostBuiltinRowClaim[] = []
  const thirdPartyClaims: HostThirdPartyRowClaim[] = []
  const rows = DYNAMIC_SEAM_NAMES.map((name) => {
    const id = `seam:${name}`
    const packageId = input.profile.seams[name]
    const resolvedPackage = input.profile.packages.find(
      (candidate) => candidate.enabled && candidate.id === packageId,
    )
    const module = input.modules.get(packageId)
    if (!resolvedPackage || !module) {
      throw new HostError('E_DEP_MISSING', `seam ${name} package is not enabled`, {
        detail: { seam: name, package: packageId },
      })
    }
    const matching = (module.plugins ?? []).filter(({ declaration }) => declaration.id === id)
    if (matching.length !== 1) {
      throw new HostError('E_SEAM_EXPORT_MISSING', `${packageId} must export exactly one ${id} plugin`, {
        detail: { seam: name, package: packageId, matches: matching.length },
      })
    }
    const selected = matching[0]
    if (!selected) throw new Error('unreachable seam plugin selection')
    if (
      selected.entry.provides.length !== 1 ||
      selected.entry.provides[0] !== id ||
      Object.keys(selected.entry.inject).join('\0') !== HOST_SEAM_INIT
    ) {
      throw new HostError('E_SEAM_EXPORT_MISSING', `${packageId} ${id} has invalid seam metadata`, {
        detail: { seam: name, package: packageId },
      })
    }

    const revision = `host-seam-extras:v1:${input.profile.hash}:${name}`
    const values = Object.freeze({
      [HOST_SEAM_INIT]: () => input.contextFor(packageId, name),
    })
    const extras = Object.freeze({ slot: id, revision, values })
    expectedExtras.set(id, extras)

    const snapshotId = selected.candidate?.snapshotId ?? resolvedPackage.integrity
    const snapshotDigest = selected.snapshotDigest ?? resolvedPackage.integrity
    const plugin =
      resolvedPackage.trust === 'builtin'
        ? `builtin:${packageId}/${selected.declaration.export}`
        : `${packageId}@${snapshotId}/${selected.declaration.export}`
    const row = createPluginRow({
      id,
      plugin,
      snapshotDigest,
      exportName: selected.declaration.export,
      entryRevision: snapshotId,
      extrasRevision: revision,
      mountRevision: 'host-seam-row:v1',
      config: selected.declaration.config ?? input.preset,
      inject: Object.keys(selected.entry.inject),
      provides: selected.entry.provides,
      runtime: selected.declaration.runtime,
    })
    if (resolvedPackage.trust === 'builtin') {
      claims.push(Object.freeze({ row, entry: selected.entry, extras }))
    } else {
      if (!selected.candidate || !selected.snapshotDigest) {
        throw new HostError(
          'E_EXT_LOAD',
          `${packageId} ${id} is not backed by an immutable runtime snapshot`,
          { detail: { seam: name, package: packageId, reason: 'snapshot-unavailable' } },
        )
      }
      thirdPartyClaims.push(
        Object.freeze({
          row,
          entry: selected.entry,
          snapshot: selected.candidate,
        }),
      )
    }
    return row
  })

  const verifyExtras: ExactExtrasPolicy['verify'] = ({ row, slot, revision, values }) => {
    const expected = expectedExtras.get(row.id)
    if (
      !expected ||
      slot !== expected.slot ||
      revision !== expected.revision ||
      Object.keys(values).length !== 1 ||
      typeof values[HOST_SEAM_INIT] !== 'function'
    ) {
      throw new Error(`E_EXACT_EXTRAS: invalid Host seam extras for ${row.id}`)
    }
    return expected.values
  }
  const exactExtras: ExactExtrasPolicy = Object.freeze({ verify: verifyExtras })

  return Object.freeze({
    rows: Object.freeze(rows),
    builtinClaims: Object.freeze(claims),
    thirdPartyClaims: Object.freeze(thirdPartyClaims),
    exactExtras,
    thirdPartyExtras: Object.freeze(Object.fromEntries(expectedExtras)),
  })
}

/** Mutable Host-owned catalogue used when a worker changes its immutable package snapshot set. */
export function createMutablePackagePluginGate(
  initialClaims: readonly Readonly<HostThirdPartyRowClaim>[],
  initialSnapshots: PackageSnapshotVerifier | undefined,
  fallback?: HostPluginImporterFactory,
): Readonly<{
  importer: HostPluginImporterFactory
  snapshots: PackageSnapshotVerifier
  replace(
    claims: readonly Readonly<HostThirdPartyRowClaim>[],
    snapshots: PackageSnapshotVerifier | undefined,
  ): void
}> {
  let claims = claimMap(initialClaims)
  let authority = initialSnapshots
  const importer: HostPluginImporterFactory = (mounts) => {
    const external = fallback?.(mounts)
    return async (row) => {
      const claim = claims.get(row.id)
      const internal =
        claim && claim.row.mountIdentity === row.mountIdentity
          ? await mounts.verifyAndCreate({ row, entry: claim.entry, snapshot: claim.snapshot })
          : undefined
      const imported = external ? await external(row) : undefined
      if (internal && imported) {
        throw new VerifiedRowError(E_ROW_IMPORT, `row ${row.id} was claimed by multiple importers`)
      }
      return internal ?? imported
    }
  }
  const snapshots: PackageSnapshotVerifier = Object.freeze({
    verify(candidate: Readonly<PackageSnapshotCandidateRef>) {
      if (!authority) {
        throw new VerifiedRowError(
          'E_SNAPSHOT_UNAVAILABLE',
          `no installed snapshot authority for ${candidate.packageId}`,
        )
      }
      return authority.verify(candidate)
    },
  })
  return Object.freeze({
    importer,
    snapshots,
    replace(nextClaims, nextSnapshots) {
      claims = claimMap(nextClaims)
      authority = nextSnapshots
    },
  })
}

function claimMap(
  claims: readonly Readonly<HostThirdPartyRowClaim>[],
): ReadonlyMap<string, Readonly<HostThirdPartyRowClaim>> {
  const output = new Map<string, Readonly<HostThirdPartyRowClaim>>()
  for (const claim of claims) {
    if (output.has(claim.row.id)) {
      throw new VerifiedRowError(E_ROW_IMPORT, `row ${claim.row.id} has multiple installed claims`)
    }
    output.set(claim.row.id, claim)
  }
  return output
}
