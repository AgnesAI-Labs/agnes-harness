import type { HostBuiltinRowClaim } from '@agnes/host-extensions/assemble/seams-cordis'
import { withBuiltinCompactionEngines } from '@agnes/host-providers/assemble/compaction-engines'
import { withBuiltinModelAdapters } from '@agnes/host-providers/assemble/model-adapters'
import { buildOrdinaryRows } from '@agnes/host-providers/assemble/ordinary-rows'
import { buildPresetRows } from '@agnes/host-providers/assemble/preset-rows'
import { buildSeamRows } from '@agnes/host-providers/assemble/seam-rows'
import { withBuiltinToolPolicies } from '@agnes/host-providers/assemble/tool-providers'
import type { EntryRow } from '@agnes/plugin-runtime/host'
import { withBuiltinChildAgents } from './child-agents.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { PresetCatalog } from './presets.js'
import type { SeamContexts } from './seam-contexts.js'

/**
 * The rows the Host builds itself, before any plugin target arrives: the ten seams, the presets
 * and the ordinary builtin plugins. This is the one place seams become rows; ordering inside a
 * tree is seam rows after registration rows, and `ext:` rows are added to `builtin` later because
 * they need the managed extension host.
 */
export type BootRows = Readonly<{
  builtSeams: ReturnType<typeof buildSeamRows>
  builtPresets: ReturnType<typeof buildPresetRows>
  builtOrdinary: ReturnType<typeof buildOrdinaryRows>
  /** Row id to the package that supplies the plugin, for composition visibility. */
  compositionOwners: ReadonlyMap<string, string>
  /** Rows a daemon target never names: the Host merges them back into every target. */
  staticBootRows: readonly Readonly<EntryRow>[]
  bootTreeRows: readonly Readonly<EntryRow>[]
  /** What the publisher admits as Host-private: the claims and the Host-owned `ext:` rows, replaced as `ext:` rows change. */
  builtin: {
    claims: readonly Readonly<HostBuiltinRowClaim>[]
    hostExtensionRows: readonly Readonly<EntryRow>[]
  }
}>

export function buildBootRows(
  ctx: AssemblyContext,
  pkgs: PackageSet,
  presets: PresetCatalog,
  seamContexts: SeamContexts,
): BootRows {
  const { deps } = ctx
  const { modules, runtimePackages } = pkgs
  const builtSeams = buildSeamRows({
    ...(deps.generationBuiltinRows ? { generationBuiltinRows: deps.generationBuiltinRows } : {}),
    profile: ctx.profile,
    modules,
    preset: presets.defaultPreset.doc,
    contextFor: (owner, name) => seamContexts.contextFor(owner, name).context,
  })
  const builtPresets = buildPresetRows(presets.presets)
  const ordinaryModules = new Map(modules)
  for (const [id, loaded] of runtimePackages) ordinaryModules.set(id, loaded.module)
  const compositionModules = withBuiltinChildAgents(
    withBuiltinToolPolicies(withBuiltinCompactionEngines(withBuiltinModelAdapters(ordinaryModules))),
  )
  const compositionOwners = new Map(
    [...compositionModules.values()].flatMap((module) =>
      (module.plugins ?? []).map((plugin) => [plugin.declaration.id, module.id] as const),
    ),
  )
  const builtOrdinary = buildOrdinaryRows(ctx.profile, compositionModules, deps.ordinaryPluginLayers)
  const claims: readonly Readonly<HostBuiltinRowClaim>[] = Object.freeze([
    ...builtPresets.builtinClaims,
    ...builtOrdinary.builtinClaims,
    ...builtSeams.builtinClaims,
  ])
  const staticBootRows = Object.freeze(
    [...builtPresets.rows, ...builtOrdinary.rows, ...builtSeams.rows].filter(
      (row) =>
        row.plugin.startsWith('builtin:') || row.id.startsWith('seam:') || row.id.startsWith('preset:'),
    ),
  )
  const bootTreeRows = Object.freeze([...builtPresets.rows, ...builtOrdinary.rows, ...builtSeams.rows])
  return {
    builtSeams,
    builtPresets,
    builtOrdinary,
    compositionOwners,
    staticBootRows,
    bootTreeRows,
    // The Host owns its builtin ext: rows the way it owns seam and preset rows: a daemon target is
    // built from installed packages only and never names them, so they are merged back like
    // staticBootRows. A target that does carry one of these ids wins over this default.
    builtin: { claims, hostExtensionRows: Object.freeze([]) },
  }
}
