import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeErrorDetails,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  validateEventsPublishSchemas,
  validateRuntime,
} from '@agnes/protocol/runtime'

export const EVENTS_PROVIDER = { id: 'reference.events', contract: 'agh.events' } as const

type Detail = keyof typeof RuntimeErrorDetails

class Refused extends Error {
  constructor(readonly error: Wire.RuntimeError) {
    super(error.message)
  }
}

const problem = (detail: Detail, message: string): Wire.RuntimeError => ({
  code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
  detailCode: detail,
  message,
  retryAdvice: { kind: RuntimeErrorDetails[detail].retryAdviceKinds[0] } as Wire.RuntimeError['retryAdvice'],
  diagnosticId: 'reference-events',
})

function stop(detail: Detail, message: string): never {
  throw new Refused(problem(detail, message))
}

function parse<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const checked = validateRuntime(name, value)
  return checked.ok ? checked.value : stop('invalid_request', `${name} is malformed`)
}

/** What the Host wires in: producer registration, the aggregate authority and the reader check. */
export type ReferenceEventsOptions = Readonly<{
  binding: Wire.BindingRef
  /** The authority that numbers every event of this store. */
  authorityId: string
  access: {
    producer(typeId: string, schema: Wire.SchemaRef, context: CallContext): Promise<Outcome<Wire.BindingRef>>
    revision(aggregate: Wire.DomainObjectRef): Promise<number | null>
    /** Trusted immutable ownership and current coverage; a stale revision may still replay. */
    origin(
      aggregate: Wire.DomainObjectRef,
      causation: Wire.PublicRef,
      producer: Wire.BindingRef,
      context: CallContext,
    ): Promise<Outcome<{ scope: Wire.ScopeRef; causation: Wire.DomainEvent['causation'] }>>
    /** Holds current producer and origin authority through the synchronous callback. */
    withCommit<T>(
      typeId: string,
      schema: Wire.SchemaRef,
      aggregate: Wire.DomainObjectRef,
      causation: Wire.PublicRef,
      context: CallContext,
      body: (facts: {
        producer: Wire.BindingRef
        scope: Wire.ScopeRef
        causation: Wire.DomainEvent['causation']
        /** Current aggregate revision held against changes until body returns. */
        revision: number | null
      }) => T,
    ): Outcome<T>
    canRead(scope: Wire.ScopeRef, context: CallContext): Promise<boolean>
  }
}>

const TABLE = `CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY, publication TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  type_id TEXT NOT NULL, scope TEXT NOT NULL, record TEXT NOT NULL)`
const CURSOR_KEY_TABLE = `CREATE TABLE IF NOT EXISTS events_cursor_authority (
  slot INTEGER PRIMARY KEY CHECK (slot = 1), authority_id TEXT NOT NULL,
  signing_key TEXT NOT NULL, highwater INTEGER NOT NULL)`
const WIDEST_PAGE = 500
const MAX_PENDING_READS = 8

/**
 * The reference agh.events provider: committed events in one SQLite table, numbered by sequence under
 * one authority. A publication's idempotency identity commits in the same row as its event, so a lost
 * reply never makes a second event. A cursor names the sequence read up to and the query it was issued
 * for, so it stays valid across restarts; any other cursor asks the caller to resync.
 */
export function openEventsStore(path: string, options: ReferenceEventsOptions) {
  const { binding, authorityId, access } = options
  if (typeof access.withCommit !== 'function')
    throw new Error('event publication requires a bound commit authority')
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(TABLE)
    const recorded = db
      .prepare("SELECT DISTINCT json_extract(record, '$.authorityId') AS authority_id FROM events")
      .all() as { authority_id: string | null }[]
    if (recorded.some((row) => row.authority_id !== authorityId))
      throw new Error('event store belongs to another authority')
    db.exec(CURSOR_KEY_TABLE)
    const established = db.prepare('SELECT authority_id FROM events_cursor_authority WHERE slot = 1').get() as
      | { authority_id: string }
      | undefined
    if (established !== undefined && established.authority_id !== authorityId)
      throw new Error('event store belongs to another authority')
    db.prepare(`INSERT OR IGNORE INTO events_cursor_authority (slot, authority_id, signing_key, highwater)
      SELECT 1, ?, ?, COALESCE(MAX(sequence), 0) FROM events`).run(
      authorityId,
      randomBytes(32).toString('hex'),
    )
  } catch (error) {
    // A file that is not this store must not keep the handle open.
    db.close()
    throw error
  }
  let open = true
  let pendingReads = 0
  const waitingReads = new Set<() => void>()
  const signingKey = Buffer.from(
    (
      db.prepare('SELECT signing_key FROM events_cursor_authority WHERE slot = 1').get() as {
        signing_key: string
      }
    ).signing_key,
    'hex',
  )

  const head = () =>
    (db.prepare('SELECT MAX(sequence) AS head FROM events').get() as { head: number | null }).head ?? 0
  const highwater = () =>
    (
      db.prepare('SELECT highwater FROM events_cursor_authority WHERE slot = 1').get() as {
        highwater: number
      }
    ).highwater
  const historyIntact = () => {
    const present = db
      .prepare(`SELECT a.highwater AS stored, COUNT(e.sequence) AS count,
        MIN(e.sequence) AS first, MAX(e.sequence) AS last
        FROM events_cursor_authority a LEFT JOIN events e ON a.slot = 1 WHERE a.slot = 1`)
      .get() as { stored: number; count: number; first: number | null; last: number | null }
    return (
      present.count === present.stored &&
      (present.stored === 0
        ? present.first === null && present.last === null
        : present.first === 1 && present.last === present.stored)
    )
  }
  const refOf = (eventId: string): Wire.EventsPublishResult => ({
    eventRef: { kind: 'event', authorityId, eventId },
  })

  const readerOf = (context: CallContext) =>
    canonicalJsonDigest({ principalRef: context.principalRef, bindingId: context.bindingId })
  const cursorOf = (
    query: string,
    reader: string,
    kind: 'page' | 'checkpoint',
    sequence: number,
    top: number,
  ) => {
    const payload = [authorityId, query, reader, kind, sequence, top]
    const signature = createHmac('sha256', signingKey).update(JSON.stringify(payload)).digest('base64url')
    return Buffer.from(JSON.stringify([...payload, signature])).toString('base64url')
  }
  function position(cursor: string | null, query: string, reader: string): { after: number; top: number } {
    if (!historyIntact()) stop('resync_required', 'event history has a gap')
    if (cursor === null) return { after: 0, top: head() }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    } catch {
      parsed = null
    }
    const [authority, issuedFor, issuedTo, kind, sequence, top, signature] = Array.isArray(parsed)
      ? parsed
      : []
    const payload = [authority, issuedFor, issuedTo, kind, sequence, top]
    const expected = createHmac('sha256', signingKey).update(JSON.stringify(payload)).digest()
    const received = typeof signature === 'string' ? Buffer.from(signature, 'base64url') : Buffer.alloc(0)
    if (
      authority !== authorityId ||
      issuedFor !== query ||
      issuedTo !== reader ||
      (kind !== 'page' && kind !== 'checkpoint') ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Number.isSafeInteger(top) ||
      top < sequence ||
      top > head() ||
      (kind === 'checkpoint' && sequence !== top) ||
      received.length !== expected.length ||
      !timingSafeEqual(received.length === expected.length ? received : expected, expected)
    )
      stop('resync_required', 'cursor was not issued for this query by this authority')
    return { after: sequence, top: kind === 'page' ? top : head() }
  }

  function transact<T>(body: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      db.exec('COMMIT')
      return result
    } catch (caught) {
      db.exec('ROLLBACK')
      throw caught
    }
  }

  async function subscribe(input: unknown, context: CallContext): Promise<Wire.EventsSubscribeResult> {
    const request = parse('EventsSubscribeRequest', input)
    if (pendingReads >= MAX_PENDING_READS) {
      const error = problem('rate_limit', 'event reads are temporarily saturated')
      throw new Refused({
        ...error,
        retryAdvice: { kind: 'retry_read', notBefore: new Date(Date.now() + 1000).toISOString() },
      })
    }
    pendingReads++
    let onAbort: (() => void) | undefined
    let onClose: (() => void) | undefined
    try {
      if (context.signal.aborted) stop('cancelled', 'event read was cancelled')
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Refused(problem('cancelled', 'event read was cancelled')))
        context.signal.addEventListener('abort', onAbort, { once: true })
      })
      const closed = new Promise<never>((_, reject) => {
        onClose = () => reject(new Refused(problem('backend_unavailable', 'events store is closed')))
        waitingReads.add(onClose)
      })
      const permitted = await Promise.race([access.canRead(request.scopeRef, context), cancelled, closed])
      if (context.signal.aborted) stop('cancelled', 'event read was cancelled')
      if (!open) stop('backend_unavailable', 'events store is closed')
      if (!permitted) stop('permission_denied', 'caller may not read events in this scope')
      if (request.limit < 1) stop('invalid_request', 'a page holds at least one event')
      const query = canonicalJsonDigest({ scopeRef: request.scopeRef, types: request.types })
      const reader = readerOf(context)
      const { after, top } = position(request.cursor, query, reader)
      const limit = Math.min(request.limit, WIDEST_PAGE)
      const types = JSON.stringify(request.types)
      // An event belongs to the scope when every field the scope names matches the event's own scope.
      const fields = Object.entries(request.scopeRef).filter(([field]) => field !== 'kind')
      const rows = db
        .prepare(
          `SELECT sequence, record FROM events WHERE sequence > ? AND sequence <= ?
         AND (? = '[]' OR type_id IN (SELECT value FROM json_each(?)))
         ${fields.map(() => 'AND json_extract(scope, ?) = ?').join(' ')}
         ORDER BY sequence LIMIT ?`,
        )
        .all(
          after,
          top,
          types,
          types,
          ...fields.flatMap(([field, value]) => [`$.${field}`, value]),
          limit + 1,
        ) as {
        sequence: number
        record: string
      }[]
      const complete = rows.length <= limit
      const items = rows.slice(0, limit)
      return parse('EventsSubscribeResult', {
        page: {
          items: items.map((row) => JSON.parse(row.record)),
          snapshot: `${authorityId}@${top}`,
          nextCursor: complete ? null : cursorOf(query, reader, 'page', items.at(-1)?.sequence ?? after, top),
          complete,
        },
        checkpoint: complete ? cursorOf(query, reader, 'checkpoint', top, top) : null,
        resyncRequired: false,
      })
    } finally {
      if (onAbort) context.signal.removeEventListener('abort', onAbort)
      if (onClose) waitingReads.delete(onClose)
      pendingReads--
    }
  }

  async function publish(input: unknown, context: CallContext): Promise<Wire.EventsPublishResult> {
    const checked = validateEventsPublishSchemas(input)
    if (!checked.ok) stop('invalid_request', 'publication is malformed')
    const request = checked.value
    // Authorization precedes idempotency lookup: a revoked producer cannot read or replay an old key.
    const producer = await access.producer(request.typeId, request.domainSchema, context)
    if (!producer.ok) throw new Refused(producer.error)
    const origin = await access.origin(request.aggregate, request.causationRef, producer.value, context)
    if (!origin.ok) throw new Refused(origin.error)
    const scope = parse('ScopeRef', origin.value.scope)
    if (
      !Object.entries(context.scope).every(
        ([field, value]) => field === 'kind' || scope[field as keyof Wire.ScopeRef] === value,
      )
    )
      stop('permission_denied', 'producer context does not cover the original aggregate scope')
    if (context.signal.aborted) stop('cancelled', 'publication was cancelled')
    const publication = canonicalJsonDigest({
      binding: producer.value.bindingId,
      scope,
      typeId: request.typeId,
      key: request.idempotencyKey,
    })
    const fingerprint = canonicalJsonDigest({
      aggregate: request.aggregate,
      schema: request.domainSchema,
      payload: request.payload,
      causation: request.causationRef,
    })
    const withAuthority = <T>(body: (facts: { revision: number | null }) => T): T => {
      let calls = 0
      const checked = access.withCommit(
        request.typeId,
        request.domainSchema,
        request.aggregate,
        request.causationRef,
        context,
        (facts) => {
          if (calls !== 0) stop('permission_denied', 'commit authority invoked the publication twice')
          calls = 1
          if (
            jcs(facts.producer) !== jcs(producer.value) ||
            jcs(facts.scope) !== jcs(scope) ||
            jcs(facts.causation) !== jcs(origin.value.causation)
          )
            stop('permission_denied', 'producer or aggregate origin changed while publication waited')
          return body(facts)
        },
      )
      if (!checked.ok) throw new Refused(checked.error)
      if (calls !== 1) stop('permission_denied', 'commit authority did not execute the publication')
      return checked.value
    }
    // The original event is the only replay authority; a mismatched row is not a usable receipt.
    const earlier = () => {
      const row = db
        .prepare('SELECT sequence, fingerprint, type_id, scope, record FROM events WHERE publication = ?')
        .get(publication) as
        | { sequence: number; fingerprint: string; type_id: string; scope: string; record: string }
        | undefined
      if (row === undefined) return undefined
      let stored: unknown
      let storedScope: unknown
      try {
        stored = JSON.parse(row.record)
        storedScope = JSON.parse(row.scope)
      } catch {
        stop('integrity', 'published event record is damaged')
      }
      const checked = validateRuntime('DomainEventRecord', stored)
      if (
        !checked.ok ||
        checked.value.authorityId !== authorityId ||
        checked.value.sequence !== row.sequence ||
        checked.value.fingerprint !== row.fingerprint ||
        row.type_id !== request.typeId ||
        checked.value.event.typeId !== row.type_id ||
        checked.value.event.idempotencyKey !== request.idempotencyKey ||
        jcs(checked.value.event.scope) !== jcs(scope) ||
        jcs(storedScope) !== jcs(scope) ||
        jcs(checked.value.event.source) !== jcs(producer.value)
      )
        stop('integrity', 'published event ownership is inconsistent')
      if (row.fingerprint !== fingerprint)
        stop('idempotency_conflict', 'idempotency key was used for another publication')
      if (jcs(checked.value.aggregate) !== jcs(request.aggregate))
        stop('integrity', 'published aggregate differs from its fingerprint')
      return refOf(checked.value.event.eventId)
    }
    const replayed = withAuthority(() =>
      transact(() => {
        if (!historyIntact()) stop('resync_required', 'event history has a gap')
        return earlier()
      }),
    )
    if (replayed) return replayed
    const current = await access.revision(request.aggregate)
    if (current === null) stop('not_found', 'aggregate is unknown to its authority')
    if (current !== request.aggregate.revision)
      stop('revision_conflict', 'aggregate is not at its current revision')
    if (context.signal.aborted) stop('cancelled', 'publication was cancelled')
    return withAuthority((facts) =>
      transact(() => {
        if (!historyIntact()) stop('resync_required', 'event history has a gap')
        // A call with the same key may have committed while this one waited for admission.
        const raced = earlier()
        if (raced) return raced
        if (facts.revision !== request.aggregate.revision)
          stop('revision_conflict', 'aggregate is not at its current revision')
        const eventId = randomUUID()
        const record = parse('DomainEventRecord', {
          event: {
            eventId,
            typeId: request.typeId,
            schema: request.domainSchema,
            source: producer.value,
            scope,
            occurredAt: new Date().toISOString(),
            payload: request.payload,
            idempotencyKey: request.idempotencyKey,
            causation: origin.value.causation,
            principalRef: context.principalRef,
            correlationId: context.traceRef,
            provenance: { sourceRefs: [], producer: producer.value, trustLabels: [] },
          },
          authorityId,
          sequence: highwater() + 1,
          aggregate: request.aggregate,
          fingerprint,
        })
        db.prepare(
          'INSERT INTO events (sequence, publication, fingerprint, type_id, scope, record) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          record.sequence,
          publication,
          fingerprint,
          request.typeId,
          JSON.stringify(scope),
          JSON.stringify(record),
        )
        db.prepare('UPDATE events_cursor_authority SET highwater = ? WHERE slot = 1').run(record.sequence)
        return refOf(eventId)
      }),
    )
  }

  const entry =
    <T>(work: (input: unknown, context: CallContext) => Promise<T>) =>
    async (input: unknown, context: CallContext): Promise<Outcome<T>> => {
      if (!open) return { ok: false, error: problem('backend_unavailable', 'events store is closed') }
      if (context.signal.aborted) return { ok: false, error: problem('cancelled', 'call was cancelled') }
      try {
        return { ok: true, value: await work(input, context) }
      } catch (caught) {
        return {
          ok: false,
          error: caught instanceof Refused ? caught.error : problem('internal_error', 'events failed'),
        }
      }
    }
  const methods = { subscribe: entry(subscribe), publish: entry(publish) }

  return {
    binding,
    ...methods,
    async query(request: Wire.ServiceQuery, context: CallContext): Promise<Outcome<Wire.QueryReply>> {
      if (request.method !== 'subscribe')
        return { ok: false, error: problem('operation_not_supported', `${request.method} is not a query`) }
      const refs = RuntimeMethodSchemaRefs['agh.events'].subscribe
      if (request.input.kind !== 'inline' || jcs(request.input.schema) !== jcs(refs.input))
        return { ok: false, error: problem('invalid_request', 'input does not carry the method schema') }
      const answered = await methods.subscribe(request.input.value, context)
      if (!answered.ok) return answered
      const value = answered.value as unknown as Wire.JsonValue
      const output: Wire.DataRef = {
        kind: 'inline',
        schema: refs.output,
        value,
        digest: canonicalJsonDigest(value),
        bytes: Buffer.byteLength(jcs(value)),
      }
      return { ok: true, value: { kind: 'value', output, snapshot: output.digest } }
    },
    close() {
      if (!open) return
      open = false
      for (const rejectRead of waitingReads) rejectRead()
      waitingReads.clear()
      db.close()
    },
  }
}
