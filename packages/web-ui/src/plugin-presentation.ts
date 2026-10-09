import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'

export const PLUGIN_CATEGORIES = [
  'agent-loop',
  'tools',
  'safety-approval',
  'memory-context',
  'collaboration',
  'integrations',
  'observability',
  'ui',
  'developer',
] as const
export type PluginSurface =
  | 'chat'
  | 'workbench'
  | 'settings'
  | 'approval'
  | 'background'
  | 'page'
  | 'application'
export type PluginProvidedItem = Readonly<{ kind: string; id: string; selected?: boolean; scope?: string }>
/** Ephemeral read-only display data. It never participates in plugin selection or authorization. */
export type PluginPresentation = Readonly<{
  provides: readonly PluginProvidedItem[]
  appearsIn: readonly PluginSurface[]
  available: boolean
}>
export type PluginPurposeItem = PackageInstalledDescriptor | PackageCatalogDescriptor
export function pluginOrigin(item: PluginPurposeItem): string {
  return (
    item.presentation?.origin ??
    (['file', 'local', 'workspace', 'path'].includes(item.source.type) ? 'local-source' : 'third-party')
  )
}
