import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeErrorDetails,
  validateOutboxDeadLetter,
  validateRuntime,
} from '@agnes/protocol/runtime'

// Same shapes as the Local SPI Outcome and as the core domain command port; this package does not
// depend on either, so they meet structurally at assembly.
type Outcome<T> = { ok: true; value: T } | { ok: false; error: Wire.RuntimeError }
type Delivery = Readonly<{ deliveryId: Wire.Id; runtimeRef: Wire.PublicRef }>
type AcceptedHandle = Exclude<Wire.CommandHandle, { status: 'not-accepted' }>

/** One accepted command; a not-accepted result stays with the daemon and is never journaled. */
export type StoredDomainCommand = Readonly<{
  key: Wire.Digest
  fingerprint: Wire.Digest
  name: string
  handle: AcceptedHandle
  value: Wire.DataRef | null
  dispatchKeys: readonly string[]
}>
export type StoredDomainState = Readonly<{ value: Wire.DataRef | null; revision: number }>
export type StoredDispatch = Readonly<{
  commandId: Wire.Id
  key: string
  destination: Wire.Id
  sourceCommitId: Wire.Id
  event: Wire.DomainEvent
  dispatch: Wire.DomainDispatch
  fingerprint: Wire.Digest
}>
export type DispatchProgress = Readonly<{ key: string; ack: Delivery | null }>

export interface DomainStoreTransaction {
  command(key: Wire.Digest): StoredDomainCommand | undefined
  putCommand(command: StoredDomainCommand): void
  state(): StoredDomainState
  putState(state: StoredDomainState): void
  lastSequence(): number
  putEvent(record: Wire.DomainEventRecord): void
  putDispatch(dispatch: StoredDispatch): void
  dispatches(commandId: Wire.Id): readonly DispatchProgress[]
}

export type OutboxDelivery = Readonly<{
  record: Wire.OutboxRecord
  event: Wire.DomainEvent
  dispatch: Wire.DomainDispatch
}>
/** Hands one row to its destination. Delivery is at least once; the destination dedupes by event id. */
export type OutboxSink = (delivery: OutboxDelivery) => Promise<Outcome<Delivery>>
export type OutboxMethod = 'deadLetters' | 'redriveOutbox'

export type DomainStoreOptions = Readonly<{
  file: string
  /** The source authority that owns every row of this store. */
  owner: Wire.RecordOwner
  /** Current operations or repair permission; the store never grants it on its own. */
  permits(context: Wire.CallContextWire, method: OutboxMethod, scope: Wire.ScopeRef): Promise<boolean>
  now?: () => number
  maxFailures?: number
  leaseMs?: number
  batch?: number
}>

type OutboxRow = {
  source_authority_id: string
  event_id: string
  destination: string
  command_id: string
  dispatch_key: string
  source_commit_id: string
  type_id: string
  payload_json: string
  fingerprint: string
  envelope_json: string
  delivery: Wire.OutboxRecord['delivery']
  attempts: number
  next_attempt_ms: number
  claim_owner: string | null
  claim_epoch: number
  claim_until_ms: number | null
  ack_ref: string | null
  runtime_ref_json: string | null
  consecutive_failures: number
  last_error_json: string | null
  delivery_revision: number
  dead_ms: number | null
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS domain_commands (
    key TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, body_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS domain_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, value_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS domain_events (
    authority_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (authority_id, sequence), UNIQUE (authority_id, event_id))`,
  `CREATE TABLE IF NOT EXISTS domain_outbox (
    source_authority_id TEXT NOT NULL, event_id TEXT NOT NULL, destination TEXT NOT NULL,
    command_id TEXT NOT NULL, dispatch_key TEXT NOT NULL, source_commit_id TEXT NOT NULL,
    type_id TEXT NOT NULL, payload_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
    envelope_json TEXT NOT NULL, scope_json TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('pending', 'claimed', 'acked', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0, accepted_ms INTEGER NOT NULL, next_attempt_ms INTEGER NOT NULL,
    claim_owner TEXT, claim_epoch INTEGER NOT NULL DEFAULT 0, claim_until_ms INTEGER,
    ack_ref TEXT, runtime_ref_json TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error_json TEXT, delivery_revision INTEGER NOT NULL DEFAULT 1, dead_ms INTEGER,
    PRIMARY KEY (source_authority_id, event_id, destination), UNIQUE (command_id, dispatch_key))`,
  'CREATE INDEX IF NOT EXISTS domain_outbox_due ON domain_outbox (delivery, next_attempt_ms)',
  // Publication identity lookups find events by key whichever path committed them.
  `CREATE INDEX IF NOT EXISTS domain_events_key
    ON domain_events (authority_id, json_extract(record_json, '$.event.idempotencyKey'))`,
  `CREATE TABLE IF NOT EXISTS domain_redrives (
    identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, record_json TEXT NOT NULL)`,
]

const KEY = 'source_authority_id = ? AND event_id = ? AND destination = ?'
const SECOND = 1000
const backoff = (failures: number) => Math.min(60 * SECOND, SECOND * 2 ** (failures - 1))
const iso = (ms: number) => new Date(ms).toISOString()

export function fail(
  detail: keyof typeof RuntimeErrorDetails,
  message: string,
  diagnosticId = 'domain-outbox',
): { ok: false; error: Wire.RuntimeError } {
  const kinds: readonly string[] = RuntimeErrorDetails[detail].retryAdviceKinds
  return {
    ok: false,
    error: {
      code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
      detailCode: detail,
      message,
      retryAdvice: { kind: kinds.includes('never') ? 'never' : 'retry_read' },
      diagnosticId,
    },
  }
}

/** Parses a stored value and rejects it unless the frozen schema still accepts it. */
function stored<K extends Parameters<typeof validateRuntime>[0]>(name: K, json: string) {
  const parsed = validateRuntime(name, JSON.parse(json))
  if (!parsed.ok) throw new Error(`stored ${String(name)} failed its schema`)
  return parsed.value
}

/**
 * The durable store of one domain owner: command journal, state, event records, dispatch outbox and
 * redrive records share one SQLite database, so one transaction commits them together.
 */
export function openDomainStore(options: DomainStoreOptions) {
  const { owner } = options
  const now = options.now ?? Date.now
  const maxFailures = options.maxFailures ?? 20
  const leaseMs = options.leaseMs ?? 30 * SECOND
  const authorityId = owner.authority.authorityId
  const db = new DatabaseSync(options.file)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    // Flushes WAL checkpoints past the drive cache on darwin; other platforms ignore it.
    db.exec('PRAGMA checkpoint_fullfsync = ON')
    for (const statement of DDL) db.exec(statement)
  } catch (error) {
    db.close()
    throw error
  }

  const get = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as T | undefined
  const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[]
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params)

  function atomic<T>(body: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = body()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Report the original failure; a failed rollback has nothing further to commit.
      }
      throw error
    }
  }

  const keyOf = (row: OutboxRow): Wire.OutboxDeliveryKey => ({
    sourceAuthorityId: row.source_authority_id,
    eventId: row.event_id,
    destination: row.destination,
  })
  const keyParams = (key: Wire.OutboxDeliveryKey) => [key.sourceAuthorityId, key.eventId, key.destination]

  /** Assembles the frozen two-arm record; a row the schema refuses is never handed out. */
  function record(row: OutboxRow): Wire.OutboxRecord {
    const parsed = validateRuntime('OutboxRecord', {
      eventId: row.event_id,
      sourceAuthorityId: row.source_authority_id,
      sourceCommitId: row.source_commit_id,
      destination: row.destination,
      typeId: row.type_id,
      payload: JSON.parse(row.payload_json),
      fingerprint: row.fingerprint,
      delivery: row.delivery,
      attempts: row.attempts,
      nextAttemptAt: iso(row.next_attempt_ms),
      claim:
        row.claim_owner === null
          ? null
          : { ownerId: row.claim_owner, epoch: row.claim_epoch, until: iso(row.claim_until_ms ?? 0) },
      ackRef: row.ack_ref,
      consecutiveFailures: row.consecutive_failures,
      lastError: row.last_error_json === null ? null : JSON.parse(row.last_error_json),
    })
    if (!parsed.ok) throw new Error(`outbox row ${row.event_id} failed its schema`)
    return parsed.value
  }

  // A row belongs to a scope when every field the scope names matches the row's own scope.
  function scopeFilter(scope: Wire.ScopeRef, column = 'scope_json', root = '$') {
    const fields = Object.entries(scope).filter(([field]) => field !== 'kind')
    return {
      sql: fields.map(() => ` AND json_extract(${column}, ?) = ?`).join(''),
      params: fields.flatMap(([field, value]) => [`${root}.${field}`, value as string]),
    }
  }

  // Commits made through this instance only; another connection to the same file does not notify.
  const listeners = new Set<() => unknown>()
  let wrote = false
  const tx: DomainStoreTransaction = {
    command(key) {
      const row = get<{ body_json: string }>('SELECT body_json FROM domain_commands WHERE key = ?', key)
      if (!row) return undefined
      const command = JSON.parse(row.body_json) as StoredDomainCommand
      const handle = validateRuntime('CommandHandle', command.handle)
      if (!handle.ok) throw new Error('stored command handle failed its schema')
      // Such a row can only be corruption, so it proves nothing about this key.
      if (handle.value.status === 'not-accepted') throw new Error('stored command was never accepted')
      return command
    },
    putCommand(command) {
      // The type already excludes it; an untyped caller is refused here.
      if ((command.handle as Wire.CommandHandle).status === 'not-accepted')
        throw new Error('only accepted commands are journaled')
      run(
        'INSERT INTO domain_commands (key, command_id, body_json) VALUES (?, ?, ?)',
        command.key,
        command.handle.commandId,
        jcs(command),
      )
      wrote = true
    },
    state() {
      const row = get<{ revision: number; value_json: string }>(
        'SELECT revision, value_json FROM domain_state',
      )
      return row
        ? { value: stored('DataRef', row.value_json), revision: row.revision }
        : { value: null, revision: 0 }
    },
    putState(state) {
      if (state.value === null) throw new Error('domain state cannot be cleared by a command')
      // Compare-and-swap in SQL as well: the new revision must follow the stored one exactly.
      const changed = run(
        `INSERT INTO domain_state (id, revision, value_json) SELECT 1, ?, ?
         WHERE ? = COALESCE((SELECT revision FROM domain_state), 0) + 1
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, value_json = excluded.value_json`,
        state.revision,
        jcs(state.value),
        state.revision,
      )
      if (changed.changes !== 1) throw new Error('domain state revision moved')
      wrote = true
    },
    lastSequence() {
      return (
        get<{ sequence: number | null }>(
          'SELECT MAX(sequence) AS sequence FROM domain_events WHERE authority_id = ?',
          authorityId,
        )?.sequence ?? 0
      )
    },
    putEvent(input) {
      const parsed = validateRuntime('DomainEventRecord', input)
      if (!parsed.ok || parsed.value.authorityId !== authorityId)
        throw new Error('event record is not this authority')
      run(
        'INSERT INTO domain_events (authority_id, sequence, event_id, record_json) VALUES (?, ?, ?, ?)',
        authorityId,
        parsed.value.sequence,
        parsed.value.event.eventId,
        jcs(parsed.value),
      )
      wrote = true
    },
    putDispatch(row) {
      const at = now()
      run(
        `INSERT INTO domain_outbox (source_authority_id, event_id, destination, command_id, dispatch_key,
           source_commit_id, type_id, payload_json, fingerprint, envelope_json, scope_json, delivery,
           accepted_ms, next_attempt_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        authorityId,
        row.event.eventId,
        row.destination,
        row.commandId,
        row.key,
        row.sourceCommitId,
        row.event.typeId,
        jcs(row.event.payload),
        row.fingerprint,
        jcs({ event: row.event, dispatch: row.dispatch }),
        jcs(row.event.scope),
        at,
        at,
      )
      wrote = true
    },
    dispatches(commandId) {
      return all<OutboxRow>('SELECT * FROM domain_outbox WHERE command_id = ?', commandId).map((row) => ({
        key: row.dispatch_key,
        ack:
          row.delivery === 'acked' && row.ack_ref !== null && row.runtime_ref_json !== null
            ? { deliveryId: row.ack_ref, runtimeRef: stored('PublicRef', row.runtime_ref_json) }
            : null,
      }))
    },
  }

  function claim(ownerId: string, at: number): OutboxRow[] {
    return atomic(() => {
      const due = all<OutboxRow>(
        `SELECT * FROM domain_outbox
         WHERE (delivery = 'pending' AND next_attempt_ms <= ?) OR (delivery = 'claimed' AND claim_until_ms <= ?)
         ORDER BY next_attempt_ms, event_id LIMIT ?`,
        at,
        at,
        options.batch ?? 100,
      )
      return due.map((row) => {
        run(
          `UPDATE domain_outbox SET delivery = 'claimed', claim_owner = ?, claim_epoch = claim_epoch + 1,
             claim_until_ms = ?, attempts = attempts + 1, delivery_revision = delivery_revision + 1
           WHERE ${KEY}`,
          ownerId,
          at + leaseMs,
          ...keyParams(keyOf(row)),
        )
        return get<OutboxRow>(
          `SELECT * FROM domain_outbox WHERE ${KEY}`,
          ...keyParams(keyOf(row)),
        ) as OutboxRow
      })
    })
  }

  function settle(row: OutboxRow, result: Outcome<Delivery>): 'acked' | 'retrying' | 'dead' | 'lost' {
    const at = now()
    return atomic(() => {
      const key = keyParams(keyOf(row))
      // Only the current lease holder settles; a newer claim owns the row now.
      if (
        !get(
          `SELECT 1 FROM domain_outbox WHERE ${KEY} AND delivery = 'claimed' AND claim_epoch = ?`,
          ...key,
          row.claim_epoch,
        )
      )
        return 'lost'
      if (result.ok) {
        run(
          `UPDATE domain_outbox SET delivery = 'acked', ack_ref = ?, runtime_ref_json = ?, claim_owner = NULL,
             claim_until_ms = NULL, consecutive_failures = 0, last_error_json = NULL,
             delivery_revision = delivery_revision + 1
           WHERE ${KEY}`,
          result.value.deliveryId,
          jcs(result.value.runtimeRef),
          ...key,
        )
        return 'acked'
      }
      const failures = row.consecutive_failures + 1
      const dead = failures >= maxFailures
      run(
        `UPDATE domain_outbox SET delivery = ?, claim_owner = NULL, claim_until_ms = NULL,
           consecutive_failures = ?, last_error_json = ?, next_attempt_ms = ?, dead_ms = ?,
           delivery_revision = delivery_revision + 1
         WHERE ${KEY}`,
        dead ? 'dead' : 'pending',
        failures,
        jcs(result.error),
        at + backoff(failures),
        dead ? at : null,
        ...key,
      )
      return dead ? 'dead' : 'retrying'
    })
  }

  async function deliver(sink: OutboxSink, row: OutboxRow): Promise<Outcome<Delivery>> {
    const envelope = JSON.parse(row.envelope_json) as { event: unknown; dispatch: unknown }
    const event = validateRuntime('DomainEvent', envelope.event)
    const dispatch = validateRuntime('DomainDispatch', envelope.dispatch)
    if (!event.ok || !dispatch.ok) return fail('integrity', 'stored dispatch envelope failed its schema')
    const delivery = { record: record(row), event: event.value, dispatch: dispatch.value }
    try {
      const result = await sink(delivery)
      if (
        result.ok &&
        (!validateRuntime('Id', result.value.deliveryId).ok ||
          !validateRuntime('PublicRef', result.value.runtimeRef).ok)
      )
        return fail('integrity', 'destination returned a malformed acknowledgement')
      return result
    } catch (error) {
      return fail('backend_unavailable', error instanceof Error ? error.message : 'destination unavailable')
    }
  }

  return {
    async transaction<T>(body: (transaction: DomainStoreTransaction) => T): Promise<T> {
      wrote = false
      const value = atomic(() => body(tx))
      // After a commit that wrote and before this resolves; a listener's failure never reaches the commit.
      if (wrote) for (const listener of [...listeners]) void (async () => listener())().catch(() => {})
      return value
    },

    /** Calls the listener after each commit that wrote through this store; returns its unsubscribe. */
    subscribeCommitted(listener: () => unknown): () => void {
      const own = () => listener()
      listeners.add(own)
      return () => listeners.delete(own)
    },

    /** Event records of this authority after a sequence, oldest first. */
    events(afterSequence: number, limit: number): Wire.DomainEventRecord[] {
      return all<{ record_json: string }>(
        'SELECT record_json FROM domain_events WHERE authority_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
        authorityId,
        afterSequence,
        limit,
      ).map((row) => stored('DomainEventRecord', row.record_json))
    },

    /** The authority that numbers every event of this store. */
    authorityId,

    /** How many events this authority holds and its first and last sequence; a gap shows as a mismatch. */
    eventHistory() {
      return get<{ count: number; first: number | null; last: number | null }>(
        `SELECT COUNT(*) AS count, MIN(sequence) AS first, MAX(sequence) AS last
         FROM domain_events WHERE authority_id = ?`,
        authorityId,
      ) as { count: number; first: number | null; last: number | null }
    },

    /** The id of the event stored at `sequence`, if one is. */
    eventIdAt(sequence: number): string | undefined {
      return get<{ event_id: string }>(
        'SELECT event_id FROM domain_events WHERE authority_id = ? AND sequence = ?',
        authorityId,
        sequence,
      )?.event_id
    },

    /** Event records under an idempotency key, oldest first, whichever path committed them. */
    eventsByKey(idempotencyKey: string): Wire.DomainEventRecord[] {
      return all<{ record_json: string }>(
        `SELECT record_json FROM domain_events
         WHERE authority_id = ? AND json_extract(record_json, '$.event.idempotencyKey') = ? ORDER BY sequence`,
        authorityId,
        idempotencyKey,
      ).map((row) => stored('DomainEventRecord', row.record_json))
    },

    /** Event records in (after, upto] within `scope` and of the listed types (any type when none is). */
    eventsIn(
      after: number,
      upto: number,
      scope: Wire.ScopeRef,
      types: readonly string[],
      limit: number,
    ): Wire.DomainEventRecord[] {
      const filter = scopeFilter(scope, 'record_json', '$.event.scope')
      const listed = JSON.stringify(types)
      return all<{ record_json: string }>(
        `SELECT record_json FROM domain_events WHERE authority_id = ? AND sequence > ? AND sequence <= ?
           AND (? = '[]' OR json_extract(record_json, '$.event.typeId') IN (SELECT value FROM json_each(?)))
           ${filter.sql} ORDER BY sequence LIMIT ?`,
        authorityId,
        after,
        upto,
        listed,
        listed,
        ...filter.params,
        limit,
      ).map((row) => stored('DomainEventRecord', row.record_json))
    },

    record(key: Wire.OutboxDeliveryKey): Wire.OutboxRecord | undefined {
      const row = get<OutboxRow>(`SELECT * FROM domain_outbox WHERE ${KEY}`, ...keyParams(key))
      return row && record(row)
    },

    /** Claims due rows under a lease, delivers each, then acks it or backs it off toward dead. */
    async flush(sink: OutboxSink, ownerId = 'outbox-delivery') {
      const counts = { acked: 0, retrying: 0, dead: 0, lost: 0 }
      for (const row of claim(ownerId, now())) counts[settle(row, await deliver(sink, row))]++
      return counts
    },

    /** The Local outbox administration companion for this owner's rows. */
    control: {
      async deadLetters(
        request: Wire.OutboxDeadLettersRequest,
        context: Wire.CallContextWire,
      ): Promise<Outcome<Wire.PageOutboxDeadLetterItem>> {
        const parsed = validateRuntime('OutboxDeadLettersRequest', request)
        if (!parsed.ok) return fail('invalid_request', 'dead letter request does not match its schema')
        const { scope, destination, cursor, limit } = parsed.value
        if (!(await options.permits(context, 'deadLetters', scope)))
          return fail('permission_denied', 'caller may not read dead letters in this scope')
        const binding = canonicalJsonDigest({ owner, scope, destination })
        let after = { deadAt: -1, eventId: '', destination: '' }
        if (cursor !== null) {
          let decoded: (typeof after & { binding: string }) | undefined
          try {
            decoded = JSON.parse(cursor)
          } catch {
            decoded = undefined
          }
          if (decoded?.binding !== binding)
            return fail('invalid_request', 'cursor belongs to another listing')
          after = decoded
        }
        const filter = scopeFilter(scope)
        // ponytail: keyset paging; a redrive between pages only removes rows and never repeats one.
        const rows = all<OutboxRow>(
          `SELECT * FROM domain_outbox WHERE delivery = 'dead' AND (? IS NULL OR destination = ?)${filter.sql}
             AND (dead_ms, event_id, destination) > (?, ?, ?)
           ORDER BY dead_ms, event_id, destination LIMIT ?`,
          destination,
          destination,
          ...filter.params,
          after.deadAt,
          after.eventId,
          after.destination,
          limit + 1,
        )
        const page = rows.slice(0, limit)
        const items: Wire.OutboxDeadLetterItem[] = []
        for (const row of page) {
          const item = validateOutboxDeadLetter({
            delivery: keyOf(row),
            outbox: record(row),
            owner,
            deliveryRevision: row.delivery_revision,
            deadAt: iso(row.dead_ms ?? 0),
          })
          if (!item.ok) return fail('integrity', 'dead letter does not match its delivery')
          items.push(item.value)
        }
        const last = page.at(-1)
        return {
          ok: true,
          value: {
            items,
            snapshot: binding,
            nextCursor:
              rows.length > limit && last
                ? JSON.stringify({
                    binding,
                    deadAt: last.dead_ms,
                    eventId: last.event_id,
                    destination: last.destination,
                  })
                : null,
            complete: rows.length <= limit,
          },
        }
      },

      async redriveOutbox(
        request: Wire.OutboxRedriveRequest,
        context: Wire.CallContextWire,
      ): Promise<Outcome<Wire.OutboxRedriveResult>> {
        const parsed = validateRuntime('OutboxRedriveRequest', request)
        if (!parsed.ok) return fail('invalid_request', 'redrive request does not match its schema')
        const { requestId, scope, delivery, expectedDeliveryRevision, reason } = parsed.value
        if (!(await options.permits(context, 'redriveOutbox', scope)))
          return fail('permission_denied', 'caller may not repair deliveries in this scope')
        const identity = canonicalJsonDigest({
          authority: owner.authority,
          scope: owner.scope,
          principalRef: context.principalRef,
          method: 'redriveOutbox',
          requestId,
        })
        const fingerprint = canonicalJsonDigest({ delivery, expectedDeliveryRevision, scope, reason })
        const at = now()
        return atomic((): Outcome<Wire.OutboxRedriveResult> => {
          const prior = get<{ record_json: string }>(
            'SELECT record_json FROM domain_redrives WHERE identity = ?',
            identity,
          )
          if (prior) {
            const decided = stored('OutboxRedriveRecord', prior.record_json)
            return decided.fingerprint === fingerprint
              ? { ok: true, value: decided.result }
              : fail('idempotency_conflict', 'request id already names another redrive')
          }
          const filter = scopeFilter(scope)
          const row = get<OutboxRow>(
            `SELECT * FROM domain_outbox WHERE ${KEY}${filter.sql}`,
            ...keyParams(delivery),
            ...filter.params,
          )
          if (!row) return fail('not_found', 'no such delivery in this scope')
          if (row.delivery !== 'dead')
            return fail('revision_conflict', 'only a dead delivery can be redriven')
          if (row.delivery_revision !== expectedDeliveryRevision)
            return fail('revision_conflict', 'delivery revision moved')
          const result = {
            delivery,
            state: 'pending' as const,
            deliveryRevision: expectedDeliveryRevision + 1,
          }
          const decision = validateRuntime('OutboxRedriveRecord', {
            owner,
            request: parsed.value,
            actorRef: context.principalRef,
            fingerprint,
            acceptedAt: iso(at),
            authorizationRef: context.authorizationRef,
            result,
          })
          if (!decision.ok) return fail('internal_error', 'redrive record failed its own schema')
          // Keeps attempts, lastError, the event id, payload and source commit; retries from first acceptance.
          const changed = run(
            `UPDATE domain_outbox SET delivery = 'pending', claim_owner = NULL, claim_until_ms = NULL,
               consecutive_failures = 0, next_attempt_ms = accepted_ms, dead_ms = NULL,
               delivery_revision = delivery_revision + 1
             WHERE ${KEY} AND delivery = 'dead' AND delivery_revision = ?`,
            ...keyParams(delivery),
            expectedDeliveryRevision,
          )
          if (changed.changes !== 1) throw new Error('delivery moved during redrive')
          run(
            'INSERT INTO domain_redrives (identity, fingerprint, record_json) VALUES (?, ?, ?)',
            identity,
            fingerprint,
            jcs(decision.value),
          )
          return { ok: true, value: result }
        })
      },
    },

    close() {
      listeners.clear()
      db.close()
    },
  }
}

export type DomainStore = ReturnType<typeof openDomainStore>
