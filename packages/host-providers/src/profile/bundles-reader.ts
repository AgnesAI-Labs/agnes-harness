import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BundleCatalog, parsePackageBundles } from '@agnes/host-common/profile/composition'
import {
  defaultVerifyIntegrity,
  defaultVerifyIntegrityAsync,
  type Lockfile,
  packageDir,
  type RuntimePluginSnapshot,
  verifiedDirectoryDigestAsync,
} from '@agnes/package-manager'

/** Read only enabled, trusted package data; never import a bundle's executable entry. */
export function readInstalledBundles(lock: Lockfile, dataDir: string, profile: string): BundleCatalog {
  const catalog: Record<string, BundleCatalog[string]> = Object.create(null)
  const verify = defaultVerifyIntegrity(dataDir, profile)
  for (const [id, entry] of Object.entries(lock.packages)) {
    if (!entry.state.enabled || entry.state.trusted === null || entry.source.type === 'workspace') continue
    const file = join(packageDir(dataDir, profile, id), 'package.json')
    if (!existsSync(file)) continue
    verify(id, entry)
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { agnes?: { bundles?: unknown } }
    Object.assign(catalog, parsePackageBundles(id, pkg.agnes?.bundles))
  }
  return Object.freeze(catalog)
}

/** Same installed identity checks as the offline reader, without blocking the daemon on file IO. */
export async function readInstalledBundlesAsync(
  lock: Lockfile,
  dataDir: string,
  profile: string,
): Promise<BundleCatalog> {
  const catalog: Record<string, BundleCatalog[string]> = Object.create(null)
  const verify = defaultVerifyIntegrityAsync(dataDir, profile)
  for (const [id, entry] of Object.entries(lock.packages)) {
    if (!entry.state.enabled || entry.state.trusted === null || entry.source.type === 'workspace') continue
    const file = join(packageDir(dataDir, profile, id), 'package.json')
    if (!existsSync(file)) continue
    await verify(id, entry)
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { agnes?: { bundles?: unknown } }
    Object.assign(catalog, parsePackageBundles(id, pkg.agnes?.bundles))
  }
  return Object.freeze(catalog)
}

/** Inspect the selected immutable sources at new-session admission, including hot-installed bundles. */
export async function readRuntimeBundles(sources: readonly RuntimePluginSnapshot[]): Promise<BundleCatalog> {
  const catalog: Record<string, BundleCatalog[string]> = Object.create(null)
  for (const source of sources) {
    const { snapshot } = source
    if (
      !source.trusted ||
      (await verifiedDirectoryDigestAsync(snapshot.directory, snapshot)) !== snapshot.treeIntegrity
    )
      throw new Error('E_COMPOSITION_BUNDLE_INTEGRITY: bundle source is not verified')
    const pkg = JSON.parse(readFileSync(join(snapshot.directory, 'package.json'), 'utf8')) as {
      agnes?: { bundles?: unknown }
    }
    Object.assign(catalog, parsePackageBundles(snapshot.packageId, pkg.agnes?.bundles))
  }
  return Object.freeze(catalog)
}
