import type { PackageCatalogDescriptor } from '@agnes/protocol'

/** Stable ordering and literal metadata search shared by catalog reads. No acquisition ports. */
export function sortCatalog(entries: readonly PackageCatalogDescriptor[]): PackageCatalogDescriptor[] {
  return [...entries].sort((left, right) => {
    const a = `${left.id}\u0000${left.version}\u0000${left.sourceId}`
    const b = `${right.id}\u0000${right.version}\u0000${right.sourceId}`
    return a < b ? -1 : a > b ? 1 : 0
  })
}

export function queryCatalog(entries: readonly PackageCatalogDescriptor[], query?: string) {
  const needle = query?.toLowerCase()
  return sortCatalog(entries).filter((entry) => {
    if (!needle) return true
    const metadata = entry.metadata
    return [
      entry.id,
      metadata?.displayName,
      metadata?.summary,
      ...Object.values(metadata?.locales ?? {}).flatMap((value) => [value.displayName, value.summary]),
      ...entry.contributions.map((value) => value.id),
      ...(entry.presentation?.rows ?? []).flatMap((row) => [
        row.id,
        row.metadata?.displayName,
        row.metadata?.summary,
        ...Object.values(row.metadata?.locales ?? {}).flatMap((value) => [value.displayName, value.summary]),
      ]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle)
  })
}
