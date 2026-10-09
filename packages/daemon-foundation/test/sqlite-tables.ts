// Test-only `Tables` fixture. Production `TableHandle` instances come from a host storage adapter;
// this file exists so daemon's own tests can exercise storage/ and lease/ against a real SQLite
// engine without depending on that adapter. All tables in a given `sqliteTables()` call share one
// `DatabaseSync` connection, matching how a host adapter hands out per-package connections: multiple
// `table(name)` calls on the same `Tables` see each other's writes.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { TableHandle, Tables } from '../src/storage/table.js'

export function sqliteTables(path = ':memory:'): Tables {
  const db = new DatabaseSync(path)
  // WAL is a no-op on ':memory:' but harmless; real test files (non-':memory:' paths) get the same
  // journal mode daemon runs under in production, so tests don't exercise a different write path.
  db.exec('PRAGMA journal_mode = WAL')
  let closed = false
  const handle: TableHandle = {
    exec: (sql, params = []) => {
      db.prepare(sql).run(...(params as SQLInputValue[]))
    },
    get: <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined,
    all: <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as SQLInputValue[])) as T[],
    transaction: <T>(fn: () => T): T => {
      db.exec('BEGIN')
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
  return {
    // One shared connection, one handle: every table name resolves to the same handle so all tables
    // opened through this `Tables` participate in the same transaction and see each other's writes,
    // same as a single-file SQLite connection always does regardless of how many tables it holds.
    table: () => handle,
    close: async () => {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
