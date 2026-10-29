import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'

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
/** Comes from the release's bundled set, whether it is a default helper or an optional package. */
export const isBundledPlugin = (item: PluginPurposeItem): boolean =>
  item.presentation?.origin === 'official' && item.source.ref.startsWith('file:./bundled-plugins/')
/** Ships with the product: a default bundled helper, never offered for removal. */
export const isBuiltinPlugin = (item: PluginPurposeItem): boolean =>
  isBundledPlugin(item) && item.presentation?.optional !== true
/** Where a plugin comes from, as the row's source badge names it. */
export function pluginOrigin(item: PluginPurposeItem): string {
  if (isBundledPlugin(item)) return isBuiltinPlugin(item) ? 'builtin' : 'official'
  const provenance = 'provenance' in item ? item.provenance : undefined
  if (provenance) {
    if (provenance.signatureVerified && provenance.verification === 'official-ed25519') return 'official'
    if (provenance.authoring) return 'local'
    return ['file', 'local', 'workspace', 'path'].includes(provenance.source.type)
      ? 'local-source'
      : 'third-party'
  }
  // Catalogs have no installed provenance yet; the backend projects their source identity.
  return (
    item.presentation?.origin ??
    (['file', 'local', 'workspace', 'path'].includes(item.source.type) ? 'local-source' : 'third-party')
  )
}
