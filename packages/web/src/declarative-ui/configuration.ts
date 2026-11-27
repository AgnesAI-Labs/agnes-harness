import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { PluginAdminApi } from '@agnes/web-admin/admin/plugins/api'
import { homeNavigation } from '@agnes/web-client'
import { backendFrame } from '../backends/frame-context.js'
import {
  type PluginUiCard,
  type PluginUiConfigurationLease,
  pluginUiDocument,
  pluginUiEntries,
} from './entries.js'

export const pluginUiConfiguration = pluginUiDocument.configuration

export function matchesUiConfiguration(
  target: PluginUiConfigurationLease['target'],
  profile: string | undefined,
  item: Pick<PackageInstalledDescriptor, 'id' | 'integrity' | 'trusted' | 'desired' | 'blockers'> | undefined,
): boolean {
  return (
    profile === target.profile &&
    item?.id === target.packageId &&
    item.integrity === target.integrity &&
    item.trusted &&
    item.desired === 'enabled' &&
    item.blockers.length === 0
  )
}

export function bindPluginUiConfiguration(navigate: () => void): () => void {
  let generation = 0
  const stopEntries = pluginUiEntries.subscribe(() => {
    const active = pluginUiConfiguration.getSnapshot()
    if (active && !active.isCurrent()) pluginUiConfiguration.set(undefined)
  })
  const stopHome = homeNavigation.subscribe(() => {
    generation++
    pluginUiConfiguration.set(undefined)
  })
  pluginUiDocument.requestConfiguration = async (entry, showing) => {
    // The Cloud frame redirects management to a different backend. Never redirect this bound action.
    if (backendFrame()) return false
    const lease = pluginUiEntries.configuration(entry)
    if (!lease) return false
    const ticket = ++generation
    try {
      // Use a separate request key so this action cannot join or retire a legacy page's read.
      const { context, inventory } = await PluginAdminApi.overview((input, init) => fetch(input, init))
      if (ticket !== generation || !lease.isCurrent() || !showing()) return false
      const item = inventory?.packages.find(({ id }) => id === lease.target.packageId)
      if (
        !context.permissions.includes('packages.read') ||
        !matchesUiConfiguration(lease.target, context.profile, item)
      )
        return false
      navigate()
      pluginUiConfiguration.set(lease)
      return true
    } catch {
      return false
    }
  }
  return () => {
    generation++
    pluginUiDocument.requestConfiguration = undefined
    stopHome()
    stopEntries()
    pluginUiConfiguration.set(undefined)
  }
}

export function requestPluginUiConfiguration(entry: PluginUiCard, showing: () => boolean): Promise<boolean> {
  return pluginUiDocument.requestConfiguration?.(entry, showing) ?? Promise.resolve(false)
}
