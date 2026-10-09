import { HostError } from '@agnes/host-common/errors'
import { mergeValue } from '@agnes/host-common/presets/merge'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { loadRuntimePackage } from '@agnes/host-extensions/assemble/packages'
import type { HostOptions } from '../host.js'

/** Read authorized package exports before choosing providers. No plugin is mounted by this pass. */
export async function compositionPresets(
  profile: ResolvedProfile,
  options: HostOptions,
): Promise<Record<string, PresetDoc>> {
  if (!options.loader) throw new HostError('E_DEP_MISSING', 'createHost needs a package loader')
  const presets: Record<string, PresetDoc> = {}
  for (const pkg of profile.packages.filter((pkg) => pkg.enabled)) {
    const source = options.runtimePluginSnapshots?.find((source) => source.snapshot.packageId === pkg.id)
    const module =
      pkg.trust === 'builtin'
        ? await options.loader.importPackage(pkg.id, options.packageDirs?.get(pkg.id) ?? options.dataDir)
        : source && options.extensionLoader
          ? (await loadRuntimePackage(source, options.extensionLoader))?.module
          : undefined
    for (const [name, doc] of Object.entries(module?.presets ?? {})) {
      if (presets[name]) throw new HostError('E_DEP_MISSING', `duplicate preset ${name}`)
      presets[name] = doc
    }
  }
  for (const [name, doc] of Object.entries(profile.bundlePresets ?? {}))
    presets[name] = mergeValue(presets[name], doc) as PresetDoc
  return presets
}
