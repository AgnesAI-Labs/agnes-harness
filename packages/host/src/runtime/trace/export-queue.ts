import { closeSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'

export class TraceConflict extends Error {}
export function openTraceQueue(path: string, capacity = 256) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024)
    throw new RangeError('invalid trace capacity')
  if (!existsSync(dirname(path))) createPrivateDirectorySync(dirname(path))
  if (!existsSync(path)) closeSync(createPrivateFileSync(path))
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS batches(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,owner TEXT,digest TEXT,body TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS consent(id TEXT PRIMARY KEY,body TEXT);
    CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,digest TEXT,body TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS chains(id TEXT PRIMARY KEY,body TEXT);`)
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return {
    freeze(consent: W.TelemetryConsent) {
      if (!validateRuntime('TelemetryConsent', consent).ok) throw new TypeError('invalid consent')
      return transaction(() => {
        const row = db.prepare('SELECT body FROM consent WHERE id=?').get(consent.sessionId)
        if (row) {
          const fixed = JSON.parse(String(row.body))
          if (canonicalJsonDigest(fixed) !== canonicalJsonDigest(consent))
            throw new TraceConflict('session consent changed')
          return fixed as W.TelemetryConsent
        }
        db.prepare('INSERT INTO consent VALUES (?,?)').run(consent.sessionId, JSON.stringify(consent))
        return structuredClone(consent)
      })
    },
    record(owner: string, input: W.TraceRecordRequest, disabled: boolean): W.TraceRecordResult {
      return transaction(() => {
        const id = canonicalJsonDigest({ owner, batch: input.batchId }),
          digest = canonicalJsonDigest(input)
        const old = db.prepare('SELECT * FROM batches WHERE id=?').get(id)
        if (old) {
          if (old.digest !== digest) throw new TraceConflict('batch changed')
          return JSON.parse(String(old.result))
        }
        const count = Number(db.prepare('SELECT count(*) AS n FROM batches').get()?.n)
        if (count >= capacity) throw new RangeError('trace batch capacity reached')
        const occupied = Number(
          db.prepare('SELECT coalesce(sum(json_array_length(body)),0) AS n FROM batches').get()?.n,
        )
        const accepted = disabled ? 0 : Math.min(input.spans.length, Math.max(0, capacity - occupied)),
          dropped = input.spans.length - accepted
        const result = { accepted, dropped }
        db.prepare('INSERT INTO batches(id,owner,digest,body,result) VALUES (?,?,?,?,?)').run(
          id,
          owner,
          digest,
          JSON.stringify(input.spans.slice(0, accepted)),
          JSON.stringify(result),
        )
        return result
      })
    },
    page(owner: string, cursor: number, limit: number) {
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > capacity
      )
        throw new RangeError('invalid trace cursor')
      return db
        .prepare('SELECT seq,body FROM batches WHERE owner=? AND seq>? ORDER BY seq LIMIT ?')
        .all(owner, cursor, limit)
        .map((r) => ({ cursor: Number(r.seq), spans: JSON.parse(String(r.body)) as W.TraceSpan[] }))
    },
    stats(owner: string) {
      const row = db
        .prepare(
          "SELECT coalesce(sum(json_extract(result,'$.accepted')),0) AS accepted,coalesce(sum(json_extract(result,'$.dropped')),0) AS dropped,coalesce(max(seq),0) AS cursor FROM batches WHERE owner=?",
        )
        .get(owner)
      return {
        accepted: Number(row?.accepted),
        dropped: Number(row?.dropped),
        cursor: Number(row?.cursor),
        replayFrom: 0,
      }
    },
    prepare(id: string, digest: string, body: unknown) {
      return transaction(() => {
        const old = db.prepare('SELECT * FROM exports WHERE id=?').get(id)
        if (old) {
          if (old.digest !== digest) throw new TraceConflict('export changed')
          return {
            created: false,
            body: JSON.parse(String(old.body)),
            result: old.result === null ? null : (JSON.parse(String(old.result)) as W.TelemetryExportResult),
          }
        }
        db.prepare('INSERT INTO exports VALUES (?,?,?,NULL)').run(id, digest, JSON.stringify(body))
        return { created: true, body, result: null }
      })
    },
    complete(id: string, session: string, result: W.TelemetryExportResult, receipt: unknown) {
      transaction(() => {
        db.prepare('UPDATE exports SET result=? WHERE id=? AND result IS NULL').run(
          JSON.stringify(result),
          id,
        )
        db.prepare('INSERT INTO chains VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(
          session,
          JSON.stringify(receipt),
        )
      })
    },
    chain(session: string): { chain: string } | null {
      const r = db.prepare('SELECT body FROM chains WHERE id=?').get(session)
      return r ? JSON.parse(String(r.body)) : null
    },
    pending(): string[] {
      return db
        .prepare('SELECT id FROM exports WHERE result IS NULL')
        .all()
        .map((r) => String(r.id))
    },
    close() {
      db.close()
    },
  }
}
export type TraceQueue = ReturnType<typeof openTraceQueue>
