import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'

const FAMILIES: Readonly<Record<string, { featured: boolean }>> = {
  showcase: { featured: true },
}

/** Discovery hints only: source families never confer trust or launch authority. */
export function exampleDiscovery(row: Pick<PackageCatalogDescriptor, 'source'>) {
  const family =
    row.source?.type === 'file'
      ? /^file:\.\/(?:bundled-)?examples\/([a-z][a-z0-9-]*)\/[^/]+$/.exec(row.source.ref)?.[1]
      : undefined
  return { family, featured: family !== undefined && FAMILIES[family]?.featured === true }
}

/** Keep installed agents reachable; only showcase examples are advertised before installation. */
export function discoverableAgent(
  row: PackageCatalogDescriptor,
  installed: readonly PackageInstalledDescriptor[] = [],
): boolean {
  const discovery = exampleDiscovery(row)
  return !discovery.family || discovery.featured || installed.some((entry) => entry.id === row.id)
}
