import { type InstalledInventory, isRuntimePackageEligible } from '@agnes/package-manager'
import { PLUGIN_UI_ENTRIES_MAX_BYTES, type PluginUiEntriesResult, rpcError } from '@agnes/protocol'

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function projectPluginUiEntries(
  profile: string,
  inventory: InstalledInventory,
): PluginUiEntriesResult {
  if (inventory.profile !== profile)
    throw rpcError('CAPABILITY_DENIED', { reason: 'inventory is outside this daemon profile' })
  const entries: PluginUiEntriesResult['entries'] = []
  const packages = inventory.packages.filter(
    (row) =>
      row.uiEntries?.length &&
      row.directory &&
      row.entry.treeIntegrity &&
      row.localFailure === undefined &&
      row.entry.source.type !== 'local' &&
      row.entry.source.type !== 'workspace' &&
      isRuntimePackageEligible(row),
  )
  let bytes = Buffer.byteLength('{"entries":[]}')
  for (const row of packages.sort((a, b) => compare(a.id, b.id))) {
    const declared = row.uiEntries?.toSorted((a, b) => compare(a.rowId, b.rowId) || compare(a.id, b.id))
    if (!declared) continue
    for (const data of declared) {
      const entry = { ...data, packageId: row.id, integrity: row.entry.integrity }
      bytes += Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0)
      if (bytes > PLUGIN_UI_ENTRIES_MAX_BYTES) return { entries }
      entries.push(entry)
      if (entries.length === 128) return { entries }
    }
  }
  return { entries }
}
