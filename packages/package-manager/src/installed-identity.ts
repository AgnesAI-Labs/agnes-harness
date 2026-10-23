import type { ExtensionManifest } from '@agnes/extension-api'
import { PackageError } from './errors.js'
import type { LockEntry } from './lockfile.js'
import { readPackageJson } from './package-record.js'

export function verifyInstalledIdentity(
  id: string,
  entry: LockEntry,
  dir: string,
  manifest: ExtensionManifest | undefined,
): void {
  const pkg = readPackageJson(dir)
  if (
    pkg.name !== id ||
    pkg.version !== entry.version ||
    (manifest !== undefined && (manifest.id !== id || manifest.version !== entry.version))
  )
    throw new PackageError('E_LOCK_MISMATCH', `${id} installed identity differs from the lockfile`, {
      detail: { id, reason: 'identity' },
    })
}
