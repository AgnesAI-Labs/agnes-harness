import type { TableHandle } from '../src/seam-init.js'

/**
 * An in-memory stand-in for the host's `node:sqlite` table handle, implementing the small SQL
 * subset the seams in this package write. It exists so a seam can be tested without a database
 * file, which is only worth anything if the two answer the same questions the same way: a seam
 * that goes green here and loses rows on sqlite is worse than no testkit at all.
 *
 * Every behaviour below that looks surprising was measured against node:sqlite through the host
 * adapter, and the cross-adapter contract suite runs both implementations through one shared list
 * of literal expectations. The measured ones are:
 *
 *   - a TEXT bind carrying a NUL is refused before SQLite can silently truncate it on read.
 *   - `col = ?` bound to null matches nothing, including a row whose column is null.
 *   - ORDER BY sorts null before numbers before text before blobs, text and blobs by bytes.
 *   - LIMIT is applied after an aggregate, so `count(*) ... LIMIT 0` returns no row at all.
 *   - `sum` over no rows is null, not 0; `count(*)` over no rows is 0.
 *   - an unaliased aggregate's column name is the expression as written.
 *   - a statement naming a table that was never created fails with `no such table`.
 *   - a bind parameter that is not null, a number, a bigint, a string or a Uint8Array is refused
 *     before the statement runs.
 *
 * What this is not: a SQL engine. Joins, subqueries, expressions, IS NULL, ranges, OR, GROUP BY,
 * INSERT OR REPLACE and every other shape throw `unsupported sql in MemTable` rather than being
 * approximated, because an approximation is the thing that would make the two disagree quietly.
 */

type Row = Record<string, unknown>
type Table = { columns: string[]; rows: Row[] }

const IDENT = '[A-Za-z_][A-Za-z0-9_]*'
const CREATE_TABLE = new RegExp(
  String.raw`^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s*\(([\s\S]*)\)\s*;?\s*$`,
  'i',
)
const CREATE_INDEX = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s/i
const INSERT = new RegExp(
  String.raw`^\s*INSERT\s+INTO\s+(${IDENT})\s*\(([^()]+)\)\s*VALUES\s*\(([^()]+)\)\s*;?\s*$`,
  'i',
)
const UPDATE = new RegExp(
  String.raw`^\s*UPDATE\s+(${IDENT})\s+SET\s+(.+?)(?:\s+WHERE\s+(.+?))?\s*;?\s*$`,
  'i',
)
const DELETE = new RegExp(String.raw`^\s*DELETE\s+FROM\s+(${IDENT})(?:\s+WHERE\s+(.+?))?\s*;?\s*$`, 'i')
const SELECT = new RegExp(
  String.raw`^\s*SELECT\s+(.+?)\s+FROM\s+(${IDENT})` +
    String.raw`(?:\s+WHERE\s+(.+?))?` +
    String.raw`(?:\s+ORDER\s+BY\s+(${IDENT})(\s+ASC|\s+DESC)?)?` +
    String.raw`(?:\s+LIMIT\s+(\d+))?\s*;?\s*$`,
  'i',
)
const ASSIGN = new RegExp(String.raw`^(${IDENT})\s*=\s*\?$`)
const COUNT_STAR = /^COUNT\s*\(\s*\*\s*\)$/i
const SUM_COL = new RegExp(String.raw`^SUM\s*\(\s*(${IDENT})\s*\)$`, 'i')
const AS_ALIAS = new RegExp(String.raw`^(.*?)\s+AS\s+(${IDENT})$`, 'i')
// A column definition's name is its first token; a table-level constraint is not a column at all.
const CONSTRAINT = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i

const unsupported = (sql: string): never => {
  throw new Error(`unsupported sql in MemTable: ${sql}`)
}
const splitTop = (s: string): string[] => {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of s) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}

const enc = new TextEncoder()
const bytesOf = (s: string): Uint8Array => enc.encode(s)
const cmpBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] as number
    const y = b[i] as number
    if (x !== y) return x < y ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}
// SQLite's storage-class order, which is what ORDER BY follows before it compares two values of
// the same class: null, then numbers, then text, then blobs.
const classOf = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number' || typeof v === 'bigint') return 1
  if (typeof v === 'string') return 2
  return 3
}
const cmp = (a: unknown, b: unknown): number => {
  const ca = classOf(a)
  const cb = classOf(b)
  if (ca !== cb) return ca < cb ? -1 : 1
  if (ca === 0) return 0
  if (ca === 1) return Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0
  if (ca === 2) return cmpBytes(bytesOf(a as string), bytesOf(b as string))
  return cmpBytes(a as Uint8Array, b as Uint8Array)
}
/** `=` in SQL: null is never equal to anything, including another null. */
const eq = (a: unknown, b: unknown): boolean => {
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (a instanceof Uint8Array && b instanceof Uint8Array) return cmpBytes(a, b) === 0
  if (a instanceof Uint8Array || b instanceof Uint8Array) return false
  return a === b
}

/** Rejected before the statement runs, exactly as the host adapter rejects it. */
function checkParams(params: readonly unknown[]): void {
  params.forEach((p, i) => {
    if (typeof p === 'string' && p.includes('\u0000'))
      throw new TypeError(`bind parameter ${i} contains NUL, unsafe for SQLite TEXT`)
    if (
      p === null ||
      typeof p === 'number' ||
      typeof p === 'bigint' ||
      typeof p === 'string' ||
      p instanceof Uint8Array
    )
      return
    throw new TypeError(`bind parameter ${i} is not a value SQLite can carry: ${typeof p}`)
  })
}
// A placeholder nothing was bound to is NULL, and undefined is what "nothing was bound" looks like
// on the way in from a short parameter array.
const store = (v: unknown): unknown =>
  v === undefined ? null : v instanceof Uint8Array ? new Uint8Array(v) : v
// Binding more parameters than the statement has placeholders is the error node:sqlite raises;
// binding fewer is not an error there at all - the rest come out NULL - so it is not one here.
const checkArity = (expected: number, params: readonly unknown[]): void => {
  if (params.length > expected) throw new RangeError('column index out of range')
}
// Values read through node:sqlite round-trip safe TEXT. Blobs are returned as fresh buffers, so the
// test double copies them too.
const project = (v: unknown): unknown => (v instanceof Uint8Array ? new Uint8Array(v) : v)

export class MemTable implements TableHandle {
  readonly name: string
  readonly #tables: Map<string, Table>

  /**
   * `tables` is the connection. Two handles built over the same map see each other's tables, which
   * is how the host behaves: `table('a')` and `table('b')` for one owner are two names on one
   * SQLite connection, and a statement reached through either can name either table.
   */
  constructor(name: string, tables: Map<string, Table> = new Map()) {
    this.name = name
    this.#tables = tables
  }

  /** The rows of the table this handle is named for, as stored - not through the read path. */
  get rows(): Row[] {
    return this.#tables.get(this.name)?.rows ?? []
  }
  get tables(): Map<string, Table> {
    return this.#tables
  }

  #table(name: string): Table {
    const t = this.#tables.get(name)
    if (!t) throw new Error(`no such table: ${name}`)
    return t
  }
  #column(t: Table, col: string): string {
    if (!t.columns.includes(col)) throw new Error(`no such column: ${col}`)
    return col
  }
  /** `col = ? [AND col = ?]` and nothing else. Returns how many parameters it consumed. */
  #filter(t: Table, where: string | undefined, params: readonly unknown[], sql: string): [Row[], number] {
    if (where === undefined) return [[...t.rows], 0]
    const conds = where.split(/\s+AND\s+/i).map((c) => {
      const m = ASSIGN.exec(c.trim())
      if (!m) unsupported(sql)
      return this.#column(t, (m as RegExpExecArray)[1] as string)
    })
    const rows = t.rows.filter((r) => conds.every((c, i) => eq(r[c], params[i])))
    return [rows, conds.length]
  }

  exec(sql: string): void {
    if (CREATE_INDEX.test(sql)) return
    const m = CREATE_TABLE.exec(sql)
    if (!m) unsupported(sql)
    const [, name, body] = m as RegExpExecArray
    const columns: string[] = []
    for (const def of splitTop(body as string)) {
      const first = def.split(/\s+/)[0] as string
      if (CONSTRAINT.test(first)) continue
      columns.push(first)
    }
    if (!this.#tables.has(name as string)) this.#tables.set(name as string, { columns, rows: [] })
  }

  run(sql: string, params: readonly unknown[] = []): { changes: number } {
    checkParams(params)
    let m = INSERT.exec(sql)
    if (m) {
      const t = this.#table(m[1] as string)
      const cols = splitTop(m[2] as string).map((c) => this.#column(t, c))
      const marks = splitTop(m[3] as string)
      if (marks.some((v) => v !== '?')) unsupported(sql)
      if (marks.length !== cols.length) unsupported(sql)
      checkArity(cols.length, params)
      const row: Row = {}
      for (const c of t.columns) row[c] = null
      cols.forEach((c, i) => {
        row[c] = store(params[i])
      })
      t.rows.push(row)
      return { changes: 1 }
    }
    m = UPDATE.exec(sql)
    if (m) {
      const t = this.#table(m[1] as string)
      const sets = splitTop(m[2] as string).map((s) => {
        const a = ASSIGN.exec(s)
        if (!a) unsupported(sql)
        return this.#column(t, (a as RegExpExecArray)[1] as string)
      })
      const [rows, used] = this.#filter(t, m[3], params.slice(sets.length), sql)
      checkArity(sets.length + used, params)
      for (const r of rows)
        sets.forEach((c, i) => {
          r[c] = store(params[i])
        })
      return { changes: rows.length }
    }
    m = DELETE.exec(sql)
    if (m) {
      const t = this.#table(m[1] as string)
      const [rows, used] = this.#filter(t, m[2], params, sql)
      checkArity(used, params)
      const gone = new Set(rows)
      const before = t.rows.length
      t.rows.splice(0, t.rows.length, ...t.rows.filter((r) => !gone.has(r)))
      return { changes: before - t.rows.length }
    }
    return unsupported(sql)
  }

  all<T = Row>(sql: string, params: readonly unknown[] = []): T[] {
    checkParams(params)
    const m = SELECT.exec(sql)
    if (!m) unsupported(sql)
    const [, selectList, table, where, orderBy, direction, limit] = m as RegExpExecArray
    const t = this.#table(table as string)
    const [matched, used] = this.#filter(t, where, params, sql)
    checkArity(used, params)
    let rows = matched
    if (orderBy !== undefined) {
      const key = this.#column(t, orderBy)
      rows = [...rows].sort((a, b) => cmp(a[key], b[key]))
      if (direction !== undefined && /DESC/i.test(direction)) rows.reverse()
    }
    const items = splitTop(selectList as string)
    const first = items[0] as string
    const aggregate = this.#aggregate(t, first, rows)
    // LIMIT is applied to the result rows, and an aggregate has produced its single row by now, so
    // `count(*) ... LIMIT 0` returns nothing rather than a zero.
    const out = aggregate === undefined ? rows.map((r) => this.#project(t, items, sql)(r)) : [aggregate]
    return (limit === undefined ? out : out.slice(0, Number(limit))) as T[]
  }

  #aggregate(t: Table, expr: string, rows: Row[]): Row | undefined {
    const named = AS_ALIAS.exec(expr)
    const body = (named ? (named[1] as string) : expr).trim()
    const label = named ? (named[2] as string) : body
    if (COUNT_STAR.test(body)) return { [label]: rows.length }
    const sum = SUM_COL.exec(body)
    if (!sum) return undefined
    const col = this.#column(t, sum[1] as string)
    const present = rows.filter((r) => r[col] !== null && r[col] !== undefined)
    // sum of nothing is null, not zero - the difference a caller reading `?? 0` never notices until
    // it reports a spend of 0 for a session that has no ledger rows yet.
    if (present.length === 0) return { [label]: null }
    return { [label]: present.reduce((n, r) => n + (Number(r[col]) || 0), 0) }
  }

  #project(t: Table, items: string[], sql: string): (r: Row) => Row {
    if (items.length === 1 && items[0] === '*')
      return (r) => Object.fromEntries(t.columns.map((c) => [c, project(r[c])]))
    const cols = items.map((c) => {
      const named = AS_ALIAS.exec(c)
      const body = (named ? (named[1] as string) : c).trim()
      if (!new RegExp(`^${IDENT}$`).test(body)) unsupported(sql)
      return [this.#column(t, body), named ? (named[2] as string) : body] as const
    })
    return (r) => Object.fromEntries(cols.map(([c, label]) => [label, project(r[c])]))
  }

  get<T = Row>(sql: string, params: readonly unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  /**
   * Runs `fn`, and on a throw puts every table back the way it was. Without the restore a test
   * asserting that a failed transaction left nothing behind would pass on sqlite and pass here for
   * the wrong reason - the rows would still be there and nobody would be looking.
   */
  transaction<T>(fn: () => T): T {
    const snapshot = new Map(
      [...this.#tables].map(([n, t]) => [
        n,
        { columns: [...t.columns], rows: t.rows.map((r) => ({ ...r })) },
      ]),
    )
    try {
      return fn()
    } catch (e) {
      this.#tables.clear()
      for (const [n, t] of snapshot) this.#tables.set(n, t)
      throw e
    }
  }
}
