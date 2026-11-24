import type { DatabaseSync } from 'node:sqlite'
import type { AliasMap } from './aliases.js'
import { bestPerDoc, fuse } from './fuse.js'
import { buildQuery } from './query.js'
import { tokenize, tokenizerVersion } from './tokenize.js'

export type Chunk = { text: string; lineStart: number; lineEnd: number }
export type SearchDocument = { doc: string; title?: string; fingerprint: string; chunks: readonly Chunk[] }
export type IndexedChunk = Chunk & { id: number; doc: string; ord: number; fingerprint: string }

const schema = '1'
const columns = 'c.id, c.doc, c.ord, c.line_start AS lineStart, c.line_end AS lineEnd, c.text, c.fingerprint'

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  const nested = db.isTransaction
  db.exec(nested ? 'SAVEPOINT lexical_write' : 'BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec(nested ? 'RELEASE lexical_write' : 'COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec(nested ? 'ROLLBACK TO lexical_write; RELEASE lexical_write' : 'ROLLBACK')
    throw error
  }
}

function createTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, doc TEXT NOT NULL, ord INTEGER NOT NULL,
      line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, text TEXT NOT NULL, fingerprint TEXT NOT NULL,
      UNIQUE(doc, ord));
    CREATE VIRTUAL TABLE fts_en USING fts5(title, body, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE fts_cjk USING fts5(tokens, tokenize='unicode61');
  `)
}

function insert(db: DatabaseSync, document: SearchDocument): void {
  const chunk = db.prepare(
    'INSERT INTO chunks(doc, ord, line_start, line_end, text, fingerprint) VALUES(?,?,?,?,?,?)',
  )
  const en = db.prepare('INSERT INTO fts_en(rowid,title,body) VALUES(?,?,?)')
  const cjk = db.prepare('INSERT INTO fts_cjk(rowid,tokens) VALUES(?,?)')
  const title = tokenize(document.title ?? document.doc)
  const enTitle = title.english.join(' ')
  const titleTokens = [...title.words, ...title.bigrams]
  for (const [ord, part] of document.chunks.entries()) {
    const { lastInsertRowid } = chunk.run(
      document.doc,
      ord,
      part.lineStart,
      part.lineEnd,
      part.text,
      document.fingerprint,
    )
    const body = tokenize(part.text)
    en.run(lastInsertRowid, enTitle, body.english.join(' '))
    cjk.run(lastInsertRowid, [...titleTokens, ...body.words, ...body.bigrams].join(' '))
  }
}

function erase(db: DatabaseSync, doc: string) {
  for (const table of ['fts_en', 'fts_cjk'])
    db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT id FROM chunks WHERE doc = ?)`).run(doc)
  db.prepare('DELETE FROM chunks WHERE doc = ?').run(doc)
}

export function upsertDoc(db: DatabaseSync, document: SearchDocument): void {
  transaction(db, () => {
    erase(db, document.doc)
    insert(db, document)
  })
}

export function removeDoc(db: DatabaseSync, doc: string): void {
  transaction(db, () => erase(db, doc))
}

export function rebuildAll(db: DatabaseSync, documents: Iterable<SearchDocument>): void {
  transaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS fts_en; DROP TABLE IF EXISTS fts_cjk')
    createTables(db)
    for (const document of documents) insert(db, document)
    const put = db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
    put.run('schema', schema)
    put.run('tokenizer_version', tokenizerVersion)
  })
}

export function ensureIndex(db: DatabaseSync, documents: () => Iterable<SearchDocument>): boolean {
  db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const get = db.prepare('SELECT value FROM meta WHERE key = ?')
  if (get.get('schema')?.value === schema && get.get('tokenizer_version')?.value === tokenizerVersion)
    return false
  rebuildAll(db, documents())
  return true
}

export function listChunks(db: DatabaseSync): IndexedChunk[] {
  return db.prepare(`SELECT ${columns} FROM chunks c ORDER BY doc,ord`).all() as IndexedChunk[]
}

export function search(
  db: DatabaseSync,
  input: string,
  options: { aliases?: AliasMap; aggregate?: boolean; limit?: number } = {},
) {
  const query = buildQuery(input, options.aliases)
  const cap =
    options.limit === undefined || !Number.isFinite(options.limit)
      ? 200
      : Math.max(1, Math.floor(options.limit))
  const channel = (table: 'fts_en' | 'fts_cjk', match: string): IndexedChunk[] =>
    match
      ? (db
          .prepare(`SELECT ${columns} FROM ${table} JOIN chunks c ON c.id=${table}.rowid
      WHERE ${table} MATCH ? ORDER BY rank,c.doc,c.ord LIMIT ?`)
          .all(match, cap) as IndexedChunk[])
      : []
  const ranked = fuse([channel('fts_en', query.en), channel('fts_cjk', query.cjk)], (chunk) => chunk.id).map(
    ({ item, score }) => ({ ...item, score }),
  )
  return options.aggregate ? bestPerDoc(ranked, (chunk) => chunk.doc) : ranked
}
