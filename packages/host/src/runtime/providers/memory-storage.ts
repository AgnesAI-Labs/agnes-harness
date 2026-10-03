import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type * as Wire from '@agnes/protocol/runtime'

interface Document {
  keywordTerms: readonly string[]
  memoryId: string
  text: string
  vector: readonly number[]
  createdAt: string
}
function open(directory: string, domain: 'memory' | 'retrieval') {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, domain + '.sqlite')
  const db = new DatabaseSync(path)
  try {
    chmodSync(path, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
function lifecycle(db: DatabaseSync, domain: string) {
  let closed = false
  return {
    assertOwner(scopeDigest: string) {
      db.prepare('INSERT OR IGNORE INTO owner VALUES (1, ?)').run(scopeDigest)
      if (db.prepare('SELECT scope FROM owner WHERE id=1').get()?.scope !== scopeDigest) {
        this.close()
        throw new Error(domain + '_scope_mismatch')
      }
    },
    transaction<T>(work: () => T): T {
      db.exec('BEGIN IMMEDIATE')
      try {
        const value = work()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    revision: () => Number(db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision),
    close() {
      if (!closed) {
        closed = true
        db.close()
      }
    },
  }
}
/** An exclusively owned storage handle; Core owns business decisions and the port contract.
 * Ownership, outbox, delivery results and revisions survive WAL recovery after process death.
 * The returned shape implements Core's narrow MemoryStorage without importing private Core files.
 */
export function createMemoryStorage(directory: string) {
  const db = open(directory, 'memory')
  db.exec(
    'CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL); INSERT OR IGNORE INTO meta VALUES (1, 0); CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, output TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deletions (id TEXT PRIMARY KEY, receipt TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)',
  )
  return {
    ...lifecycle(db, 'memory'),
    setRevision(revision: number) {
      db.prepare('UPDATE meta SET revision=? WHERE id=1').run(revision)
    },
    items: (): Wire.MemoryItem[] =>
      db
        .prepare('SELECT body FROM items ORDER BY id')
        .all()
        .map((row) => JSON.parse(String(row.body))),
    putItem(item: Wire.MemoryItem) {
      db.prepare('INSERT OR REPLACE INTO items VALUES (?, ?)').run(item.ref.id, JSON.stringify(item))
    },
    delivery(id: string): { fingerprint: string; output: unknown } | null {
      const row = db.prepare('SELECT fingerprint, output FROM deliveries WHERE id=?').get(id)
      return row ? { fingerprint: String(row.fingerprint), output: JSON.parse(String(row.output)) } : null
    },
    putDelivery(id: string, fingerprint: string, output: unknown) {
      db.prepare('INSERT INTO deliveries VALUES (?, ?, ?)').run(id, fingerprint, JSON.stringify(output))
    },
    putDeletion(receipt: Wire.DeletionReceipt) {
      db.prepare('INSERT INTO deletions (id, receipt) VALUES (?, ?)').run(
        receipt.deletionId,
        JSON.stringify(receipt),
      )
    },
    pendingDeletions: (): Wire.DeletionReceipt[] =>
      db
        .prepare('SELECT receipt FROM deletions WHERE acknowledged=0 ORDER BY id')
        .all()
        .map((row) => JSON.parse(String(row.receipt))),
    acknowledgeDeletion(id: string) {
      db.prepare('UPDATE deletions SET acknowledged=1 WHERE id=?').run(id)
    },
  }
}
/** SQLite FTS5 keyword candidates, stored vectors and atomic index/deletion revisions.
 * A handle is owned by one Retrieval provider and closes with that provider.
 */
export function createRetrievalStorage(directory: string) {
  const db = open(directory, 'retrieval')
  db.exec(
    'CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, dimensions INTEGER NOT NULL, queries TEXT NOT NULL); CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS keywords USING fts5(id UNINDEXED, terms); CREATE TABLE IF NOT EXISTS removed (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, watermark INTEGER NOT NULL)',
  )
  db.prepare('INSERT OR IGNORE INTO meta VALUES (1, 0, 0, ?)').run('{}')
  return {
    ...lifecycle(db, 'retrieval'),
    documents: (): Document[] =>
      db
        .prepare('SELECT body FROM documents ORDER BY id')
        .all()
        .map((row) => JSON.parse(String(row.body))),
    queryVectors: (): Readonly<Record<string, readonly number[]>> =>
      JSON.parse(String(db.prepare('SELECT queries FROM meta WHERE id=1').get()?.queries)),
    keywordCandidates(terms: readonly string[]): string[] {
      if (!terms.length) return []
      return db
        .prepare('SELECT id FROM keywords WHERE terms MATCH ?')
        .all(terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' OR '))
        .map((row) => String(row.id))
    },
    replace(
      documents: readonly Document[],
      dimensions: number,
      queryVectors: Readonly<Record<string, readonly number[]>>,
      revision: number,
    ) {
      db.exec('DELETE FROM documents; DELETE FROM keywords')
      for (const doc of documents) {
        db.prepare('INSERT INTO documents VALUES (?, ?)').run(doc.memoryId, JSON.stringify(doc))
        db.prepare('INSERT INTO keywords (id, terms) VALUES (?, ?)').run(
          doc.memoryId,
          doc.keywordTerms.join(' '),
        )
      }
      db.prepare('UPDATE meta SET revision=?, dimensions=?, queries=? WHERE id=1').run(
        revision,
        dimensions,
        JSON.stringify(queryVectors),
      )
    },
    removal(id: string): { fingerprint: string } | null {
      const row = db.prepare('SELECT fingerprint FROM removed WHERE id=?').get(id)
      return row ? { fingerprint: String(row.fingerprint) } : null
    },
    removeDocuments(ids: readonly string[]) {
      for (const id of ids) {
        db.prepare('DELETE FROM documents WHERE id=?').run(id)
        db.prepare('DELETE FROM keywords WHERE id=?').run(id)
      }
    },
    putRemoval(id: string, fingerprint: string, watermark: number, revision: number) {
      db.prepare('INSERT INTO removed VALUES (?, ?, ?)').run(id, fingerprint, watermark)
      db.prepare('UPDATE meta SET revision=? WHERE id=1').run(revision)
    },
    deletionWatermark: () =>
      Number(db.prepare('SELECT coalesce(max(watermark),0) AS watermark FROM removed').get()?.watermark),
  }
}
