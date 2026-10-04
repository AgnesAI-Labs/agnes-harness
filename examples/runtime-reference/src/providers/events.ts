import { randomUUID } from 'node:crypto'
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
    canRead(scope: Wire.ScopeRef, context: CallContext): Promise<boolean>
  }
}>

const TABLE = `CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY, publication TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  type_id TEXT NOT NULL, scope TEXT NOT NULL, record TEXT NOT NULL)`
const WIDEST_PAGE = 500

/** A run or action causation names its run; other references carry no execution identity. */
function causationOf(ref: Wire.PublicRef): Wire.DomainEvent['causation'] {
  if (ref.kind === 'run') return { runId: ref.value.runId }
  if (ref.kind === 'action') return { runId: ref.run.runId, actionId: ref.actionId }
  return {}
}

/**
 * The reference agh.events provider: committed events in one SQLite table, numbered by sequence under
 * one authority. A publication's idempotency identity commits in the same row as its event, so a lost
 * reply never makes a second event. A cursor names the sequence read up to and the query it was issued
 * for, so it stays valid across restarts; any other cursor asks the caller to resync.
 */
export function openEventsStore(path: string, options: ReferenceEventsOptions) {
  const { binding, authorityId, access } = options
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(TABLE)
  } catch (error) {
    // A file that is not this store must not keep the handle open.
    db.close()
    throw error
  }
  let open = true

  const head = () =>
    (db.prepare('SELECT MAX(sequence) AS head FROM events').get() as { head: number | null }).head ?? 0
  const refOf = (eventId: string): Wire.EventsPublishResult => ({
    eventRef: { kind: 'event', authorityId, eventId },
  })

  const cursorOf = (query: string, sequence: number) =>
    Buffer.from(JSON.stringify([authorityId, query, sequence])).toString('base64url')
  function position(cursor: string | null, query: string): number {
    if (cursor === null) return 0
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    } catch {
      parsed = null
    }
    const [authority, issuedFor, sequence] = Array.isArray(parsed) ? parsed : []
    if (
      authority !== authorityId ||
      issuedFor !== query ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > head()
    )
      stop('resync_required', 'cursor was not issued for this query by this authority')
    return sequence
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
    if (!(await access.canRead(request.scopeRef, context)))
      stop('permission_denied', 'caller may not read events in this scope')
    if (request.limit < 1) stop('invalid_request', 'a page holds at least one event')
    const query = canonicalJsonDigest({ scopeRef: request.scopeRef, types: request.types })
    const after = position(request.cursor, query)
    const top = head()
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
      .all(after, top, types, types, ...fields.flatMap(([field, value]) => [`$.${field}`, value]), limit) as {
      sequence: number
      record: string
    }[]
    // A short page read up to the head; a full one stops at its last event.
    const complete = rows.length < limit
    return parse('EventsSubscribeResult', {
      page: {
        items: rows.map((row) => JSON.parse(row.record)),
        snapshot: `${authorityId}@${top}`,
        nextCursor: cursorOf(query, complete ? top : (rows.at(-1)?.sequence ?? top)),
        complete,
      },
      resyncRequired: false,
    })
  }

  async function publish(input: unknown, context: CallContext): Promise<Wire.EventsPublishResult> {
    const checked = validateEventsPublishSchemas(input)
    if (!checked.ok) stop('invalid_request', 'publication is malformed')
    const request = checked.value
    const publication = canonicalJsonDigest({
      binding: context.bindingId,
      scope: context.scope,
      typeId: request.typeId,
      key: request.idempotencyKey,
    })
    const fingerprint = canonicalJsonDigest({
      aggregate: request.aggregate,
      schema: request.domainSchema,
      payload: request.payload,
      causation: request.causationRef,
    })
    // Checked before admission too: a lost reply is answered even after the aggregate moved on.
    const earlier = () => {
      const row = db
        .prepare('SELECT fingerprint, record FROM events WHERE publication = ?')
        .get(publication) as { fingerprint: string; record: string } | undefined
      if (row === undefined) return undefined
      if (row.fingerprint !== fingerprint)
        stop('idempotency_conflict', 'idempotency key was used for another publication')
      return refOf((JSON.parse(row.record) as Wire.DomainEventRecord).event.eventId)
    }
    const replayed = earlier()
    if (replayed) return replayed
    const producer = await access.producer(request.typeId, request.domainSchema, context)
    if (!producer.ok) throw new Refused(producer.error)
    const current = await access.revision(request.aggregate)
    if (current === null) stop('not_found', 'aggregate is unknown to its authority')
    if (current !== request.aggregate.revision)
      stop('revision_conflict', 'aggregate is not at its current revision')
    if (context.signal.aborted) stop('cancelled', 'publication was cancelled')
    return transact(() => {
      // A call with the same key may have committed while this one waited for admission.
      const raced = earlier()
      if (raced) return raced
      const eventId = randomUUID()
      const record = parse('DomainEventRecord', {
        event: {
          eventId,
          typeId: request.typeId,
          schema: request.domainSchema,
          source: producer.value,
          scope: context.scope,
          occurredAt: new Date().toISOString(),
          payload: request.payload,
          idempotencyKey: request.idempotencyKey,
          causation: causationOf(request.causationRef),
          principalRef: context.principalRef,
          correlationId: context.traceRef,
          provenance: { sourceRefs: [], producer: producer.value, trustLabels: [] },
        },
        authorityId,
        sequence: head() + 1,
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
        JSON.stringify(context.scope),
        JSON.stringify(record),
      )
      return refOf(eventId)
    })
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
      db.close()
    },
  }
}
