import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'

export type Text = (key: string, params?: Record<string, string | number>) => string
export type Plugin = PackageInstalledDescriptor | PackageCatalogDescriptor
