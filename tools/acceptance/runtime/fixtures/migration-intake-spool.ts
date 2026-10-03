import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Synthetic late evidence. No dispatch, billing, State fence or writer credentials live in this fixture. */
export interface MigrationIntakeEnvelope {
  readonly eventId: string
  readonly actionId: string
  readonly attemptId: string
  readonly bindingId: string
  readonly inputDigest: string
  readonly externalRequestId: string
  readonly kind: 'receipt' | 'usage' | 'answer' | 'control'
  readonly payload: string
}
export type IntakeAcceptance =
  | { readonly ack: true; readonly duplicate: boolean }
  | { readonly ack: false; readonly reason: 'capacity' | 'conflict' | 'persistence' | 'invalid' }
export interface IntakeSpoolOptions {
  readonly file: string
  readonly authorityDirectories: readonly [string, string]
  readonly capacityBytes: number
  readonly capacityItems: number
  readonly beforeCommit?: () => void
}
function physical(path: string): string {
  let parent = resolve(path)
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
  return resolve(realpathSync(parent), relative(parent, resolve(path)))
}
function separate(left: string, right: string): boolean {
  const path = relative(left, right)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}
/** Independent local SQLite WAL spool, with a durable inbox of original IDs retained after replay. */
export function openMigrationIntakeSpool(options: IntakeSpoolOptions) {
  const file = physical(options.file)
  if (
    !options.authorityDirectories.every((path) => separate(physical(path), file)) ||
    !Number.isSafeInteger(options.capacityBytes) ||
    options.capacityBytes < 1 ||
    !Number.isSafeInteger(options.capacityItems) ||
    options.capacityItems < 1
  )
    throw new Error('Invalid independent spool configuration')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS intake (identity TEXT PRIMARY KEY, digest TEXT NOT NULL, envelope TEXT NOT NULL,
      bytes INTEGER NOT NULL, replayed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS limits (singleton INTEGER PRIMARY KEY CHECK(singleton=1), bytes INTEGER NOT NULL, items INTEGER NOT NULL);`)
  db.prepare('INSERT OR IGNORE INTO limits VALUES (1, ?, ?)').run(
    options.capacityBytes,
    options.capacityItems,
  )
  const limits = db.prepare('SELECT bytes, items FROM limits WHERE singleton=1').get()!
  if (limits.bytes !== options.capacityBytes || limits.items !== options.capacityItems) {
    db.close()
    throw new Error('Spool limits changed on reopen')
  }
  const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
  return {
    accept(envelope: MigrationIntakeEnvelope): IntakeAcceptance {
      if (
        ![
          envelope.eventId,
          envelope.actionId,
          envelope.attemptId,
          envelope.bindingId,
          envelope.externalRequestId,
        ].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 1024) ||
        !/^[a-f0-9]{64}$/.test(envelope.inputDigest) ||
        !['receipt', 'usage', 'answer', 'control'].includes(envelope.kind) ||
        typeof envelope.payload !== 'string'
      )
        return { ack: false, reason: 'invalid' }
      // Stable event plus all original execution identities. Different attempts/requests stay distinct.
      const identity = hash(
        JSON.stringify([
          envelope.eventId,
          envelope.actionId,
          envelope.attemptId,
          envelope.bindingId,
          envelope.externalRequestId,
          envelope.kind,
        ]),
      )
      const text = JSON.stringify({
        eventId: envelope.eventId,
        actionId: envelope.actionId,
        attemptId: envelope.attemptId,
        bindingId: envelope.bindingId,
        inputDigest: envelope.inputDigest,
        externalRequestId: envelope.externalRequestId,
        kind: envelope.kind,
        payload: envelope.payload,
      })
      const digest = hash(text),
        bytes = Buffer.byteLength(text)
      try {
        db.exec('BEGIN IMMEDIATE')
        const prior = db.prepare('SELECT digest FROM intake WHERE identity=?').get(identity)
        if (prior) {
          db.exec('ROLLBACK')
          return prior.digest === digest ? { ack: true, duplicate: true } : { ack: false, reason: 'conflict' }
        }
        // Tombstones also consume the bound: capacity never disguises unlimited persistent dedupe state.
        const used = db
          .prepare('SELECT COUNT(*) AS items, COALESCE(SUM(bytes),0) AS bytes FROM intake')
          .get()!
        if (
          Number(used.items) >= options.capacityItems ||
          Number(used.bytes) + bytes > options.capacityBytes
        ) {
          db.exec('ROLLBACK')
          return { ack: false, reason: 'capacity' }
        }
        db.prepare('INSERT INTO intake(identity,digest,envelope,bytes) VALUES(?,?,?,?)').run(
          identity,
          digest,
          text,
          bytes,
        )
        options.beforeCommit?.()
        db.exec('COMMIT')
        return { ack: true, duplicate: false }
      } catch {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* A failed transaction never yields an ACK. */
        }
        return { ack: false, reason: 'persistence' }
      }
    },
    async replay(accept: (envelope: MigrationIntakeEnvelope) => Promise<void>): Promise<number> {
      let replayed = 0
      for (;;) {
        const row = db
          .prepare('SELECT identity,envelope FROM intake WHERE replayed=0 ORDER BY rowid LIMIT 1')
          .get()
        if (!row) return replayed
        // Target must dedupe by original IDs; a crash after its acceptance can cause safe redelivery.
        await accept(JSON.parse(String(row.envelope)) as MigrationIntakeEnvelope)
        db.prepare('UPDATE intake SET replayed=1 WHERE identity=?').run(row.identity!)
        replayed++
      }
    },
    pending(): number {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM intake WHERE replayed=0').get()!.n)
    },
    close(): void {
      db.close()
    },
  }
}
