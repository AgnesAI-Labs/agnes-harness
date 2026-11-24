import { chmodSync, closeSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryFile, MemorySettings } from '@agnes/extension-api'
import {
  ensureIndex,
  listChunks,
  loadAliases,
  rebuildAll,
  removeDoc,
  type SearchDocument,
  search,
  transaction,
  upsertDoc,
} from '@agnes/lexical-search'
import { chunkView } from './chunker.js'
import { fault, hash, validateContent } from './content.js'
import type { MetaStore } from './meta.js'
import { safe } from './paths.js'
import type { MemoryView } from './view.js'

type ReadDocument = { file: MemoryFile; view: MemoryView; fingerprint: string }
export function readDocuments(
  files: readonly MemoryFile[],
  views: ReadonlyMap<string, MemoryView>,
  settings: MemorySettings,
) {
  const docs: ReadDocument[] = []
  for (const file of files) {
    const view = views.get(file.path)
    if (!view || !file.bytes) continue
    try {
      validateContent(file, settings, file.path === 'MEMORY.md')
    } catch {
      // The file port also refuses these bytes (including manually edited credentials).
      continue
    }
    docs.push({ file, view, fingerprint: hash(JSON.stringify([file.hash, view.content, view.segments])) })
  }
  return docs
}

function materialize({ file, view, fingerprint }: ReadDocument): SearchDocument {
  return { doc: file.path, fingerprint, chunks: chunkView(file, view) }
}

function available<T>(run: () => T): T {
  try {
    return run()
  } catch (cause) {
    throw Object.assign(fault('MEMORY_RECALL_UNAVAILABLE'), { cause })
  }
}

export class SearchIndex {
  private connection?: DatabaseSync
  private identity?: { dev: number; ino: number }
  private closed = false

  constructor(private readonly meta: MetaStore) {}

  private open(): DatabaseSync {
    if (this.closed) throw fault('MEMORY_RECALL_UNAVAILABLE')
    const path = this.meta.pathOf('index.sqlite')
    for (const suffix of ['-wal', '-shm', '-journal']) safe(this.meta.store.protectedRoot, path + suffix)
    if (this.connection) {
      const stat = statSync(path)
      if (this.identity?.dev !== stat.dev || this.identity.ino !== stat.ino)
        throw fault('MEMORY_RECALL_UNAVAILABLE')
      return this.connection
    }
    this.meta.ensureDir()
    // Only open a separate descriptor for initial creation. Closing a second fd on
    // an existing SQLite file can release another connection's POSIX advisory locks.
    try {
      closeSync(openSync(path, 'wx', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = statSync(path)
    if (!stat.isFile()) throw fault('MEMORY_RECALL_UNAVAILABLE')
    chmodSync(path, 0o600)
    this.identity = stat
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL')
      if (db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok')
        throw fault('MEMORY_RECALL_UNAVAILABLE')
      this.connection = db
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.connection?.close()
  }

  private reconcile(db: DatabaseSync, docs: readonly ReadDocument[], incremental: boolean): void {
    const manifest = Object.fromEntries(docs.map((doc) => [doc.file.path, doc.fingerprint]))
    const stamp = JSON.stringify(manifest)
    const documents = () => docs.map(materialize)
    const rebuilt = ensureIndex(db, documents)
    const previous = db.prepare("SELECT value FROM meta WHERE key='files'").get()?.value
    if (!rebuilt && previous === stamp) return
    if (!rebuilt && incremental && typeof previous === 'string') {
      const old = JSON.parse(previous) as Record<string, string>
      for (const path of Object.keys(old)) if (!Object.hasOwn(manifest, path)) removeDoc(db, path)
      for (const doc of docs) if (old[doc.file.path] !== doc.fingerprint) upsertDoc(db, materialize(doc))
    } else if (!rebuilt) rebuildAll(db, documents())
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('files',?)").run(stamp)
  }

  committed(docs: readonly ReadDocument[]): void {
    available(() => {
      const db = this.open()
      transaction(db, () => this.reconcile(db, docs, true))
    })
  }

  rebuildIndex(docs: readonly ReadDocument[]): void {
    available(() => {
      const db = this.open()
      transaction(db, () => {
        rebuildAll(db, docs.map(materialize))
        db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('files',?)").run(
          JSON.stringify(Object.fromEntries(docs.map((doc) => [doc.file.path, doc.fingerprint]))),
        )
      })
    })
  }

  inspectIndexedChunks() {
    return available(() =>
      listChunks(this.open()).map(({ doc: path, lineStart, lineEnd, text }) => ({
        path,
        lineStart,
        lineEnd,
        text,
      })),
    )
  }

  queryIndex(query: string) {
    return available(() => {
      safe(this.meta.store.protectedRoot, join(this.meta.store.root, 'aliases.json'))
      return search(this.open(), query, { aliases: loadAliases(this.meta.store.root) })
    })
  }

  query(query: string, files: readonly MemoryFile[], docs: readonly ReadDocument[]) {
    return available(() => {
      const db = this.open()
      return transaction(db, () => {
        // An old turn may still read its previous version. Its derived rows must never
        // replace another session's committed index. Use a reversible snapshot inside the lock.
        const current = this.meta.store.files()
        const pinned = new Map(files.map((file) => [file.path, file.hash]))
        const stale =
          current.length !== files.length || current.some((file) => pinned.get(file.path) !== file.hash)
        if (stale) db.exec('SAVEPOINT turn_view')
        this.reconcile(db, docs, false)
        const hits = this.queryIndex(query)
        if (stale) db.exec('ROLLBACK TO turn_view; RELEASE turn_view')
        return hits
      })
    })
  }
}
