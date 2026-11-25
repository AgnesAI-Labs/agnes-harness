import { chmodSync, closeSync, openSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryFile, MemorySettings } from '@agnes/extension-api'
import {
  ensureIndex,
  LEXICAL_SEARCH_VERSION,
  listChunks,
  loadAliases,
  rebuildAll,
  removeDoc,
  type SearchDocument,
  search,
  tokenizerVersion,
  transaction,
  upsertDoc,
} from '@agnes/lexical-search'
import { chunkView } from './chunker.js'
import { buildIndexView } from './consistency.js'
import { fault, hash, validateContent } from './content.js'
import type { MetaStore } from './meta.js'
import { safe } from './paths.js'
import type { HideRange, MemoryView } from './view.js'

export type ReadDocument = { file: MemoryFile; view: MemoryView; fingerprint: string }
export function readDocuments(
  files: readonly MemoryFile[],
  views: ReadonlyMap<string, MemoryView>,
  settings: MemorySettings,
  ranges?: ReadonlyMap<string, readonly HideRange[]>,
) {
  const docs: ReadDocument[] = []
  for (const file of files) {
    const read = views.get(file.path)
    if (!read || !file.bytes) continue
    try {
      validateContent(file, settings, file.path === 'MEMORY.md')
    } catch {
      // The file port also refuses these bytes (including manually edited credentials).
      continue
    }
    const hidden = ranges?.get(file.path)
    const view = hidden ? buildIndexView(file, hidden, read) : read
    docs.push({ file, view, fingerprint: hash(JSON.stringify([file.hash, view.content, view.segments])) })
  }
  return docs
}

function materialize({ file, view, fingerprint }: ReadDocument): SearchDocument {
  return { doc: file.path, fingerprint, chunks: chunkView(file, view) }
}

const manifestOf = (docs: readonly ReadDocument[]): Record<string, string> =>
  Object.fromEntries(docs.map((doc) => [doc.file.path, doc.fingerprint]))

const sidecars = ['-wal', '-shm', '-journal']
class CorruptIndex extends Error {}

function isCorrupt(error: unknown): boolean {
  if (error instanceof CorruptIndex) return true
  const sqlite = error as { errcode?: number; message?: string } | null
  const code = (sqlite?.errcode ?? 0) & 0xff
  // SQLite primary result codes CORRUPT and NOTADB, or a damaged table definition.
  return (
    code === 11 ||
    code === 26 ||
    (code === 1 &&
      /no such (?:table|column)|has no column named|use DROP (?:TABLE|VIEW)|malformed database schema/i.test(
        sqlite?.message ?? '',
      ))
  )
}

function upToDate(db: DatabaseSync, docs: readonly ReadDocument[]): boolean {
  try {
    const row = db
      .prepare(`SELECT count(*) AS matches FROM meta
      WHERE (key, value) IN (('schema', ?), ('tokenizer_version', ?), ('files', ?))`)
      .get(LEXICAL_SEARCH_VERSION, tokenizerVersion, JSON.stringify(manifestOf(docs)))
    return row?.matches === 3
  } catch (error) {
    if ((error as Error).message === 'no such table: meta') return false
    throw error
  }
}

function available<T>(run: () => T): T {
  try {
    return run()
  } catch (cause) {
    throw Object.assign(fault('MEMORY_RECALL_UNAVAILABLE'), { cause })
  }
}

export class SearchIndex {
  private connection: DatabaseSync | undefined
  private identity: { dev: number; ino: number } | undefined
  private closed = false

  constructor(private readonly meta: MetaStore) {}

  private open(): DatabaseSync {
    if (this.closed) throw fault('MEMORY_RECALL_UNAVAILABLE')
    const path = this.meta.pathOf('index.sqlite')
    for (const suffix of sidecars) safe(this.meta.store.protectedRoot, path + suffix)
    if (this.connection) {
      const stat = statSync(path, { throwIfNoEntry: false })
      if (stat && this.identity?.dev === stat.dev && this.identity.ino === stat.ino) return this.connection
      this.disconnect()
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
    try {
      chmodSync(path, 0o600)
    } catch {
      // Some filesystems do not support POSIX file modes.
    }
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL')
      if (db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok')
        throw new CorruptIndex('SQLite quick_check failed')
      this.connection = db
      this.identity = stat
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  private disconnect(): void {
    this.connection?.close()
    this.connection = undefined
    this.identity = undefined
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.disconnect()
  }

  private reconcile(db: DatabaseSync, docs: readonly ReadDocument[], incremental: boolean): void {
    const manifest = manifestOf(docs)
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
      const rebuild = () => {
        const db = this.open()
        transaction(db, () => {
          rebuildAll(db, docs.map(materialize))
          db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('files',?)").run(
            JSON.stringify(manifestOf(docs)),
          )
        })
      }
      try {
        rebuild()
      } catch (error) {
        if (!isCorrupt(error)) throw error
        this.disconnect()
        const path = this.meta.pathOf('index.sqlite')
        const files = [path, ...sidecars.map((suffix) => path + suffix)]
        for (const file of files) safe(this.meta.store.protectedRoot, file)
        for (const file of files) rmSync(file, { force: true })
        rebuild()
      }
    })
  }

  inspectIndexedChunks() {
    return available(() => {
      if (!statSync(this.meta.pathOf('index.sqlite'), { throwIfNoEntry: false })?.size) return []
      return listChunks(this.open()).map(({ doc: path, lineStart, lineEnd, text }) => ({
        path,
        lineStart,
        lineEnd,
        text,
      }))
    })
  }

  private search(db: DatabaseSync, query: string) {
    safe(this.meta.store.protectedRoot, join(this.meta.store.root, 'aliases.json'))
    return search(db, query, { aliases: loadAliases(this.meta.store.root) })
  }

  queryIndex(query: string) {
    return available(() => this.search(this.open(), query))
  }

  query(
    query: string,
    files: readonly MemoryFile[],
    docs: readonly ReadDocument[],
    liveDocs?: () => readonly ReadDocument[],
  ) {
    return available(() => {
      if (this.closed) throw fault('MEMORY_RECALL_UNAVAILABLE')
      if (!docs.length && !statSync(this.meta.pathOf('index.sqlite'), { throwIfNoEntry: false })?.size)
        return []
      const pinned = new Map(files.map((file) => [file.path, file.hash]))
      const isStale = () => {
        const current = this.meta.store.files()
        return (
          current.length !== files.length ||
          current.some((file) => pinned.get(file.path) !== file.hash) ||
          (liveDocs && JSON.stringify(manifestOf(docs)) !== JSON.stringify(manifestOf(liveDocs())))
        )
      }
      const searchSnapshot = () => {
        using db = new DatabaseSync(':memory:')
        rebuildAll(db, docs.map(materialize))
        return this.search(db, query)
      }
      if (isStale()) return searchSnapshot()
      const db = this.open()
      if (!upToDate(db, docs)) {
        const stale = transaction(db, () => {
          if (upToDate(db, docs)) return false
          if (isStale()) return true
          this.reconcile(db, docs, false)
          return false
        })
        if (stale) {
          this.disconnect()
          return searchSnapshot()
        }
      }
      return this.search(db, query)
    })
  }
}
