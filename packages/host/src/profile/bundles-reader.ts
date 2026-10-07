import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultVerifyIntegrity, packageDir, type Lockfile } from '@agnes/package-manager'
import { parsePackageBundles, type BundleCatalog } from './composition.js'

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
