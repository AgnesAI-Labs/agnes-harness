import { type DatabaseSync, constants as SQLITE } from 'node:sqlite'
import { HostError } from '../errors.js'

// Containment for a package table connection, kept apart from the storage adapter that installs it:
// two layers, one textual and one inside SQLite, and each covers a hole the other has.
//
// Constructs that reach outside the owner's own database file, or out of SQLite altogether.
// ATTACH is the one that matters — it is the only way a statement can name a second file — but
// DETACH, PRAGMA (`writable_schema`, `temp_store_directory`), VACUUM (`VACUUM INTO` writes a copy
// of the database anywhere the process can write), virtual tables (`dbstat`, `sqlite_dbpage` read
// raw pages) and `load_extension` all leave the owner's file behind in their own way.
//
// `PRAGMA(?:_[a-z_]+)?` rather than `PRAGMA`: `_` is a word character, so `\bPRAGMA\b` matches
// none of the `pragma_*` table-valued functions, and six of them ran on a gate-only connection.
// `SELECT * FROM pragma_database_list` is the one that matters — it returns this store's absolute
// path, which is the file-name derivation an attacker needs before it can name a sibling store.
const REFUSED_SQL =
  /\b(?:ATTACH|DETACH|PRAGMA(?:_[a-z_]+)?|VACUUM|VIRTUAL|load_extension|sqlite_dbpage|dbstat)\b/i

// Comments and quoted text are dropped before the keyword scan, so `INSERT INTO t VALUES (\'attach\')`
// is data and `ATTACH /* c */ DATABASE` cannot hide behind a comment. Quoted identifiers go too:
// a table may legally be named "pragma", and it is a name there, not a statement.
export function sqlSkeleton(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i] as string
    const n = sql[i + 1]
    if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && n === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      i++
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close && close !== ']') i += 2
          else {
            i++
            break
          }
        } else i++
      }
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Refuses a statement that could leave the owner's file. Thrown before SQLite ever sees the text. */
export function assertOwnedSql(sql: string): void {
  const m = REFUSED_SQL.exec(sqlSkeleton(sql))
  if (m) throw new Error(`E_SQL_REFUSED: ${m[0].toUpperCase()} is not allowed on a package table connection`)
}

// The second line, and the one that does not depend on reading SQL correctly. The authorizer is
// consulted by SQLite itself while a statement is compiled, so an obfuscation the keyword gate
// missed still cannot attach a file. `dbName` is checked as well: with ATTACH denied nothing but
// `main` and `temp` exists, and anything else appearing is a reason to stop rather than to guess.
//
// SQLITE_COPY is `0` in this build, the same value SQLITE_OK carries, so its membership here reads
// as "action 0 is denied" and is not: it is a retired action code SQLite never emits, and the entry
// is inert either way. It is kept as a statement of intent about a code that cannot arrive.
const DENIED_ACTIONS = new Set<number>([
  SQLITE.SQLITE_ATTACH,
  SQLITE.SQLITE_DETACH,
  SQLITE.SQLITE_PRAGMA,
  SQLITE.SQLITE_CREATE_VTABLE,
  SQLITE.SQLITE_DROP_VTABLE,
  SQLITE.SQLITE_COPY,
])

// Neither layer subsumes the other, and the pair is not belt-and-braces around one mechanism.
// The keyword gate alone passed the entire `pragma_*` family until the pattern above was widened,
// and only the authorizer refuses those. Going the other way, `dbstat` and `sqlite_dbpage` are
// eponymous virtual tables: selecting from one compiles no CREATE_VTABLE action, so no denied
// action code ever fires and the authorizer alone lets it through — only the gate's own `dbstat`
// keyword stops it. Neither hole crosses a file boundary; ATTACH is refused by either layer
// standing alone, which is the property the isolation claim rests on.
export function confineToOwnFile(conn: DatabaseSync): void {
  // `setAuthorizer` arrived in Node 24.10, which `engines` now requires. It refuses rather than
  // returns: a security fence that disappears without saying so leaves a caller believing in a
  // layer that is not there, and the `tables()` contract states both layers without a qualifier.
  // Failing at the first table store, naming the runtime, is the only version of that claim the
  // code can keep.
  if (typeof conn.setAuthorizer !== 'function')
    throw new HostError(
      'E_SEAM_INIT',
      `table store containment needs node:sqlite setAuthorizer, added in Node 24.10; this runtime is ${process.version}`,
      {
        detail: { seam: 'storage', reason: 'setAuthorizer unavailable', nodeVersion: process.version },
      },
    )
  conn.setAuthorizer((action, _a1, _a2, dbName) => {
    if (DENIED_ACTIONS.has(action)) return SQLITE.SQLITE_DENY
    if (dbName !== null && dbName !== 'main' && dbName !== 'temp') return SQLITE.SQLITE_DENY
    return SQLITE.SQLITE_OK
  })
}
