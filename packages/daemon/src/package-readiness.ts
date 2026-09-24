export type PackageReadinessClass = 'mixed' | 'surface-only' | 'client-only' | 'extension-only'

export type PackageContributionInput = Readonly<{
  kind: string
  client?: unknown
  /** Any non-UI capability needs a backend activation lane before browser publication. */
  capabilities?: Readonly<Record<string, unknown>>
}>

export function classifyPackageContributions(
  contributions: readonly PackageContributionInput[],
  hasBackendRows = false,
): PackageReadinessClass {
  const hasSurface = contributions.some((row) => row.kind === 'surface')
  const hasExtension =
    hasBackendRows || contributions.some((row) => row.kind === 'extension' || row.kind === 'client')
  const clientOnly =
    hasExtension &&
    !hasBackendRows &&
    !hasSurface &&
    contributions.every(
      (row) =>
        row.kind === 'extension' &&
        row.client !== undefined &&
        Object.keys(row.capabilities ?? {}).every((capability) => capability === 'ui'),
    )
  if (hasSurface && hasExtension) return 'mixed'
  if (hasSurface && !hasExtension) return 'surface-only'
  if (clientOnly) return 'client-only'
  return 'extension-only'
}

export type PackageReadinessInput = Readonly<{
  class: PackageReadinessClass
  desiredPublished: boolean
  treeQualified: boolean
  extensionRowsActive: boolean
  surfaceRunningRevision?: string
  desiredSurfaceRevision?: string
  clientRosterMatch: boolean
}>

/**
 * Task 16 actual classes:
 * - mixed: qualified report plus this package's ext rows active and Surface running revision match
 * - surface-only: desired already probed/published and driver running revision matches; no worker wait
 * - client-only: current desired snapshot matches client roster; late notices cannot mark ready
 * - extension-only: tree-qualified report.ok
 */
/**
 * A report row carries only its id, so ownership by id alone is a naming convention: a plugin the
 * manifest gave an id of its own does not follow it. `ownedRowIds` are the ids of the rows the tree
 * loads from this package's snapshots, which is what really ties a row to its package.
 */
export function packageOwnsReportRow(
  packageId: string,
  rowId: string,
  ownedRowIds?: ReadonlySet<string>,
): boolean {
  return (
    ownedRowIds?.has(rowId) === true ||
    rowId === packageId ||
    rowId.startsWith(`${packageId}/`) ||
    rowId.startsWith(`ext:${packageId}/`)
  )
}

/** Empty or disabled-only matches are not active. */
export function packageExtensionRowsActive(
  packageId: string,
  rows: readonly Readonly<{ id: string; state: string }>[],
  ownedRowIds?: ReadonlySet<string>,
): boolean {
  const matched = rows.filter((row) => packageOwnsReportRow(packageId, row.id, ownedRowIds))
  return matched.length > 0 && matched.every((row) => row.state === 'active')
}

/**
 * Whether nothing of this package is running or on its way: every row it owns in the report is
 * disabled, or it owns none at all (never enabled, or dropped from the desired tree).
 * `pending`, `loading`, `failed` and `waiting-drain` rows are not stopped.
 */
export function packageExtensionRowsStopped(
  packageId: string,
  rows: readonly Readonly<{ id: string; state: string }>[],
  ownedRowIds?: ReadonlySet<string>,
): boolean {
  return rows.every(
    (row) => !packageOwnsReportRow(packageId, row.id, ownedRowIds) || row.state === 'disabled',
  )
}

export function packageActualReady(input: PackageReadinessInput): boolean {
  if (!input.desiredPublished) return false
  switch (input.class) {
    case 'mixed':
      return (
        input.treeQualified &&
        input.extensionRowsActive &&
        input.surfaceRunningRevision !== undefined &&
        input.surfaceRunningRevision === input.desiredSurfaceRevision
      )
    case 'surface-only':
      return (
        input.surfaceRunningRevision !== undefined &&
        input.surfaceRunningRevision === input.desiredSurfaceRevision
      )
    case 'client-only':
      return input.clientRosterMatch
    case 'extension-only':
      return input.treeQualified && input.extensionRowsActive
  }
}
