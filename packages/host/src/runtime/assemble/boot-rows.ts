import { assembleDistributionPackages } from '@agnes/distribution'
import { SEAM_KINDS, type SeamKind } from '@agnes/extension-api/seams'
import type { HostBuiltinRowClaim } from '@agnes/host-extensions/assemble/seams-cordis'
import { buildOrdinaryRows } from '@agnes/host-providers/assemble/ordinary-rows'
import { buildPresetRows } from '@agnes/host-providers/assemble/preset-rows'
import { buildSeamBindingRows, type SeamBinding } from '@agnes/host-providers/assemble/seam-rows'
import type { EntryRow } from '@agnes/plugin-runtime/host'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { PresetCatalog } from './presets.js'
import type { SeamContexts } from './seam-contexts.js'

/**
 * The rows the Host builds itself, before any plugin target arrives: the seven seam binding rows, the presets
 * and the ordinary builtin plugins. This is the one place seams become rows; ordering inside a
 * tree is seam rows after registration rows, and `ext:` rows are added to `builtin` later because
 * they need the managed extension host.
 */
export type BootRows = Readonly<{
  builtSeams: ReturnType<typeof buildSeamBindingRows>
  /** What each binding row bound at mount; read after the tree is built. */
  boundSeams(): readonly SeamBinding[]
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
  const bound = new Map<SeamKind, SeamBinding>()
  const builtSeams = buildSeamBindingRows({
    ...(deps.generationBuiltinRows ? { generationBuiltinRows: deps.generationBuiltinRows } : {}),
    profile: ctx.profile,
    selections: Object.fromEntries(SEAM_KINDS.map((kind) => [kind, ctx.profile.seams[kind]])) as Record<
      SeamKind,
      (typeof ctx.profile.seams)[SeamKind]
    >,
    preset: presets.defaultPreset.doc,
    timeoutMs: deps.seamTimeoutMs ?? 30_000,
    initFor: seamContexts.initFor,
    onBound: (binding) => bound.set(binding.kind, binding),
  })
  const builtPresets = buildPresetRows(presets.presets)
  const ordinaryModules = new Map(modules)
  for (const [id, loaded] of runtimePackages) ordinaryModules.set(id, loaded.module)
  const compositionModules = assembleDistributionPackages(ordinaryModules)
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
    boundSeams: () => SEAM_KINDS.flatMap((kind) => bound.get(kind) ?? []),
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
