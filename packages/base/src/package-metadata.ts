import type { PersistenceMetadataNamespace } from '@agnes/extension-api'
import type { SeamAdaptersView, TableHandle } from './seam-init.js'

/** Legacy embedders can still supply SQL. Full Host defaults consume owner-scoped KV. */
export function packageStorage(
  storage: SeamAdaptersView['storage'],
  name: string,
  legacy?: { select: string; key(row: Record<string, unknown>): string },
): PersistenceMetadataNamespace | TableHandle {
  if (!storage.namespace) return storage.table(name)
  const ns = storage.namespace(name)
  const sql = storage.sql
  if (legacy && sql)
    ns.transaction(() => {
      if (ns.get('migration') === 1) return
      const table = sql.table(name)
      const exists = table.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name])
      if (exists) for (const row of table.all(legacy.select)) ns.set(`row:${legacy.key(row)}`, row)
      ns.set('migration', 1)
    })
  return ns
}
