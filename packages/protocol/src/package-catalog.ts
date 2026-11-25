import type { PackageCatalogPage } from '../gen/ts/package-admin.js'

/** Check the negotiated indexed shape after the catalog page has passed structural validation. */
export function validatePackageCatalogSnapshotVersion(page: PackageCatalogPage, version: 2 | 3): boolean {
  return (
    page.communityIndex?.items.every(
      (item) => item.versions?.every((release) => 'compatibility' in release === (version === 3)) ?? true,
    ) ?? true
  )
}
