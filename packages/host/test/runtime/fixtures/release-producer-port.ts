import { DatabaseSync } from 'node:sqlite'
import type { MaintenanceStore, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type { MaintenanceStoreCommitResult } from '@agnes/protocol/runtime'
import {
  captureReleaseProducerPublication,
  type ProducerPublication,
  type ReleaseProducerCommitPort,
} from '../../../src/runtime/assembly/release-producer.js'
import { fixtureHash, fixtureWire } from './assembly-maintenance-wire.js'
import { producerTestAuthority, producerTestContext } from './release-producer-input.js'

/** Synthetic same-connection commit/source owner, deliberately confined to test fixtures. */
export function producerCommitFixture(
  file: string,
  producer: ReleaseProducerCommitPort['producer'],
  options: { readonly?: boolean; reverseReceipt?: boolean; afterCommit?: () => void } = {},
) {
  const db = new DatabaseSync(file, { readOnly: options.readonly ?? false })
  if (!options.readonly)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, source TEXT NOT NULL, contents TEXT NOT NULL);`)
  const receipts = new WeakSet<MaintenanceStoreCommitResult>()
  let closed = false,
    now = '2026-10-03T00:00:00Z'
  const fail = (detailCode: string): Outcome<never> => ({
    ok: false,
    error: {
      code: 'conflict',
      detailCode,
      message: 'Test submission refused',
      diagnosticId: 'producer-test-port',
      retryAdvice: { kind: 'never' },
    },
  })
  const read = (transactionId: string): ProducerPublication | null => {
    const row = db.prepare('SELECT * FROM publications WHERE id=?').get(transactionId)
    if (!row) return null
    const request = fixtureWire('MaintenanceStoreCommitRequest', JSON.parse(String(row.request)))
    const receipt = fixtureWire('MaintenanceStoreCommitResult', JSON.parse(String(row.receipt)))
    for (const member of request.mutations) {
      const record = db.prepare('SELECT body FROM records WHERE id=?').get(member.recordId)
      if (!record || jcs(JSON.parse(String(record.body))) !== jcs(member.next))
        throw new Error('original_member_missing')
    }
    if (fixtureHash(request) !== row.fingerprint) throw new Error('original_commit_mismatch')
    receipts.add(receipt)
    const contents = JSON.parse(String(row.contents)) as {
      kind: 'json' | 'bytes'
      digest: string
      body: string
    }[]
    return {
      request,
      receipt,
      source: fixtureWire('DataRef', JSON.parse(String(row.source))),
      contents: contents.map((item) => ({ ...item, body: Buffer.from(item.body, 'base64') })),
    }
  }
  const store: MaintenanceStore = {
    async query() {
      return fail('fixture_query_unused')
    },
    async commit(request, context) {
      if (options.readonly || closed) return fail('fixture_readonly')
      const original = captureReleaseProducerPublication(request, context)
      const parsed = fixtureWire('MaintenanceStoreCommitRequest', request)
      const existing = read(parsed.transactionId)
      if (existing)
        return fixtureHash(existing.request) === fixtureHash(parsed)
          ? { ok: true, value: existing.receipt }
          : fail('maintenance_transaction_conflict')
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const mutation of parsed.mutations) {
          const old = db.prepare('SELECT body FROM records WHERE id=?').get(mutation.recordId)
          if (old || mutation.expectedRevision !== null || mutation.next.revision !== 1)
            throw new Error('maintenance_revision_conflict')
          db.prepare('INSERT INTO records VALUES(?,?)').run(mutation.recordId, jcs(mutation.next))
        }
        const revisions = parsed.mutations.map((row) => ({
          recordId: row.recordId,
          revision: row.next.revision,
        }))
        if (options.reverseReceipt) revisions.reverse()
        const receipt = fixtureWire('MaintenanceStoreCommitResult', {
          transactionId: parsed.transactionId,
          revisions,
        })
        db.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?)').run(
          parsed.transactionId,
          fixtureHash(parsed),
          jcs(parsed),
          jcs(receipt),
          jcs(original.source),
          JSON.stringify(
            original.contents.map((item) => ({ ...item, body: Buffer.from(item.body).toString('base64') })),
          ),
        )
        db.exec('COMMIT')
        receipts.add(receipt)
        options.afterCommit?.()
        return { ok: true, value: receipt }
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw error
      }
    },
  }
  const port: ReleaseProducerCommitPort = {
    store,
    authority: { authorityId: 'fixture-maintenance', tenantId: 'fixture-tenant', authorityEpoch: 1 },
    stateAuthority: producerTestAuthority,
    writerEpoch: 1,
    headRecordId: 'fixture-current-head',
    producer,
    scope: producerTestContext().scope,
    now: () => now,
    async readPublication(id) {
      return read(id)
    },
    async acceptPublishedAdmissionRelease(receipt) {
      if (!receipts.has(receipt)) throw new Error('foreign_native_receipt')
    },
  }
  return {
    port,
    db,
    setNow(value: string) {
      now = value
    },
    changes() {
      return db.prepare('SELECT total_changes() AS n').get()?.n
    },
    close() {
      if (!closed) {
        closed = true
        db.close()
      }
    },
  }
}
