import type { DatabaseSync } from 'node:sqlite'
import { cjkTokens, tokenizerVersion, transaction } from '@agnes/lexical-search'

const versionKey = 'cjk_tokenizer_version'
const cursorKey = 'cjk_backfill_rowid'
const endKey = 'cjk_backfill_end'
const read = (db: DatabaseSync, key: string) =>
  db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value
const put = (db: DatabaseSync, key: string, value: string | number) =>
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(key, String(value))

export function ensureCjk(db: DatabaseSync): void {
  if (read(db, versionKey) === tokenizerVersion) return
  transaction(db, () => {
    if (read(db, versionKey) === tokenizerVersion) return
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs_cjk USING fts5(tokens, tokenize='unicode61')")
    db.exec('DELETE FROM docs_cjk')
    put(db, cursorKey, 0)
    put(db, endKey, Number(db.prepare('SELECT max(rowid) AS top FROM docs').get()?.top ?? 0))
    put(db, versionKey, tokenizerVersion)
  })
}

export function cjkPartial(db: DatabaseSync) {
  return Number(read(db, cursorKey)) < Number(read(db, endKey))
}

export function cjkWriter(db: DatabaseSync) {
  const insert = db.prepare('INSERT OR REPLACE INTO docs_cjk(rowid,tokens) VALUES(?,?)')
  return (rowid: number | bigint, text: string) => {
    const tokens = cjkTokens(text)
    if (tokens) insert.run(rowid, tokens)
  }
}

export function backfillCjk(db: DatabaseSync): void {
  ensureCjk(db)
  if (!cjkPartial(db)) return
  transaction(db, () => {
    const deadline = performance.now() + 200
    let cursor = Number(read(db, cursorKey))
    const end = Number(read(db, endKey))
    const insert = cjkWriter(db)
    // Page by rowid so the batch doesn't materialize 2,000 potentially large bodies.
    const rows = db.prepare(
      'SELECT rowid,text FROM docs WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 2000',
    )
    for (const row of rows.iterate(cursor, end)) {
      cursor = Number(row.rowid)
      insert(cursor, String(row.text))
      if (performance.now() >= deadline) break
    }
    if (!db.prepare('SELECT 1 FROM docs WHERE rowid>? AND rowid<=? LIMIT 1').get(cursor, end)) cursor = end
    put(db, cursorKey, cursor)
  })
}
