import { satisfiesApiRange } from '@agnes/extension-api'
import type { PackageBlocker, PackagePreview, PluginMetadata } from '@agnes/protocol'
import type { InstalledPackage } from './inventory.js'

/** Metadata describes a runtime prerequisite, never permission to install or trust another package. */
export function exampleParentBlockers(
  entry: { metadata?: PluginMetadata; dependencies: Readonly<Record<string, string>> },
  packages: readonly InstalledPackage[],
  seen = new Set<string>(),
): PackageBlocker[] {
  const parentId = entry.metadata?.exampleOf
  if (!parentId) return []
  const parent = packages.find((row) => row.id === parentId)
  const range = entry.dependencies[parentId]
  if (
    seen.has(parentId) ||
    !parent ||
    !parent.enabled ||
    !parent.trusted ||
    parent.blockers.length ||
    !range ||
    !satisfiesApiRange(range, parent.entry.version)
  )
    return [{ code: 'dependency', references: ['example-parent-unavailable', parentId] }]
  seen.add(parentId)
  return exampleParentBlockers(parent.entry, packages, seen).length
    ? [{ code: 'dependency', references: ['example-parent-unavailable', parentId] }]
    : []
}

export function previewWithExampleParent(
  preview: PackagePreview,
  packages: () => readonly InstalledPackage[],
): PackagePreview {
  if (!preview.metadata?.exampleOf) return preview
  return { ...preview, blockers: [...preview.blockers, ...exampleParentBlockers(preview, packages())] }
}
