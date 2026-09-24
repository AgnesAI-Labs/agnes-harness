import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { confineToOwnFile } from '../../src/adapters/sql-guard.js'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'

// The attack this file pins is the one the isolation comment claims is impossible: a package that
// knows its own path knows the ledger's and every other package's, because the file name is the
// owner id with the unsafe characters replaced. If SQL reaching a table handle can name a second
// file, the separate-file story buys nothing.
const REFUSED = /E_SQL_REFUSED|not authorized|authorization denied/

describe('table store containment', () => {
  let dir: string
  let s: SqliteStorage
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-isolation-'))
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  })
  afterEach(async () => {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function victim(): void {
    const good = s.tables('@good/pkg').table('t')
    good.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)')
    good.run('INSERT INTO t VALUES (?)', ['confidential'])
  }

  it('refuses to attach another package store or the ledger, through every method', () => {
    victim()
    const evil = s.tables('@evil/pkg').table('t')
    const other = join(dir, 'tables', '_40good_2fpkg.db')
    expect(existsSync(other)).toBe(true)
    expect(() => evil.exec(`ATTACH DATABASE '${other}' AS o`)).toThrow(REFUSED)
    expect(() => evil.run(`ATTACH DATABASE '${other}' AS o`)).toThrow(REFUSED)
    expect(() => evil.all(`ATTACH DATABASE '${other}' AS o`)).toThrow(REFUSED)
    expect(() => evil.get(`ATTACH DATABASE '${other}' AS o`)).toThrow(REFUSED)
    expect(() => evil.exec(`ATTACH DATABASE '${join(dir, 'sessions.db')}' AS led`)).toThrow(REFUSED)
    // Nothing was attached, so the names the attack would have read do not resolve.
    expect(() => evil.all('SELECT v FROM o.t')).toThrow()
    expect(() => evil.all("SELECT name FROM led.sqlite_master WHERE type='table'")).toThrow()
  })

  it('refuses the other constructs that reach a second file or the schema', () => {
    const evil = s.tables('@evil/pkg').table('t')
    const copy = join(dir, 'copy.db')
    for (const sql of [
      `VACUUM INTO '${copy}'`,
      'PRAGMA writable_schema = ON',
      'PRAGMA temp_store_directory = "/tmp"',
      'DETACH DATABASE o',
      "CREATE VIRTUAL TABLE v USING dbstat('main')",
      "SELECT load_extension('/tmp/x.so')",
      `ATTACH /* comment */ DATABASE '${copy}' AS o`,
      `attach database '${copy}' as o`,
      `CREATE TABLE ok (x); ATTACH DATABASE '${copy}' AS o`,
    ])
      expect(() => evil.exec(sql), sql).toThrow(REFUSED)
    expect(existsSync(copy)).toBe(false)
  })

  // The containment above is about SQL. This one is not: if two owners derive the same file name
  // they share a store outright, and the cross-package read and write need no statement the gate
  // would ever see. `@A/x` and `@_/x` are the pair that proved it — a sanitiser that folds unsafe
  // characters into one replacement character folds upper case with them.
  it('gives two owners that differ only in folded characters separate files', () => {
    const a = s.tables('@A/x').table('t')
    a.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)')
    a.run('INSERT INTO t VALUES (?)', ['from-@A/x'])
    const b = s.tables('@_/x').table('t')
    // Not an empty result: the victim's table is not in this owner's file at all.
    expect(() => b.all('SELECT v FROM t')).toThrow(/no such table/)
    b.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)')
    b.run('INSERT INTO t VALUES (?)', ['from-@_/x'])
    expect(a.all('SELECT v FROM t')).toEqual([{ v: 'from-@A/x' }])
    expect(b.all('SELECT v FROM t')).toEqual([{ v: 'from-@_/x' }])
  })

  it('derives a distinct file for every distinct owner', () => {
    // Every spelling here collapses onto one of two names under a folding sanitiser, and the pairs
    // that differ only in case would collide again on a case-insensitive filesystem even if the
    // fold were dropped. A one-to-one derivation is the only thing that answers both.
    const owners = ['@A/x', '@_/x', '@a/x', '@A/X', 'A_x', 'a_x', '_a_x', 'a-x', 'a_2dx', 'a.x']
    for (const o of owners) s.tables(o).table('t').exec('CREATE TABLE IF NOT EXISTS t (v TEXT)')
    const files = readdirSync(join(dir, 'tables')).filter((f) => f.endsWith('.db'))
    expect(files.length).toBe(owners.length)
    expect(new Set(files.map((f) => f.toLowerCase())).size).toBe(owners.length)
  })

  // The cases above accept either layer's message, which is right for a guarantee but leaves both
  // layers unpinned individually: deleting either one keeps them green. These two name the layer.
  // They are also the pair that shows the layers are complementary rather than redundant — each
  // construct is stopped by exactly one of them.
  it('stops an eponymous virtual table in the keyword gate, which is the only layer that can', () => {
    // `dbstat` compiles no CREATE_VTABLE action, so no denied action code reaches the authorizer.
    const evil = s.tables('@evil/pkg').table('t')
    expect(() => evil.all('SELECT * FROM dbstat')).toThrow(/E_SQL_REFUSED/)
    expect(() => evil.all('SELECT * FROM sqlite_dbpage')).toThrow(/E_SQL_REFUSED/)
  })

  it('stops the pragma_ table-valued family, which discloses this store path', () => {
    // `_` is a word character, so these passed `\bPRAGMA\b` until the pattern was widened.
    // pragma_database_list returns the file's absolute path.
    const evil = s.tables('@evil/pkg').table('t')
    for (const fn of [
      'pragma_database_list',
      'pragma_table_list',
      'pragma_module_list',
      'pragma_function_list',
      'pragma_compile_options',
    ])
      expect(() => evil.all(`SELECT * FROM ${fn}`), fn).toThrow(/E_SQL_REFUSED/)
  })

  it('refuses ATTACH and the pragma_ family in the authorizer, with the keyword gate out of the way', () => {
    // The gate catches all of these first on a real handle, so the authorizer is exercised on a
    // bare connection instead. Without this, deleting the authorizer leaves the suite green and
    // the depth the tables() contract promises is only asserted, never checked.
    const conn = new DatabaseSync(join(dir, 'bare.db'))
    confineToOwnFile(conn)
    try {
      expect(() => conn.exec(`ATTACH DATABASE '${join(dir, 'sessions.db')}' AS led`)).toThrow(
        /not authorized/,
      )
      expect(() => conn.prepare('SELECT * FROM pragma_database_list').all()).toThrow(/not authorized/)
      expect(() => conn.exec('PRAGMA writable_schema = ON')).toThrow(/not authorized/)
      // Its own file is still fully usable, which is what makes the denial a fence and not a lock.
      conn.exec('CREATE TABLE t (v TEXT)')
      conn.prepare('INSERT INTO t VALUES (?)').run('ok')
      expect(conn.prepare('SELECT v FROM t').all()).toEqual([{ v: 'ok' }])
    } finally {
      conn.close()
    }
  })

  it('refuses to build a table store at all on a runtime without setAuthorizer', () => {
    // A fence that vanishes in silence is the defect, not the missing runtime feature: the
    // tables() contract states both layers, so the assembly has to fail where it cannot keep them.
    const stub = { setAuthorizer: undefined } as unknown as Parameters<typeof confineToOwnFile>[0]
    expect(() => confineToOwnFile(stub)).toThrow(/E_SEAM_INIT/)
    expect(() => confineToOwnFile(stub)).toThrow(/24\.10/)
  })

  it('still allows a package everything it needs inside its own file', () => {
    const h = s.tables('@good/pkg').table('t')
    h.exec('CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)')
    h.exec('CREATE INDEX IF NOT EXISTS t_v ON t (v)')
    expect(h.run('INSERT INTO t VALUES (?, ?)', ['a', 'b']).changes).toBe(1)
    expect(h.get('SELECT v FROM t WHERE k = ?', ['a'])).toEqual({ v: 'b' })
    expect(h.all('SELECT * FROM t')).toEqual([{ k: 'a', v: 'b' }])
    expect(h.run('UPDATE t SET v = ? WHERE k = ?', ['c', 'a']).changes).toBe(1)
    expect(h.transaction(() => h.run('DELETE FROM t WHERE k = ?', ['a']).changes)).toBe(1)
    // A value that merely spells a refused keyword is data, not a statement.
    h.run('INSERT INTO t VALUES (?, ?)', ['attach', 'pragma vacuum'])
    expect(h.get('SELECT v FROM t WHERE k = ?', ['attach'])).toEqual({ v: 'pragma vacuum' })
    expect(h.all("SELECT name FROM sqlite_master WHERE type='table'")).toEqual([{ name: 't' }])
  })
})
