import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { jcs } from '@agnes/protocol'
import { type AuditAppend, type ReceiptPointer, validateRuntime } from '@agnes/protocol/runtime'
import { windowsAppendPrivateFileSync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { createPlatform } from '../../adapters/platform.js'

export type AuditWrite = {
  readonly identity: string
  readonly fingerprint: string
  readonly scopeKey: string
  readonly input: AuditAppend
}
export type AuditRow = AuditWrite & { readonly sequence: number; readonly auditRef: ReceiptPointer }
export type AuditFaultPoint = 'before-write' | 'after-write' | 'before-commit' | 'after-commit'
export class AuditConflict extends Error {}

/** A private durable owner. Named methods never expose a database or transaction callback. */
export function openAuditStore(
  path: string,
  authorityId: string,
  fault: (point: AuditFaultPoint) => void = () => {},
) {
  const windows = createPlatform().os === 'win32'
  if (windows) {
    windowsEnsurePrivateDirectorySync(dirname(path))
    windowsAppendPrivateFileSync(path, Buffer.alloc(0))
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (lstatSync(dirname(path)).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink()))
      throw new Error('audit owner path is a link')
    chmodSync(dirname(path), 0o700)
  }
  const db = new DatabaseSync(path)
  if (!windows) chmodSync(path, 0o600)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS audit_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), authority TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_rows (sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL, receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_facts (identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_outbox (delivery TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit_inbox (delivery TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, identity TEXT NOT NULL, source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_exports (identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, receipt TEXT);`)
  db.prepare('INSERT OR IGNORE INTO audit_owner VALUES (1,?)').run(authorityId)
  if (
    (db.prepare('SELECT authority FROM audit_owner').get() as { authority: string }).authority !== authorityId
  ) {
    db.close()
    throw new AuditConflict('audit authority changed')
  }
  let closed = false
  const guard = () => {
    if (closed) throw new Error('audit owner closed')
  }
  const transaction = <T>(write: () => T): T => {
    guard()
    db.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      fault('before-write')
      const result = write()
      fault('after-write')
      fault('before-commit')
      db.exec('COMMIT')
      committed = true
      fault('after-commit')
      return result
    } catch (error) {
      if (!committed) db.exec('ROLLBACK')
      throw error
    }
  }
  const validateWrite = (write: AuditWrite) => {
    if (
      !validateRuntime('AuditAppend', write.input).ok ||
      write.fingerprint !== createHash('sha256').update(jcs(write.input)).digest('hex') ||
      !/^[a-f0-9]{64}$/.test(write.identity) ||
      !validateRuntime('ScopeRef', JSON.parse(write.scopeKey)).ok ||
      jcs(JSON.parse(write.scopeKey)) !== write.scopeKey
    )
      throw new AuditConflict('audit fingerprint invalid')
  }
  const find = (identity: string): AuditRow | null => {
    const row = db
      .prepare('SELECT sequence,identity,fingerprint,scope,body,receipt FROM audit_rows WHERE identity=?')
      .get(identity) as
      | {
          sequence: number
          identity: string
          fingerprint: string
          scope: string
          body: string
          receipt: string
        }
      | undefined
    if (!row) return null
    const write = JSON.parse(row.body) as AuditWrite
    validateWrite(write)
    const receipt = JSON.parse(row.receipt) as ReceiptPointer
    if (
      write.identity !== row.identity ||
      write.fingerprint !== row.fingerprint ||
      write.scopeKey !== row.scope ||
      jcs(receipt) !== jcs({ authorityId, receiptId: `audit-${identity}`, digest: write.fingerprint })
    )
      throw new AuditConflict('stored audit fact inconsistent')
    return { ...write, sequence: row.sequence, auditRef: receipt }
  }
  const put = (write: AuditWrite): ReceiptPointer => {
    validateWrite(write)
    const existing = find(write.identity)
    if (existing) {
      if (existing.fingerprint !== write.fingerprint) throw new AuditConflict('audit identity conflict')
      return existing.auditRef
    }
    const auditRef = { authorityId, receiptId: `audit-${write.identity}`, digest: write.fingerprint }
    db.prepare('INSERT INTO audit_rows(identity,fingerprint,scope,body,receipt) VALUES (?,?,?,?,?)').run(
      write.identity,
      write.fingerprint,
      write.scopeKey,
      jcs(write),
      jcs(auditRef),
    )
    return auditRef
  }
  const fact = (identity: string, body: unknown) => {
    const text = jcs(body),
      fingerprint = createHash('sha256').update(text).digest('hex')
    const old = db.prepare('SELECT fingerprint FROM audit_facts WHERE identity=?').get(identity) as
      | { fingerprint: string }
      | undefined
    if (old && old.fingerprint !== fingerprint) throw new AuditConflict('fact identity conflict')
    db.prepare('INSERT OR IGNORE INTO audit_facts VALUES (?,?,?)').run(identity, fingerprint, text)
  }
  return {
    authorityId,
    append(write: AuditWrite) {
      return transaction(() => put(write))
    },
    /** Same-domain fact and audit are committed by this same owner transaction. */
    commitFactAndAudit(identity: string, body: unknown, write: AuditWrite) {
      return transaction(() => {
        fact(identity, body)
        return put(write)
      })
    },
    /** Cross-domain source commits its fact and recoverable outbox intent together. */
    commitFactAndIntent(identity: string, body: unknown, delivery: string, write: AuditWrite) {
      transaction(() => {
        validateWrite(write)
        fact(identity, body)
        const intent = jcs({
          sourceFactId: identity,
          sourceFactDigest: createHash('sha256').update(jcs(body)).digest('hex'),
          write,
        })
        const old = db.prepare('SELECT fingerprint,body FROM audit_outbox WHERE delivery=?').get(delivery) as
          | { fingerprint: string; body: string }
          | undefined
        if (old && (old.fingerprint !== write.fingerprint || old.body !== intent))
          throw new AuditConflict('delivery identity conflict')
        db.prepare('INSERT OR IGNORE INTO audit_outbox(delivery,fingerprint,body) VALUES (?,?,?)').run(
          delivery,
          write.fingerprint,
          intent,
        )
      })
    },
    pending() {
      guard()
      return (
        db
          .prepare('SELECT delivery,body FROM audit_outbox WHERE acknowledged=0 ORDER BY delivery LIMIT 500')
          .all() as { delivery: string; body: string }[]
      ).map((row) => ({
        delivery: row.delivery,
        write: (JSON.parse(row.body) as { write: AuditWrite }).write,
        sourceOwnerId: authorityId,
      }))
    },
    acceptDelivery(delivery: string, write: AuditWrite, sourceOwnerId: string) {
      return transaction(() => {
        const old = db
          .prepare('SELECT fingerprint,identity,source FROM audit_inbox WHERE delivery=?')
          .get(delivery) as { fingerprint: string; identity: string; source: string } | undefined
        if (
          old &&
          (old.fingerprint !== write.fingerprint ||
            old.identity !== write.identity ||
            old.source !== sourceOwnerId)
        )
          throw new AuditConflict('delivery conflict')
        const receipt = put(write)
        db.prepare('INSERT OR IGNORE INTO audit_inbox VALUES (?,?,?,?)').run(
          delivery,
          write.fingerprint,
          write.identity,
          sourceOwnerId,
        )
        return receipt
      })
    },
    acknowledge(delivery: string, fingerprint: string) {
      transaction(() => {
        const result = db
          .prepare('UPDATE audit_outbox SET acknowledged=1 WHERE delivery=? AND fingerprint=?')
          .run(delivery, fingerprint)
        if (result.changes !== 1) throw new AuditConflict('outbox acknowledgement conflict')
      })
    },
    page(scopeKey: string, after: number, limit: number): AuditRow[] {
      guard()
      return (
        db
          .prepare('SELECT identity FROM audit_rows WHERE scope=? AND sequence>? ORDER BY sequence LIMIT ?')
          .all(scopeKey, after, limit) as { identity: string }[]
      ).map((row) => find(row.identity) as AuditRow)
    },
    readFact(identity: string): unknown {
      guard()
      const row = db.prepare('SELECT body FROM audit_facts WHERE identity=?').get(identity) as
        | { body: string }
        | undefined
      return row ? JSON.parse(row.body) : null
    },
    prepareExport(identity: string, fingerprint: string, body: unknown) {
      return transaction(() => {
        const old = db
          .prepare('SELECT fingerprint,state,body,receipt FROM audit_exports WHERE identity=?')
          .get(identity) as
          | { fingerprint: string; state: string; body: string; receipt: string | null }
          | undefined
        if (old) {
          if (old.fingerprint !== fingerprint) throw new AuditConflict('export identity conflict')
          return { ...old, created: false }
        }
        db.prepare('INSERT INTO audit_exports VALUES (?,?,?, ?,NULL)').run(
          identity,
          fingerprint,
          'pending',
          jcs(body),
        )
        return { fingerprint, state: 'pending', body: jcs(body), receipt: null, created: true }
      })
    },
    readExport(identity: string) {
      guard()
      return db
        .prepare('SELECT fingerprint,state,body,receipt FROM audit_exports WHERE identity=?')
        .get(identity) as
        | { fingerprint: string; state: string; body: string; receipt: string | null }
        | undefined
    },
    pendingOwnerIds() {
      guard()
      return (
        db
          .prepare(
            "SELECT identity AS id FROM audit_exports WHERE state='pending' UNION ALL SELECT delivery AS id FROM audit_outbox WHERE acknowledged=0 LIMIT 500",
          )
          .all() as { id: string }[]
      ).map((row) => `audit-${createHash('sha256').update(row.id).digest('hex')}`)
    },
    completeExport(identity: string, fingerprint: string, receipt: unknown) {
      transaction(() => {
        const old = db
          .prepare('SELECT receipt FROM audit_exports WHERE identity=? AND fingerprint=?')
          .get(identity, fingerprint) as { receipt: string | null } | undefined
        if (!old) throw new AuditConflict('export owner missing')
        if (old.receipt !== null && old.receipt !== jcs(receipt))
          throw new AuditConflict('export receipt conflict')
        db.prepare('UPDATE audit_exports SET state=?,receipt=? WHERE identity=?').run(
          'completed',
          jcs(receipt),
          identity,
        )
      })
    },
    close() {
      if (!closed) {
        closed = true
        db.close()
      }
    },
  }
}
export type AuditStore = ReturnType<typeof openAuditStore>
