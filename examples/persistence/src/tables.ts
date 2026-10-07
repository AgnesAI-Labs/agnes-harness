import type { PersistenceTableHandle, PersistenceTableStore } from '@agnes/extension-api'

const TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/

type Row = Record<string, unknown>
type Table = { rows: Row[] }

/**
 * Package tables for the example. CREATE TABLE records a name and ignores constraints. CREATE INDEX
 * is a no-op, so a host that only prepares its receipt tables can start. INSERT and SELECT are the
 * statements the contract checks. Anything else is refused. Rows stay in the process, and this is
 * not the host SQL authorizer.
 */
export function createOwnerTables(): PersistenceTableStore {
  const tables = new Map<string, Table>()
  return {
    table(name): PersistenceTableHandle {
      if (!TABLE_NAME.test(name)) throw new Error(`table name must match ${TABLE_NAME}: ${name}`)
      return {
        name,
        exec(sql) {
          for (const statement of splitSql(sql)) applyExec(tables, statement)
        },
        run(sql, params = []) {
          return { changes: applyInsert(tables, sql, bind(params)) }
        },
        all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
          bind(params)
          return select(tables, sql) as T[]
        },
        get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
          bind(params)
          return select(tables, sql)[0] as T | undefined
        },
        transaction<T>(fn: () => T) {
          return fn()
        },
      }
    },
  }
}

function bind(params: readonly unknown[]): unknown[] {
  return params.map((value, index) => {
    if (typeof value === 'string') {
      if (value.includes('\u0000'))
        throw new TypeError(`bind parameter ${index} contains NUL, unsafe for SQLite TEXT`)
      return value
    }
    if (value === null || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array)
      return value
    throw new TypeError(`bind parameter ${index} is not a value SQLite can carry: ${typeof value}`)
  })
}

function splitSql(sql: string): string[] {
  const out: string[] = []
  let start = 0
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i += 1
        else quote = undefined
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ';' && depth === 0) {
      out.push(sql.slice(start, i))
      start = i + 1
    }
  }
  out.push(sql.slice(start))
  return out.map((part) => part.trim()).filter((part) => part.length > 0)
}

function applyExec(tables: Map<string, Table>, statement: string): void {
  const create = /^create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z][a-z0-9_]{0,63})\b/i.exec(statement)
  if (create) {
    const name = create[1] as string
    if (tables.has(name)) {
      if (!/^create\s+table\s+if\s+not\s+exists\b/i.test(statement))
        throw new Error(`table ${name} already exists`)
      return
    }
    tables.set(name, { rows: [] })
    return
  }
  if (/^create\s+(?:unique\s+)?index\b/i.test(statement)) return
  throw new Error('jsonl tables: unsupported statement')
}

function applyInsert(tables: Map<string, Table>, sql: string, params: readonly unknown[]): number {
  const parsed = /^insert\s+into\s+([a-z][a-z0-9_]{0,63})\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)\s*$/i.exec(
    sql.trim(),
  )
  if (!parsed) throw new Error('jsonl tables: unsupported statement')
  const name = parsed[1] as string
  const table = tables.get(name)
  if (!table) throw new Error(`no such table: ${name}`)
  const columns = (parsed[2] as string).split(',').map((column) => column.trim())
  const placeholders = (parsed[3] as string).split(',').map((slot) => slot.trim())
  if (placeholders.some((slot) => slot !== '?') || placeholders.length !== params.length)
    throw new Error('jsonl tables: insert placeholders do not match the parameters')
  if (columns.length !== params.length) throw new Error('jsonl tables: insert columns do not match the parameters')
  const row: Row = {}
  columns.forEach((column, index) => {
    row[column] = params[index]
  })
  table.rows.push(row)
  return 1
}

function select(tables: Map<string, Table>, sql: string): Row[] {
  const parsed = /^select\s+(.+?)\s+from\s+([a-z][a-z0-9_]{0,63})\s*$/i.exec(sql.trim())
  if (!parsed) throw new Error('jsonl tables: unsupported statement')
  const name = parsed[2] as string
  const table = tables.get(name)
  if (!table) throw new Error(`no such table: ${name}`)
  const columns = (parsed[1] as string).trim()
  if (columns === '*') return table.rows.map((row) => ({ ...row }))
  const names = columns.split(',').map((column) => column.trim())
  return table.rows.map((row) => {
    const out: Row = {}
    for (const column of names) out[column] = row[column]
    return out
  })
}
