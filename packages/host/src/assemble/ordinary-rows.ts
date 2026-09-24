import { createPluginRow, isResourceOwnedRowId } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'
import type { ResolvedProfile } from '../profile/types.js'
import type { PackageModule } from './packages.js'
import type { HostThirdPartyRowClaim } from './seam-rows.js'
import type { HostBuiltinRowClaim } from './seams-cordis.js'

export type OrdinaryPluginLayerEntry = Readonly<{ enabled?: boolean; config?: unknown }>
export type OrdinaryPluginLayer = Readonly<Record<string, OrdinaryPluginLayerEntry>>
export type OrdinaryPluginLayers = Readonly<{
  deployment?: OrdinaryPluginLayer
  user?: OrdinaryPluginLayer
  workspace?: OrdinaryPluginLayer
}>

export type BuiltOrdinaryRows = Readonly<{
  rows: readonly ReturnType<typeof createPluginRow>[]
  builtinClaims: readonly Readonly<HostBuiltinRowClaim>[]
  thirdPartyClaims: readonly Readonly<HostThirdPartyRowClaim>[]
}>

const DYNAMIC_SEAM_ROWS = new Set([
  'seam:approval',
  'seam:artifacts',
  'seam:checkpoint',
  'seam:harness',
  'seam:ledger',
  'seam:principals',
  'seam:repair',
  'seam:verifier',
])

/** Expand package defaults and deployment/user/workspace overrides through one normalized builder. */
export function buildOrdinaryRows(
  profile: ResolvedProfile,
  modules: ReadonlyMap<string, PackageModule>,
  layers: OrdinaryPluginLayers = {},
): BuiltOrdinaryRows {
  const rows: ReturnType<typeof createPluginRow>[] = []
  const builtinClaims: HostBuiltinRowClaim[] = []
  const thirdPartyClaims: HostThirdPartyRowClaim[] = []
  const owners = new Map<string, string>()
  const packageById = new Map(profile.packages.map((pkg) => [pkg.id, pkg] as const))

  for (const [packageId, module] of [...modules].sort(([left], [right]) => left.localeCompare(right))) {
    const resolved = packageById.get(packageId)
    if (!resolved) continue
    for (const plugin of module.plugins ?? []) {
      const { declaration, entry } = plugin
      if (DYNAMIC_SEAM_ROWS.has(declaration.id)) continue
      if (isResourceOwnedRowId(declaration.id)) {
        throw new HostError('E_EXT_LOAD', `ordinary plugin row ${declaration.id} is resource-owned`, {
          detail: { row: declaration.id, package: packageId, reason: 'resource-owned' },
        })
      }
      const previous = owners.get(declaration.id)
      if (previous) {
        throw new HostError('E_EXT_LOAD', `ordinary plugin row ${declaration.id} has multiple owners`, {
          detail: { row: declaration.id, first: previous, second: packageId },
        })
      }
      owners.set(declaration.id, packageId)

      let enabled = declaration.default
      let config = declaration.config
      for (const layer of [layers.deployment, layers.user, layers.workspace]) {
        const override = layer?.[declaration.id]
        if (!override) continue
        if (override.enabled !== undefined) enabled = override.enabled
        if (Object.hasOwn(override, 'config')) config = override.config
      }

      if (resolved.trust !== 'builtin' && (!plugin.candidate || !plugin.snapshotDigest)) {
        throw new HostError(
          'E_EXT_LOAD',
          `${packageId} plugin ${declaration.id} is not backed by an immutable runtime snapshot`,
          { detail: { package: packageId, row: declaration.id, reason: 'snapshot-unavailable' } },
        )
      }
      const snapshotDigest = plugin.snapshotDigest ?? resolved.integrity
      const snapshotId = plugin.candidate?.snapshotId ?? resolved.integrity
      const row = createPluginRow({
        id: declaration.id,
        plugin:
          resolved.trust === 'builtin'
            ? `builtin:${packageId}/${declaration.export}`
            : `${packageId}@${snapshotId}/${declaration.export}`,
        snapshotDigest,
        exportName: declaration.export,
        entryRevision: snapshotId,
        extrasRevision: 'none',
        mountRevision: 'host-ordinary-row:v1',
        ...(config === undefined ? {} : { config }),
        inject: Object.keys(entry.inject),
        provides: entry.provides,
        runtime: declaration.runtime,
        disabled: !enabled,
      })
      rows.push(row)
      if (resolved.trust === 'builtin') builtinClaims.push(Object.freeze({ row, entry }))
      else
        thirdPartyClaims.push(
          Object.freeze({ row, entry, snapshot: plugin.candidate as NonNullable<typeof plugin.candidate> }),
        )
    }
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    builtinClaims: Object.freeze(builtinClaims),
    thirdPartyClaims: Object.freeze(thirdPartyClaims),
  })
}
