import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { type AdminModelAdapter, isAdminModelAdapter } from '@agnes/protocol'
import { publishFileDurablySync } from '@agnes/system-node'
import { canonical } from './integrity.js'
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
  let handle: number | undefined
  try {
    const file = join(profileDir, fileName)
    const initial = lstatSync(file)
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 1048576) return []
    handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!sameFile(initial, fstatSync(handle))) return []
    const bytes = Buffer.alloc(initial.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(handle, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length !== initial.size) return []
    const text = bytes.subarray(0, length).toString('utf8')
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
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
    if (
      text !== JSON.stringify(value) ||
      !sameFile(initial, fstatSync(handle)) ||
      !sameFile(initial, lstatSync(file))
    )
      return []
    return entries
  } catch {
    return []
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

/** lstat on the pathname must still identify the regular file we opened without following links. */
function sameFile(before: Stats, after: Stats): boolean {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}
