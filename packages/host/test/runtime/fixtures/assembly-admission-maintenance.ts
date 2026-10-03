import type { DatabaseSync } from 'node:sqlite'
import type { CallContext, MaintenanceStore, Outcome } from '@agnes/extension-api/runtime'
import type {
  MaintenanceEnvelopeJsonValue,
  MaintenanceStoreCommitRequest,
  MaintenanceStoreCommitResult,
  QueryReply,
  ServiceQuery,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { fixtureRef, fixtureWire } from './assembly-maintenance-wire.js'

/** Test maintenance owner sharing the original State connection and its issuer transaction. */
export function sameConnectionMaintenance(
  db: DatabaseSync,
  permitted: (context: CallContext) => boolean,
  hooks: {
    issue?: (request: MaintenanceStoreCommitRequest, context: CallContext) => void
    beforeCommit?: (request: MaintenanceStoreCommitRequest, context: CallContext) => Promise<void>
    afterCommit?: (request: MaintenanceStoreCommitRequest, context: CallContext) => Promise<void>
  } = {},
) {
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL);`)
  const fail = (detailCode: string): Outcome<never> => ({
    ok: false,
    error: {
      code:
        detailCode === 'maintenance_denied'
          ? 'denied'
          : detailCode === 'maintenance_cancelled'
            ? 'cancelled'
            : 'conflict',
      detailCode,
      message: 'Synthetic maintenance operation refused',
      diagnosticId: 'maintenance-fixture',
      retryAdvice: { kind: 'never' },
    },
  })
  const authority = { authorityId: 'fixture-maintenance', tenantId: 'fixture-tenant', authorityEpoch: 1 }
  const target = {
    bindingId: 'fixture-maintenance-binding',
    contract: 'agh.fixture-maintenance',
    logicalName: 'default',
    providerId: 'fixture-maintenance',
  }
  let closed = false
  const read = (database: DatabaseSync, id: string): MaintenanceEnvelopeJsonValue | null => {
    const row = database.prepare('SELECT body FROM records WHERE id=?').get(id)
    return row ? fixtureWire('MaintenanceEnvelopeJsonValue', JSON.parse(String(row.body))) : null
  }
  const get = (id: string) => read(db, id)
  let writes: Promise<unknown> = Promise.resolve()
  async function commit(
    raw: MaintenanceStoreCommitRequest,
    context: CallContext,
  ): Promise<Outcome<MaintenanceStoreCommitResult>> {
    if (!permitted(context)) return fail('maintenance_denied')
    if (context.signal.aborted) return fail('maintenance_cancelled')
    const parsed = validateRuntime('MaintenanceStoreCommitRequest', raw)
    if (!parsed.ok) return fail('schema_invalid')
    const request = parsed.value,
      fingerprint = canonicalJsonDigest(request)
    if (
      canonicalJsonDigest(request.authority) !== canonicalJsonDigest(authority) ||
      request.expectedWriterEpoch !== 1
    )
      return fail('maintenance_epoch_mismatch')
    let committed = false
    try {
      db.exec('BEGIN IMMEDIATE')
      const prior = db
        .prepare('SELECT fingerprint, result FROM transactions WHERE id=?')
        .get(request.transactionId)
      if (prior) {
        db.exec('ROLLBACK')
        return prior.fingerprint === fingerprint
          ? {
              ok: true,
              value: fixtureWire('MaintenanceStoreCommitResult', JSON.parse(String(prior.result))),
            }
          : fail('maintenance_transaction_conflict')
      }
      if (new Set(request.mutations.map((row) => row.recordId)).size !== request.mutations.length)
        throw new Error('duplicate_mutation')
      for (const mutation of request.mutations) {
        const old = read(db, mutation.recordId),
          next = mutation.next
        if (
          (old?.revision ?? null) !== mutation.expectedRevision ||
          next.recordId !== mutation.recordId ||
          next.revision !== (old?.revision ?? 0) + 1 ||
          next.writerEpoch !== 1 ||
          (old && (old.writerEpoch !== 1 || next.createdAt !== old.createdAt)) ||
          next.fingerprint !== canonicalJsonDigest(next.payload)
        )
          throw new Error('maintenance_revision_mismatch')
        db.prepare('INSERT OR REPLACE INTO records VALUES (?,?)').run(mutation.recordId, JSON.stringify(next))
      }
      for (const event of request.outbox) {
        if (
          event.sourceCommitId !== request.transactionId ||
          event.sourceAuthorityId !== authority.authorityId
        )
          throw new Error('outbox_commit_mismatch')
        db.prepare('INSERT INTO outbox VALUES (?,?)').run(event.eventId, JSON.stringify(event))
      }
      hooks.issue?.(request, context)
      await hooks.beforeCommit?.(request, context)
      if (context.signal.aborted) throw new Error('maintenance_cancelled')
      const result = fixtureWire('MaintenanceStoreCommitResult', {
        transactionId: request.transactionId,
        revisions: request.mutations.map(({ recordId, next }) => ({ recordId, revision: next.revision })),
      })
      db.prepare('INSERT INTO transactions VALUES (?,?,?)').run(
        request.transactionId,
        fingerprint,
        JSON.stringify(result),
      )
      db.exec('COMMIT')
      committed = true
      await hooks.afterCommit?.(request, context)
      return { ok: true, value: result }
    } catch (error) {
      if (!committed) {
        try {
          db.exec('ROLLBACK')
        } catch {}
      }
      return fail(error instanceof Error ? error.message : 'maintenance_store_failed')
    }
  }
  const store: MaintenanceStore = {
    commit(request, context) {
      const pending = writes.then(() => commit(request, context))
      writes = pending.then(() => undefined)
      return pending
    },
    async query(request: ServiceQuery, context: CallContext): Promise<Outcome<QueryReply>> {
      if (!permitted(context)) return fail('maintenance_denied')
      if (context.signal.aborted) return fail('maintenance_cancelled')
      if (
        !validateRuntime('ServiceQuery', request).ok ||
        request.method !== 'assembly.records' ||
        canonicalJsonDigest(request.target) !== canonicalJsonDigest(target) ||
        request.input.kind !== 'inline' ||
        request.input.digest !== canonicalJsonDigest(request.input.value)
      )
        return fail('schema_invalid')
      const input = request.input.value
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).join() !== 'recordIds' ||
        !(
          input.recordIds === null ||
          (Array.isArray(input.recordIds) && input.recordIds.every((id) => typeof id === 'string'))
        )
      )
        return fail('schema_invalid')
      const output =
        input.recordIds === null
          ? {
              recordIds: db
                .prepare('SELECT id FROM records ORDER BY id')
                .all()
                .map((row) => String(row.id)),
            }
          : {
              records: (input.recordIds as string[]).flatMap((id) => {
                const record = read(db, id)
                return record ? [record] : []
              }),
            }
      return {
        ok: true,
        value: fixtureWire('QueryReply', {
          kind: 'value',
          output: fixtureRef(output),
          snapshot: 'fixture-snapshot',
        }),
      }
    },
  }
  return {
    store,
    authority,
    target,
    get,
    seed(record: MaintenanceEnvelopeJsonValue) {
      db.prepare('INSERT INTO records VALUES (?,?)').run(record.recordId, JSON.stringify(record))
    },
    inspect() {
      return {
        records: db
          .prepare('SELECT body FROM records ORDER BY id')
          .all()
          .map((row) => fixtureWire('MaintenanceEnvelopeJsonValue', JSON.parse(String(row.body)))),
        outbox: db
          .prepare('SELECT body FROM outbox ORDER BY id')
          .all()
          .map((row) => fixtureWire('OutboxRecord', JSON.parse(String(row.body)))),
        transactions: db
          .prepare('SELECT id FROM transactions ORDER BY id')
          .all()
          .map((row) => String(row.id)),
      }
    },
    close() {
      if (closed) return
      closed = true
      // State owns the shared connection and closes it after the coordinator drains.
    },
  }
}
