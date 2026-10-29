import { HostError } from '@agnes/host-common/errors'
import {
  type HostCapabilityAuthority,
  pinHostCapabilitiesAsync,
} from '@agnes/host-extensions/assemble/host-grants'
import type { LoadedRuntimePackage, PackageModule } from '@agnes/host-extensions/assemble/packages'
import { loadRuntimePackage } from '@agnes/host-extensions/assemble/packages'
import { isolationInventory } from '@agnes/host-providers/assemble/isolation-inventory'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { AssemblyContext } from './context.js'
import { prepareRuntimeSelection } from './runtime-prepare.js'

/** The enabled packages of this assembly, loaded and ready for the stages that read their exports. */
export type PackageSet = Readonly<{
  /** Package id to the directory its exports and bundled extensions are read from. */
  dirs: ReadonlyMap<string, string>
  grants: HostCapabilityAuthority
  modules: Map<string, PackageModule>
  runtimePackages: ReadonlyMap<string, LoadedRuntimePackage>
  runtimePackageIds: ReadonlySet<string>
  activeRuntimeSources: readonly Readonly<RuntimePluginSnapshot>[]
  inventory: ReturnType<typeof isolationInventory>
  /** Loads (once per snapshot) the module a runtime plugin snapshot selects. */
  loadRuntimeModule(source: Readonly<RuntimePluginSnapshot>): Promise<LoadedRuntimePackage | undefined>
}>

/** Step `packages`. Nothing outside the authorised package locations is imported. */
export async function loadPackages(ctx: AssemblyContext): Promise<PackageSet> {
  const { deps, dataDir, profile, refuse } = ctx
  const enabled = profile.packages.filter((p) => p.enabled)
  const runtimeModuleCache = new Map<string, Promise<LoadedRuntimePackage | undefined>>()
  const loadRuntimeModule = (
    source: Readonly<RuntimePluginSnapshot>,
  ): Promise<LoadedRuntimePackage | undefined> => {
    const key = `${source.snapshot.packageId}\0${source.snapshot.snapshotId}`
    const existing = runtimeModuleCache.get(key)
    if (existing) return existing
    if (!deps.extensionLoader) return Promise.resolve(undefined)
    const loading = loadRuntimePackage(source, deps.extensionLoader).catch((error) => {
      runtimeModuleCache.delete(key)
      throw error
    })
    runtimeModuleCache.set(key, loading)
    return loading
  }
  const loadRuntimeSelection = async (
    sources: readonly Readonly<RuntimePluginSnapshot>[],
  ): Promise<Map<string, LoadedRuntimePackage>> => {
    const selected = new Map<string, LoadedRuntimePackage>()
    if (!sources.length) return selected
    if (!deps.extensionLoader) {
      throw new HostError('E_EXT_LOAD', 'runtime plugin snapshots need a module loader', {
        detail: { reason: 'runtime-plugin-loader' },
      })
    }
    return prepareRuntimeSelection(sources, deps, profile.name, loadRuntimeModule)
  }
  const activeRuntimeSources = Object.freeze([...(deps.runtimePluginSnapshots ?? [])])
  const runtimePackageIds = new Set(activeRuntimeSources.map(({ snapshot }) => snapshot.packageId))
  const managedExtensionPackages = new Set(deps.managedExtensionPackageIds ?? [])
  // Resolve every authorized location before importing any module. The supplied map can include
  // cached or disabled packages; neither their exports nor their bundled extensions may run.
  const dirs = new Map<string, string>()
  for (const { id, trust } of enabled) {
    if (dirs.has(id))
      refuse('E_PACKAGE_DUPLICATE', 'multiple enabled entries for one package', { package: id })
    if (trust !== 'builtin' && !runtimePackageIds.has(id))
      throw new HostError('E_EXT_LOAD', 'trusted package has no immutable runtime snapshot', {
        detail: { package: id, reason: 'snapshot-unavailable' },
      })
    const dir = deps.packageDirs === undefined ? dataDir : deps.packageDirs.get(id)
    if (!dir)
      throw new HostError('E_DEP_MISSING', `enabled package ${id} has no package directory`, {
        detail: { package: id },
      })
    dirs.set(id, dir)
  }
  for (const [name, pkg] of Object.entries(profile.seams))
    if (typeof pkg === 'string' && name !== 'platform' && !dirs.has(pkg))
      refuse('E_DEP_MISSING', `seam ${name} names ${pkg}, not enabled`, { seam: name, package: pkg })
  const grants = await pinHostCapabilitiesAsync(
    enabled.filter((pkg) => !runtimePackageIds.has(pkg.id) && !managedExtensionPackages.has(pkg.id)),
    dirs,
    deps.generationBuiltinRows,
  )
  const inventory = isolationInventory(profile, deps, dirs)
  const runtimePackages = await loadRuntimeSelection(activeRuntimeSources)
  const modules = new Map<string, PackageModule>()
  for (const [id, dir] of dirs)
    modules.set(
      id,
      runtimePackages.get(id)?.module ??
        (runtimePackageIds.has(id) || managedExtensionPackages.has(id)
          ? { id, extensionEntry: dir }
          : await deps.loader.importPackage(id, dir)),
    )
  grants.bind(modules)
  deps.onGenerationBasePackages?.(
    [...modules]
      .filter(
        ([, module]) =>
          module.persistenceProvider && module.persistenceProvider.id === profile.persistence?.provider,
      )
      .map(([id]) => id),
  )
  return {
    dirs,
    grants,
    modules,
    runtimePackages,
    runtimePackageIds,
    activeRuntimeSources,
    inventory,
    loadRuntimeModule,
  }
}
