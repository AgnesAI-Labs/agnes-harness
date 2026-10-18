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
        const sources =
          (await options.runtimePluginSources?.()) ??
          options.runtimePluginCatalogue ??
          options.runtimePluginSnapshots ??
          []
        const target = host.runtimeTargetSnapshot?.()
        const selected = target ? new RuntimePluginCatalogue(sources).select(target) : sources
        publishModelAdapterCatalog(
          options.profileDir,
          profile().hash,
          conversationModelAdapters(
            host.modelAdapterCatalog(),
            host.provider.models(),
            profile().provider.routes ?? [],
          ),
          selected,
        )
      })
    } catch {
      options.log.warn('Model adapter display catalog could not be published')
    }
  }
}
