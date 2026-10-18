import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AdminModelAdapter, isAdminModelAdapter } from '@agnes/protocol'
import { publishFileDurablySync } from '@agnes/system-node'
import { canonical, readStaticJson } from './integrity.js'
import type { RuntimePluginSnapshot } from './package-plugin-loader.js'

const fileName = '.agnes-published-model-adapters.json'
type Entry = AdminModelAdapter
const identity = ({ snapshot }: RuntimePluginSnapshot) => ({
  packageId: snapshot.packageId,
  snapshotId: snapshot.snapshotId,
  version: snapshot.version,
  integrity: snapshot.integrity,
  treeIntegrity: snapshot.treeIntegrity,
  capabilityHash: snapshot.capabilityHash,
})

/** A display projection from an assembled Host, never an admission token or executable cache.
 * Bind community registration metadata to the exact verified code which produced it. */
export function publishModelAdapterCatalog(
  profileDir: string,
  profileHash: string,
  adapters: readonly Entry[],
  sources: readonly RuntimePluginSnapshot[],
): void {
  const entries = adapters.flatMap((adapter) => {
    const source = sources.find((s) => s.trusted && s.snapshot.packageId === adapter.sourcePackage)
    return source ? [{ adapter, source: identity(source) }] : []
  })
  publishFileDurablySync(join(profileDir, fileName), JSON.stringify({ version: 1, profileHash, entries }), {
    replace: true,
  })
}

/** Caller supplies freshly verified sources for THIS query. Recheck trust and exact bindings on
 * every request; stale, missing or corrupt projections offer no community adapter. Offered model
 * ids/routes belong to this exact published profile. Real execution repeats Host admission. */
export function readPublishedModelAdapters(
  profileDir: string,
  profileHash: string,
  sources: readonly RuntimePluginSnapshot[],
): readonly Entry[] {
  try {
    const file = join(profileDir, fileName)
    if (lstatSync(file).isSymbolicLink()) return []
    const value = readStaticJson(file)
    if (value.version !== 1 || value.profileHash !== profileHash || !Array.isArray(value.entries)) return []
    const current = new Set(
      sources.filter((s) => s.trusted && s.enabled !== false).map((s) => canonical(identity(s))),
    )
    const entries: Entry[] = []
    for (const row of value.entries) {
      if (!row || typeof row !== 'object' || !isAdminModelAdapter(row.adapter)) return []
      if (row.adapter.sourcePackage !== row.source?.packageId) return []
      if (current.has(canonical(row.source))) entries.push(row.adapter)
    }
    // Do not accept a file replaced during the read.
    if (readFileSync(file, 'utf8') !== JSON.stringify(value)) return []
    return entries
  } catch {
    return []
  }
}
