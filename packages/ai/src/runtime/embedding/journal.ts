import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type * as W from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'

export type EmbeddingDelivery = { vectorsRef: W.DataRef; usage: W.UsageRecordRequest }
export class EmbeddingConflict extends Error {}
export function openEmbeddingJournal(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (!existsSync(path)) {
    try {
      closeSync(openSync(path, 'wx', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const db = new DatabaseSync(path)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS attempts(identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, delivery TEXT, result TEXT)',
  )
  function inspect(identity: string, fingerprint: string) {
    const row = db.prepare('SELECT * FROM attempts WHERE identity=?').get(identity)
    if (!row) return null
    if (row.fingerprint !== fingerprint) throw new EmbeddingConflict()
    const result = row.result === null ? null : (JSON.parse(String(row.result)) as W.EffectResult)
    const delivery = row.delivery === null ? null : (JSON.parse(String(row.delivery)) as EmbeddingDelivery)
    if (
      (result && !validateRuntime('EffectResult', result).ok) ||
      (delivery &&
        (!validateRuntime('DataRef', delivery.vectorsRef).ok ||
          !validateRuntime('UsageRecordRequest', delivery.usage).ok))
    )
      throw new TypeError('Invalid durable embedding record')
    return { result, delivery }
  }
  return {
    inspect,
    claim(identity: string, fingerprint: string) {
      return (
        db.prepare('INSERT OR IGNORE INTO attempts VALUES (?,?,NULL,NULL)').run(identity, fingerprint)
          .changes === 1
      )
    },
    delivered(identity: string, delivery: EmbeddingDelivery) {
      db.prepare('UPDATE attempts SET delivery=? WHERE identity=? AND delivery IS NULL').run(
        JSON.stringify(delivery),
        identity,
      )
    },
    complete(identity: string, result: W.EffectResult) {
      if (!validateRuntime('EffectResult', result).ok) throw new TypeError('Invalid embedding result')
      db.prepare('UPDATE attempts SET result=? WHERE identity=? AND result IS NULL').run(
        JSON.stringify(result),
        identity,
      )
    },
    pending(): string[] {
      return db
        .prepare('SELECT identity FROM attempts WHERE result IS NULL')
        .all()
        .map((r) => String(r.identity))
    },
    close() {
      db.close()
    },
  }
}
