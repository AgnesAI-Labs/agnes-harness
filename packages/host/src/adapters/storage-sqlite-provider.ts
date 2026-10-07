import { join } from 'node:path'
import type { StorageAdapter } from '@agnes/core'
import {
  DEFAULT_PERSISTENCE_PROVIDER_ID,
  definePersistenceProvider,
  PERSISTENCE_EFFECT,
  type PersistenceProvider,
  type PersistenceSessionStore,
} from '@agnes/extension-api'
import { createSqliteStorage, type TableStore } from './storage-sqlite.js'

/**
 * Official SQLite provider. Its ledger, metadata, child-control and recovery resources are
 * exposed through the same public capability ports as every other provider.
 */
export const sqlitePersistenceProvider: PersistenceProvider = definePersistenceProvider({
  id: DEFAULT_PERSISTENCE_PROVIDER_ID,
  version: '1.0.0',
  state: { effect: PERSISTENCE_EFFECT },
  capabilities: {
    ledger: true,
    metadata: true,
    childControl: true,
    reclaim: true,
    integrity: true,
    sqlite: true,
  },
  open(options) {
    const storage = createSqliteStorage({
      file: join(options.dataDir, 'sessions.db'),
      tablesDir: join(options.dataDir, 'tables'),
      ...(options.clock ? { clock: options.clock } : {}),
    })
    return {
      open: storage.open,
      commit: (key, tx) => storage.commit(key, tx as Parameters<StorageAdapter['commit']>[1]),
      renew: storage.renew,
      release: storage.release,
      scan: storage.scan,
      registers: storage.registers,
      scanIntegrity: storage.scanIntegrity,
      createChild: storage.createChild,
      discardNewSession: storage.discardNewSession,
      close: storage.close,
      childControl: storage,
      reclaim: storage.crashReclaim,
      sqlite: { dialect: 'sqlite', tables: storage.tables },
      metadata: sqliteMetadata(storage.tables),
    } satisfies PersistenceSessionStore
  },
})

function sqliteMetadata(
  tables: (owner: string) => TableStore,
): import('@agnes/extension-api').PersistenceMetadataPort {
  return {
    namespace(owner, name) {
      const table = tables(owner).table('persistence_kv')
      table.exec(
        'CREATE TABLE IF NOT EXISTS persistence_kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key))',
      )
      return {
        get(key) {
          const row = table.get<{ value: string }>(
            'SELECT value FROM persistence_kv WHERE namespace = ? AND key = ?',
            [name, key],
          )
          return row ? JSON.parse(row.value) : undefined
        },
        set(key, value) {
          const json = JSON.stringify(value)
          if (json === undefined) throw new TypeError('metadata value must be JSON serializable')
          table.run(
            'INSERT INTO persistence_kv (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value',
            [name, key, json],
          )
        },
        delete(key) {
          table.run('DELETE FROM persistence_kv WHERE namespace = ? AND key = ?', [name, key])
        },
        entries() {
          return table
            .all<{ key: string; value: string }>(
              'SELECT key, value FROM persistence_kv WHERE namespace = ? ORDER BY key',
              [name],
            )
            .map((row) => ({ key: row.key, value: JSON.parse(row.value) }))
        },
        transaction(fn) {
          return table.transaction(() => {
            const result = fn()
            if (result && typeof (result as { then?: unknown }).then === 'function')
              throw new TypeError('metadata transaction callback must be synchronous')
            return result
          })
        },
      }
    },
  }
}
