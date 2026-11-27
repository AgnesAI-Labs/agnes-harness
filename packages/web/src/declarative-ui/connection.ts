import type { Client } from '@agnes/sdk/browser'
import { coalesceBurst } from '../refresh-coordinator.js'
import { PLUGIN_UI_ENTRIES_METHOD, pluginUiEntries } from './entries.js'

type PackageNotice = Readonly<{ profile?: unknown; packageId?: unknown; reason?: unknown }>

export function bindPluginUiConnection(client: Pick<Client, 'config' | 'call'>, connected: () => boolean) {
  let profile = ''
  let epoch = 0
  const read = (profile: string) => client.call(PLUGIN_UI_ENTRIES_METHOD, { profile })
  const notices = coalesceBurst(() => void pluginUiEntries.refresh(read), 100)
  const disconnect = () => {
    epoch++
    profile = ''
    pluginUiEntries.setScope(false, '')
  }
  return {
    async readProfile() {
      const ticket = epoch
      const snapshot = await client.config.get()
      if (connected() && ticket === epoch && snapshot.profile !== profile) {
        profile = snapshot.profile
        pluginUiEntries.setScope(true, profile)
        void pluginUiEntries.refresh(read)
      }
      return snapshot
    },
    packagesChanged(detail: PackageNotice | undefined) {
      if (detail?.reason === 'resources' || !profile || detail?.profile !== profile) return
      pluginUiEntries.packageChanged(typeof detail.packageId === 'string' ? detail.packageId : undefined)
      notices.request()
    },
    disconnect,
    close() {
      notices.stop()
      disconnect()
    },
  }
}

export function watchPluginUiSidebar(update: () => void) {
  let selection = pluginUiEntries.getSnapshot().sidebar
  return pluginUiEntries.subscribe(() => {
    const next = pluginUiEntries.getSnapshot().sidebar
    if (next === selection) return
    selection = next
    update()
  })
}
