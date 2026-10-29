import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'

export class OwnedStoreError extends Error {
  constructor(readonly code: 'INVALID' | 'CONFLICT' | 'QUOTA' | 'CLOSED') {
    super(code)
  }
}
export function createOwnedStore(database: DatabaseSync, namespace: string, quotaBytes = 256 * 1024 * 1024) {
  if (!namespace || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new OwnedStoreError('INVALID')
  database.exec(`CREATE TABLE IF NOT EXISTS managed_owned_rows (
    namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, revision TEXT NOT NULL,
    bytes INTEGER NOT NULL, PRIMARY KEY(namespace,key));
    CREATE TABLE IF NOT EXISTS managed_owned_version(namespace TEXT PRIMARY KEY, version INTEGER NOT NULL);`)
  let active = false
  function key(value: string, allowEmpty = false): void {
    if (
      typeof value !== 'string' ||
      (!allowEmpty && !value) ||
      Buffer.byteLength(value) > 512 ||
      Array.from(value).some((char) => {
        const n = char.codePointAt(0) ?? 0
        return n < 32 || (n >= 127 && n <= 159)
      })
    )
      throw new OwnedStoreError('INVALID')
  }
  const get = (name: string) => {
    key(name)
    const row = database
      .prepare('SELECT value,revision FROM managed_owned_rows WHERE namespace=? AND key=?')
      .get(namespace, name)
    return row
      ? { value: JSON.parse(String(row.value)) as JsonValue, revision: String(row.revision) }
      : undefined
  }
  return {
    async transaction<T>(
      fn: (tx: {
        get: typeof get
        put(key: string, value: JsonValue, expectedRevision: string | null): void
        remove(key: string, expectedRevision: string): void
      }) => T,
    ): Promise<T> {
      if (active) throw new OwnedStoreError('CONFLICT')
      active = true
      try {
        database.exec('BEGIN IMMEDIATE')
      } catch (error) {
        active = false
        throw error
      }
      let live = true
      let changed = false
      const assert = () => {
        if (!live) throw new OwnedStoreError('CLOSED')
      }
      try {
        const result = fn({
          get(name) {
            assert()
            return get(name)
          },
          put(name, value, expected) {
            assert()
            changed = true
            key(name)
            const previous = get(name)
            if ((previous?.revision ?? null) !== expected) throw new OwnedStoreError('CONFLICT')
            const checked = inspectJsonData(value, 128 * 1024)
            if (!checked.ok) throw new OwnedStoreError('INVALID')
            const json = JSON.stringify(checked.value)
            database
              .prepare(`INSERT INTO managed_owned_rows VALUES(?,?,?,?,?) ON CONFLICT(namespace,key)
              DO UPDATE SET value=excluded.value, revision=excluded.revision, bytes=excluded.bytes`)
              .run(namespace, name, json, randomUUID(), Buffer.byteLength(name) + Buffer.byteLength(json))
          },
          remove(name, expected) {
            assert()
            changed = true
            if (get(name)?.revision !== expected) throw new OwnedStoreError('CONFLICT')
            database
              .prepare('DELETE FROM managed_owned_rows WHERE namespace=? AND key=?')
              .run(namespace, name)
          },
        })
        if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
          void Promise.resolve(result).catch(() => undefined)
          throw new OwnedStoreError('INVALID')
        }
        const total = database
          .prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM managed_owned_rows WHERE namespace=?')
          .get(namespace)
        if (Number(total?.bytes) > quotaBytes) throw new OwnedStoreError('QUOTA')
        if (changed)
          database
            .prepare(
              `INSERT INTO managed_owned_version VALUES(?,1) ON CONFLICT(namespace) DO UPDATE SET version=version+1`,
            )
            .run(namespace)
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      } finally {
        live = false
        active = false
      }
    },
    async scan(input: { prefix: string; limit: number; cursor?: string }) {
      key(input.prefix, true)
      if (active || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
        throw new OwnedStoreError('INVALID')
      database.exec('BEGIN')
      try {
        const version =
          database.prepare('SELECT version FROM managed_owned_version WHERE namespace=?').get(namespace)
            ?.version ?? 0
        let after = ''
        if (input.cursor) {
          try {
            if (input.cursor.length > 4096) throw new Error()
            const cursor: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
            if (
              !Array.isArray(cursor) ||
              cursor.length !== 4 ||
              cursor[0] !== namespace ||
              cursor[1] !== input.prefix ||
              cursor[2] !== version ||
              typeof cursor[3] !== 'string'
            )
              throw new Error()
            after = cursor[3]
            key(after)
          } catch {
            throw new OwnedStoreError('CONFLICT')
          }
        }
        const rows = database
          .prepare(`SELECT key,value,revision FROM managed_owned_rows
        WHERE namespace=? AND substr(key,1,length(?))=? AND key>? ORDER BY key LIMIT ?`)
          .all(namespace, input.prefix, input.prefix, after, input.limit + 1)
        const page = rows.slice(0, input.limit).map((r) => ({
          key: String(r.key),
          value: JSON.parse(String(r.value)) as JsonValue,
          revision: String(r.revision),
        }))
        const last = page.at(-1)
        return {
          rows: page,
          ...(rows.length > input.limit && last
            ? {
                nextCursor: Buffer.from(
                  JSON.stringify([namespace, input.prefix, version, last.key]),
                ).toString('base64url'),
              }
            : {}),
        }
      } finally {
        database.exec('ROLLBACK')
      }
    },
  }
}
