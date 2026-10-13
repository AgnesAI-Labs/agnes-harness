import { type PluginAdminOptions, PluginAdminPage } from './admin/page.js'

export type { PluginAdminOptions, PluginAdminViewContext } from './admin/page.js'
export type { PluginPageSurface } from './admin/surface.js'
export { pluginNotice } from './admin/views.js'
/** What the workbench lends a plugin controller; a page surface adds only where to draw. */
export type PluginAdminSources = Omit<PluginAdminOptions, 'surface'>

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
