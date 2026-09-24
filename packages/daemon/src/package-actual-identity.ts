import type { InstalledPackage } from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact, type RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'

/**
 * The identity of the package the worker is ACTUALLY running, read from the last target the worker
 * applied and acknowledged (`lastGood`), not from the installed inventory.
 *
 * The inventory entry describes what is installed. After a failed update, or right after a
 * rollback, that is not what runs, and reporting it as `actual*` made the admin page show the broken
 * release as running and offer to roll back to it.
 *
 * A package's rows name their snapshot as `<packageId>@<snapshotId>/<export>`, and the snapshot id is
 * the installed integrity (`installedRuntimeSnapshotId`). The version is not in the row, so it is
 * looked up among the identities this package is known to have had; if none matches it is left out
 * rather than guessed.
 */
export function runningPackageIdentity(
  input: Readonly<{
    lastGood: RuntimeTargetArtifact | undefined
    packageId: string
    pkg: InstalledPackage | undefined
  }>,
): Readonly<{ integrity: string; version?: string }> | undefined {
  if (!input.lastGood) return undefined
  const prefix = `${input.packageId}@`
  const rows = decodeRuntimeTargetArtifact(input.lastGood).tree.rows
  for (const row of rows) {
    if (!row.plugin.startsWith(prefix)) continue
    const rest = row.plugin.slice(prefix.length)
    const slash = rest.lastIndexOf('/')
    if (slash <= 0) continue
    const integrity = rest.slice(0, slash)
    const known =
      input.pkg?.entry.integrity === integrity
        ? input.pkg.entry.version
        : input.pkg?.verifiedRollbackTarget?.integrity === integrity
          ? input.pkg.verifiedRollbackTarget.version
          : undefined
    return Object.freeze({ integrity, ...(known === undefined ? {} : { version: known }) })
  }
  return undefined
}
