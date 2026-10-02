import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { jcs } from '@agnes/protocol'
import { type AuditAppend, type ReceiptPointer, validateRuntime } from '@agnes/protocol/runtime'
import { windowsAppendPrivateFileSync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'

export type AuditWrite = {
  readonly identity: string
  readonly fingerprint: string
  readonly scopeKey: string
  readonly input: AuditAppend
}
export type AuditRow = AuditWrite & { readonly sequence: number; readonly auditRef: ReceiptPointer }
export class AuditConflict extends Error {}
/** Independent reference layout: all facts are tagged immutable values, not the default table algorithm. */
export function openReferenceAuditStore(
  path: string,
  authorityId: string,
  fault: (point: 'before-write' | 'after-write' | 'before-commit' | 'after-commit') => void = () => {},
) {
  const windows = process.platform === 'win32'
  if (windows) {
    windowsEnsurePrivateDirectorySync(dirname(path))
    windowsAppendPrivateFileSync(path, Buffer.alloc(0))
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (lstatSync(dirname(path)).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink()))
      throw new Error('reference audit owner path is a link')
    chmodSync(dirname(path), 0o700)
  }
  const db = new DatabaseSync(path)
  if (!windows) chmodSync(path, 0o600)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS facts(ordinal INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(tag,key))',
  )
  const get = (tag: string, key: string): unknown => {
    const row = db.prepare('SELECT value FROM facts WHERE tag=? AND key=?').get(tag, key) as
      | { value: string }
      | undefined
    return row ? JSON.parse(row.value) : null
  }
  const set = (tag: string, key: string, value: unknown) => {
    db.prepare(
      'INSERT INTO facts(tag,key,value) VALUES(?,?,?) ON CONFLICT(tag,key) DO UPDATE SET value=excluded.value',
    ).run(tag, key, jcs(value))
  }
  db.prepare("INSERT OR IGNORE INTO facts(tag,key,value) VALUES('owner','authority',?)").run(jcs(authorityId))
  const owner = get('owner', 'authority')
  if (owner !== null && owner !== authorityId) {
    db.close()
    throw new AuditConflict('reference audit authority changed')
  }
  let closed = false
  const gate = () => {
    if (closed) throw new Error('reference audit closed')
  }
  const tx = <T>(write: () => T): T => {
    gate()
    db.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      fault('before-write')
      const value = write()
      fault('after-write')
      fault('before-commit')
      db.exec('COMMIT')
      committed = true
      fault('after-commit')
      return value
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
  const validateSaved = (key: string, value: { write: AuditWrite; receipt: ReceiptPointer }) => {
    validateWrite(value.write)
    if (
      value.write.identity !== key ||
      jcs(value.receipt) !== jcs({ authorityId, receiptId: `audit-${key}`, digest: value.write.fingerprint })
    )
      throw new AuditConflict('reference stored audit fact inconsistent')
  }
  const append = (write: AuditWrite) => {
    validateWrite(write)
    const old = get('audit', write.identity) as { write: AuditWrite; receipt: ReceiptPointer } | null
    if (old) {
      validateSaved(write.identity, old)
      if (old.write.fingerprint !== write.fingerprint)
        throw new AuditConflict('reference audit fingerprint conflict')
      return old.receipt
    }
    const receipt = { authorityId, receiptId: `audit-${write.identity}`, digest: write.fingerprint }
    set('audit', write.identity, { write, receipt })
    return receipt
  }
  const fact = (identity: string, body: unknown) => {
    const text = jcs(body)
    const old = get('domain', identity)
    if (old !== null && jcs(old) !== text) throw new AuditConflict('reference source fact conflict')
    set('domain', identity, body)
  }
  return {
    authorityId,
    append(write: AuditWrite) {
      return tx(() => append(write))
    },
    commitFactAndAudit(identity: string, body: unknown, write: AuditWrite) {
      return tx(() => {
        fact(identity, body)
        return append(write)
      })
    },
    commitFactAndIntent(identity: string, body: unknown, delivery: string, write: AuditWrite) {
      tx(() => {
        validateWrite(write)
        fact(identity, body)
        const source = { factId: identity, factDigest: createHash('sha256').update(jcs(body)).digest('hex') }
        const old = get('outgoing', delivery) as {
          write: AuditWrite
          source: typeof source
          done: boolean
        } | null
        if (old && (jcs(old.write) !== jcs(write) || jcs(old.source) !== jcs(source)))
          throw new AuditConflict('reference intent conflict')
        if (!old) set('outgoing', delivery, { write, source, done: false })
      })
    },
    pending() {
      gate()
      return (
        db
          .prepare(
            "SELECT ordinal,key,value FROM facts WHERE tag='outgoing' AND json_extract(value,'$.done')=0 ORDER BY ordinal LIMIT 500",
          )
          .all() as { ordinal: number; key: string; value: string }[]
      )
        .map((row) => ({
          delivery: row.key,
          ...(JSON.parse(row.value) as { write: AuditWrite; done: boolean }),
        }))
        .map(({ delivery, write }) => ({ delivery, write, sourceOwnerId: authorityId }))
    },
    acceptDelivery(delivery: string, write: AuditWrite, sourceOwnerId: string) {
      return tx(() => {
        const old = get('incoming', delivery) as {
          identity: string
          fingerprint: string
          source: string
        } | null
        if (
          old &&
          (old.identity !== write.identity ||
            old.fingerprint !== write.fingerprint ||
            old.source !== sourceOwnerId)
        )
          throw new AuditConflict('reference inbox conflict')
        const receipt = append(write)
        set('incoming', delivery, {
          identity: write.identity,
          fingerprint: write.fingerprint,
          source: sourceOwnerId,
        })
        return receipt
      })
    },
    acknowledge(delivery: string, fingerprint: string) {
      tx(() => {
        const old = get('outgoing', delivery) as { write: AuditWrite; done: boolean } | null
        if (!old || old.write.fingerprint !== fingerprint)
          throw new AuditConflict('reference acknowledgement conflict')
        set('outgoing', delivery, { ...old, done: true })
      })
    },
    page(scopeKey: string, after: number, limit: number): AuditRow[] {
      gate()
      const rows = db
        .prepare(
          "SELECT ordinal,key,value FROM facts WHERE tag='audit' AND ordinal>? AND json_extract(value,'$.write.scopeKey')=? ORDER BY ordinal LIMIT ?",
        )
        .all(after, scopeKey, limit) as { ordinal: number; key: string; value: string }[]
      return rows.map((row) => {
        const value = JSON.parse(row.value) as { write: AuditWrite; receipt: ReceiptPointer }
        validateSaved(row.key, value)
        return { ...value.write, sequence: row.ordinal, auditRef: value.receipt }
      })
    },
    readFact(identity: string) {
      gate()
      return get('domain', identity)
    },
    prepareExport(identity: string, fingerprint: string, body: unknown) {
      return tx(() => {
        const old = get('archive', identity) as {
          fingerprint: string
          state: string
          body: string
          receipt: string | null
        } | null
        if (old) {
          if (old.fingerprint !== fingerprint) throw new AuditConflict('reference export identity conflict')
          return { ...old, created: false }
        }
        const value = { fingerprint, state: 'pending', body: jcs(body), receipt: null }
        set('archive', identity, value)
        return { ...value, created: true }
      })
    },
    readExport(identity: string) {
      gate()
      return (
        (get('archive', identity) as {
          fingerprint: string
          state: string
          body: string
          receipt: string | null
        } | null) ?? undefined
      )
    },
    pendingOwnerIds() {
      gate()
      return (
        db
          .prepare(
            "SELECT key FROM facts WHERE (tag='archive' AND json_extract(value,'$.state')='pending') OR (tag='outgoing' AND json_extract(value,'$.done')=0) LIMIT 500",
          )
          .all() as { key: string }[]
      ).map((row) => `audit-${createHash('sha256').update(row.key).digest('hex')}`)
    },
    completeExport(identity: string, fingerprint: string, receipt: unknown) {
      tx(() => {
        const old = get('archive', identity) as {
          fingerprint: string
          state: string
          body: string
          receipt: string | null
        } | null
        if (!old || old.fingerprint !== fingerprint || (old.receipt !== null && old.receipt !== jcs(receipt)))
          throw new AuditConflict('reference export receipt conflict')
        set('archive', identity, { ...old, state: 'completed', receipt: jcs(receipt) })
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
export type AuditStore = ReturnType<typeof openReferenceAuditStore>
