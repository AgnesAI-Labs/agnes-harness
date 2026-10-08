// Minimal SQL table handle contract. This package does not talk to SQLite directly: everything in
// storage/ and lease/ goes through a `TableHandle`, which is either a real handle a host adapter
// hands the daemon, or the sqlite-backed test double in test/sqlite-tables.ts. Nothing here imports
// node:sqlite or any host package.
export interface TableHandle {
  exec(sql: string, params?: unknown[]): void
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  transaction<T>(fn: () => T): T
}

/** A store that hands out one `TableHandle` per named table and can be closed as a whole. */
export type Tables = {
  table(name: string): TableHandle
  close(): Promise<void>
}

/** Idempotent table creation: run once per handle construction, safe to call every time. */
export function ensure(t: TableHandle, ddl: string): void {
  t.exec(ddl)
}
