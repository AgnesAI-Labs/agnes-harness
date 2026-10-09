import { PluginAdminPage, type PluginAdminOptions } from './admin/page.js'

export type PluginAdminMount = Readonly<{
  ready: Promise<void>
  reload(): Promise<void>
  dispose(): void
}>

/**
 * Binds the plugin admin surface to markup already present in the current document.
 * Importing this module never touches the DOM; the host decides when to mount.
 */
export function mountPluginAdmin(options: PluginAdminOptions = {}): PluginAdminMount {
  const page = new PluginAdminPage(options)
  page.bind()
  const ready = page.start()
  return { ready, reload: () => page.refresh(), dispose: () => page.dispose() }
}
