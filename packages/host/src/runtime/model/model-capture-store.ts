import { closeSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ManualRoute } from '@agnes/ai'
import { jcs } from '@agnes/protocol'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { restoreModelCatalog, type SelectedModelCatalog } from './model-catalog-capture.js'

export class ModelCaptureConflict extends Error {}

export type ModelCaptureStore = Readonly<{
  /** Writes once, keyed by the catalog digest, and returns that digest. */
  retain(catalog: SelectedModelCatalog): string
  /** The retained catalog, or undefined when absent or when the stored content no longer matches its digest. */
  read(digest: string): SelectedModelCatalog | undefined
  close(): void
}>

/** Content-addressed and write-once: a prepared request is always loaded from the catalog it was prepared from. */
export function openModelCaptureStore(path: string): ModelCaptureStore {
  if (!existsSync(dirname(path))) createPrivateDirectorySync(dirname(path))
  if (!existsSync(path)) closeSync(createPrivateFileSync(path))
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS captures (digest TEXT PRIMARY KEY, body TEXT NOT NULL);`)
  return {
    retain(catalog) {
      const body = jcs(catalog.snapshot())
      db.prepare('INSERT OR IGNORE INTO captures(digest, body) VALUES(?, ?)').run(catalog.digest, body)
      const stored = db.prepare('SELECT body FROM captures WHERE digest = ?').get(catalog.digest)
      if (!stored || stored.body !== body) throw new ModelCaptureConflict('capture digest already holds other content')
      return catalog.digest
    },
    read(digest) {
      const row = db.prepare('SELECT body FROM captures WHERE digest = ?').get(digest)
      if (!row || typeof row.body !== 'string') return undefined
      const restored = restoreModelCatalog(JSON.parse(row.body) as ManualRoute[])
      return restored.digest === digest ? restored : undefined
    },
    close: () => db.close(),
  }
}
