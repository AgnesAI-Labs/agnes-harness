import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { conversationModelAdapters } from '@agnes/host-infrastructure/admin-session-selection'
import { RuntimePluginCatalogue } from '@agnes/host-providers/runtime-plugin-catalogue'
import { publishModelAdapterCatalog, withoutPackageVerification } from '@agnes/package-manager'
import type { Host, HostOptions } from '../lifecycle/host.js'

/** Publish only the head's registered display data, bound to the exact selected source versions.
 * Display publication never rolls back execution or authorizes it. */
export function modelCatalogPublisher(host: Host, options: HostOptions, profile: () => ResolvedProfile) {
  return async () => {
    try {
      await withoutPackageVerification(async () => {
        const current = profile()
        const adapters = conversationModelAdapters(
          host.modelAdapterCatalog(),
          host.provider.models(),
          current.provider.routes ?? [],
        )
        // Builtin adapters are described from the installation itself. An empty community
        // projection must still replace an older file, but needs no unrelated plugin tree scan.
        const community = adapters.some(
          (adapter) =>
            !current.packages.some((pkg) => pkg.id === adapter.sourcePackage && pkg.trust === 'builtin'),
        )
        const sources =
          (community ? await options.runtimePluginSources?.() : []) ??
          options.runtimePluginCatalogue ??
          options.runtimePluginSnapshots ??
          []
        const target = community ? host.runtimeTargetSnapshot?.() : undefined
        const selected = community && target ? new RuntimePluginCatalogue(sources).select(target) : sources
        publishModelAdapterCatalog(options.profileDir, current.hash, adapters, selected)
      })
    } catch {
      options.log.warn('Model adapter display catalog could not be published')
    }
  }
}
