import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  validateEventsPublishSchemas,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type DomainStore, type DomainStoreTransaction, fail } from '../events/outbox.js'

// Same shapes as the Local SPI Outcome and CallContext; this package does not depend on it, so they meet
// structurally at assembly, as the domain store's types do.
type Outcome<T> = { ok: true; value: T } | { ok: false; error: Wire.RuntimeError }
type CallContext = Readonly<Wire.CallContextWire & { signal: AbortSignal }>
type CommitFacts = Readonly<{
  producer: Wire.BindingRef
  scope: Wire.ScopeRef
  causation: Wire.DomainEvent['causation']
  /** Current aggregate revision, held against changes until the commit callback returns. */
  revision: number | null
}>

/**
 * What the Host vouches for on each events call: producer registration, the aggregate authority's
 * current revision, the original object's scope and causation, read permission and a hold over all of
 * them while a publication commits. Without a gate, or when it cannot vouch for a producer or an origin,
 * publish refuses and writes nothing, and reads refuse too.
 */
export interface EventsGate {
  /** The registered producer binding when the caller may publish `typeId` with exactly `schema`. */
  producer(typeId: string, schema: Wire.SchemaRef, context: CallContext): Promise<Outcome<Wire.BindingRef>>
  /** The current revision of `aggregate` at its authority, or null when the authority does not know it. */
  revision(aggregate: Wire.DomainObjectRef): Promise<number | null>
  /** The original object's scope and causation; a replay at an older revision still has them. */
  origin(
    aggregate: Wire.DomainObjectRef,
    causation: Wire.PublicRef,
    producer: Wire.BindingRef,
    context: CallContext,
  ): Promise<Outcome<{ scope: Wire.ScopeRef; causation: Wire.DomainEvent['causation'] }>>
  /** Holds the current producer, origin and aggregate revision until the synchronous `body` returns. */
  withCommit<T>(
    typeId: string,
    schema: Wire.SchemaRef,
    aggregate: Wire.DomainObjectRef,
    causation: Wire.PublicRef,
    context: CallContext,
    body: (facts: CommitFacts) => T,
  ): Outcome<T>
  /** Whether the caller may read events in `scope` now. */
  canRead(scope: Wire.ScopeRef, context: CallContext): Promise<boolean>
}

export type EventsProviderOptions = Readonly<{
  binding: Wire.BindingRef
  /** The domain store whose events, sequence and commit notifications this provider shares. */
  store: DomainStore
  /** Signs cursors for this process only, at least 32 bytes; a restart drops it and every cursor. */
  cursorKey: Uint8Array
  gate?: EventsGate
  /** Closes the store with the provider; a borrowed store (the default) stays open for its owner. */
  ownsStore?: boolean
}>

const DIAGNOSTIC = 'daemon-events'
const WIDEST_PAGE = 500
const MAX_PENDING_READS = 8

class Refused extends Error {
  constructor(readonly error: Wire.RuntimeError) {
    super(error.message)
  }
}

function stop(detail: Parameters<typeof fail>[0], message: string): never {
  throw new Refused(fail(detail, message, DIAGNOSTIC).error)
}

function parse<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const checked = validateRuntime(name, value)
  return checked.ok ? checked.value : stop('invalid_request', `${name} is malformed`)
}

/** The gate's answer when it vouched with a well-formed value; its own refusal passes through. */
function vouched<T>(outcome: Outcome<T> | undefined, valid: (value: T) => boolean, what: string): T {
  if (outcome?.ok === false && validateRuntime('RuntimeError', outcome.error).ok)
    throw new Refused(outcome.error)
  if (outcome?.ok !== true || !valid(outcome.value))
    stop('permission_denied', `the events gate did not vouch for the ${what}`)
  return outcome.value
}

/** Every field the caller's scope names matches the original object's scope. */
const covers = (outer: Wire.ScopeRef, inner: Wire.ScopeRef) =>
  Object.entries(outer).every(
    ([field, value]) => field === 'kind' || inner[field as keyof Wire.ScopeRef] === value,
  )

/**
 * The fingerprint of a domain event, from the stored record's own content. The core domain command path
 * has an `eventFingerprint` of its own that must stay identical, so either write path replays the other's
 * event.
 */
export const eventFingerprint = (
  aggregate: Wire.DomainObjectRef,
  event: Pick<Wire.DomainEvent, 'schema' | 'payload' | 'causation'>,
): Wire.Digest =>
  canonicalJsonDigest({ aggregate, schema: event.schema, payload: event.payload, causation: event.causation })

/**
 * The default agh.events provider over the daemon domain store: events share its table, sequence and
 * commit notifications with the command path. A cursor is signed with the process key and names the
 * read it was issued for, the sequence read up to, the snapshot top and the event at that top, so any
 * other cursor, or any change to the history it covers, asks the caller to resync.
 */
export function createEventsProvider(options: EventsProviderOptions) {
  const { binding, store, gate } = options
  if (!(options.cursorKey instanceof Uint8Array) || options.cursorKey.byteLength < 32) {
    if (options.ownsStore) store.close()
    throw new Error('event cursors need a key of at least 32 bytes')
  }
  const key = Buffer.from(options.cursorKey)
  const authority = store.authorityId
  let open = true
  let pendingReads = 0
  const waitingReads = new Set<() => void>()

  /** The newest sequence; any missing row up to the high-water, a deleted tail too, refuses the call. */
  const head = () => {
    const { count, first, last, highwater } = store.eventHistory()
    if (count !== highwater || (last ?? 0) !== highwater || (count > 0 && first !== 1))
      stop('resync_required', 'event history has a gap')
    return count
  }
  const sign = (fields: readonly unknown[]) =>
    createHmac('sha256', key).update(JSON.stringify(fields)).digest()
  const cursorOf = (
    query: string,
    reader: string,
    kind: 'page' | 'checkpoint',
    sequence: number,
    top: number,
  ) => {
    const fields = [authority, query, reader, kind, sequence, top, store.eventIdAt(top) ?? '']
    return Buffer.from(JSON.stringify([...fields, sign(fields).toString('base64url')])).toString('base64url')
  }

  function position(cursor: string | null, query: string, reader: string): { after: number; top: number } {
    const newest = head()
    if (cursor === null) return { after: 0, top: newest }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    } catch {
      parsed = null
    }
    const fields: unknown[] = Array.isArray(parsed) && parsed.length === 8 ? parsed : []
    const [issuer, issuedFor, issuedTo, kind, sequence, top, topEventId, signature] = fields
    const expected = sign(fields.slice(0, 7))
    const received = typeof signature === 'string' ? Buffer.from(signature, 'base64url') : Buffer.alloc(0)
    // A cursor from an earlier process was signed with a key that is gone, so it is refused here too.
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected) ||
      issuer !== authority ||
      issuedFor !== query ||
      issuedTo !== reader ||
      (kind !== 'page' && kind !== 'checkpoint') ||
      typeof sequence !== 'number' ||
      typeof top !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Number.isSafeInteger(top) ||
      top < sequence ||
      (kind === 'checkpoint' && sequence !== top)
    )
      stop('resync_required', 'cursor was not issued for this read by this provider')
    // The history under the cursor changed, so its page set can no longer be served. An expired page
    // cursor is refused with resync_required until a dedicated detail code is registered.
    if (top > newest || (store.eventIdAt(top) ?? '') !== topEventId)
      stop('resync_required', 'the history this cursor covers has changed')
    return { after: sequence, top: kind === 'page' ? top : newest }
  }

  async function subscribe(input: unknown, context: CallContext): Promise<Wire.EventsSubscribeResult> {
    const request = parse('EventsSubscribeRequest', input)
    if (gate === undefined) stop('permission_denied', 'no events gate grants reads')
    if (pendingReads >= MAX_PENDING_READS)
      throw new Refused({
        ...fail('rate_limit', 'event reads are temporarily saturated', DIAGNOSTIC).error,
        retryAdvice: { kind: 'retry_read', notBefore: new Date(Date.now() + 1000).toISOString() },
      })
    pendingReads++
    let onAbort: (() => void) | undefined
    let onClose: (() => void) | undefined
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Refused(fail('cancelled', 'event read was cancelled', DIAGNOSTIC).error))
        context.signal.addEventListener('abort', onAbort, { once: true })
      })
      const closed = new Promise<never>((_, reject) => {
        onClose = () =>
          reject(new Refused(fail('backend_unavailable', 'events provider is closed', DIAGNOSTIC).error))
        waitingReads.add(onClose)
      })
      const permitted = await Promise.race([gate.canRead(request.scopeRef, context), cancelled, closed])
      if (context.signal.aborted) stop('cancelled', 'event read was cancelled')
      if (!open) stop('backend_unavailable', 'events provider is closed')
      if (permitted !== true) stop('permission_denied', 'caller may not read events in this scope')
      if (request.limit < 1) stop('invalid_request', 'a page holds at least one event')
      const query = canonicalJsonDigest({ scopeRef: request.scopeRef, types: request.types })
      const reader = canonicalJsonDigest({ principalRef: context.principalRef, bindingId: context.bindingId })
      const { after, top } = position(request.cursor, query, reader)
      const limit = Math.min(request.limit, WIDEST_PAGE)
      // One more row than the page says whether the page is the last, so a full last page is complete.
      const rows = store.eventsIn(after, top, request.scopeRef, request.types, limit + 1)
      const complete = rows.length <= limit
      const items = rows.slice(0, limit)
      return parse('EventsSubscribeResult', {
        page: {
          items,
          snapshot: `${authority}@${top}`,
          nextCursor: complete ? null : cursorOf(query, reader, 'page', items.at(-1)?.sequence ?? after, top),
          complete,
        },
        checkpoint: complete ? cursorOf(query, reader, 'checkpoint', top, top) : null,
        // The published result revision still carries the flag; a resync is always the refusal instead.
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
    if (gate === undefined) stop('permission_denied', 'no events gate vouches for producers')
    // Authorization precedes the idempotency lookup: a revoked producer neither reads nor replays a key.
    const producer = vouched(
      await gate.producer(request.typeId, request.domainSchema, context),
      (value) => validateRuntime('BindingRef', value).ok,
      'producer',
    )
    const origin = vouched(
      await gate.origin(request.aggregate, request.causationRef, producer, context),
      (value) => validateRuntime('ScopeRef', value?.scope).ok,
      'origin',
    )
    const { scope } = origin
    if (!covers(context.scope, scope))
      stop('permission_denied', 'producer context does not cover the original object scope')
    if (context.signal.aborted) stop('cancelled', 'publication was cancelled')
    // The stored causation is the original object's, the same one the command path records.
    const fingerprint = eventFingerprint(request.aggregate, {
      schema: request.domainSchema,
      payload: request.payload,
      causation: origin.causation,
    })
    const refOf = (eventId: string): Wire.EventsPublishResult => ({
      eventRef: { kind: 'event', authorityId: authority, eventId },
    })
    // One identity whichever path committed the event: the original object's scope, the producer, the
    // type and the key. The same fingerprint replays it; another one conflicts.
    const earlier = (tx: DomainStoreTransaction) => {
      const record = tx.eventByIdentity({
        scope,
        source: producer,
        typeId: request.typeId,
        idempotencyKey: request.idempotencyKey,
      })
      if (record === undefined) return undefined
      if (record.fingerprint !== fingerprint)
        stop('idempotency_conflict', 'idempotency key was used for another publication')
      return refOf(record.event.eventId)
    }
    /** Runs `work` in a store transaction inside the gate's hold; the store commits it synchronously. */
    const held = <T>(work: (facts: CommitFacts, tx: DomainStoreTransaction) => T): Promise<T> => {
      const box: { committed?: Promise<T> } = {}
      const outcome = gate.withCommit(
        request.typeId,
        request.domainSchema,
        request.aggregate,
        request.causationRef,
        context,
        (facts) => {
          if (box.committed !== undefined)
            stop('permission_denied', 'the events gate ran a publication twice')
          if (
            jcs(facts.producer) !== jcs(producer) ||
            jcs(facts.scope) !== jcs(scope) ||
            jcs(facts.causation) !== jcs(origin.causation)
          )
            stop('permission_denied', 'producer or origin changed while the publication waited')
          if (!open) stop('backend_unavailable', 'events provider is closed')
          box.committed = store.transaction((tx) => {
            head()
            return work(facts, tx)
          })
          // Observed by the caller below; this only keeps a refused commit from going unhandled meanwhile.
          box.committed.catch(() => {})
          return true
        },
      )
      if (!outcome.ok) throw new Refused(outcome.error)
      return box.committed ?? stop('permission_denied', 'the events gate did not run the publication')
    }

    const replayed = await held((_, tx) => earlier(tx))
    if (replayed) return replayed
    const current = await gate.revision(request.aggregate)
    if (current === null) stop('not_found', 'aggregate is unknown to its authority')
    if (!Number.isSafeInteger(current))
      stop('permission_denied', 'the events gate did not vouch for a revision')
    if (current !== request.aggregate.revision)
      stop('revision_conflict', 'aggregate is not at its current revision')
    if (context.signal.aborted) stop('cancelled', 'publication was cancelled')
    return held((facts, tx) => {
      // A call with the same identity may have committed while this one waited for admission.
      const raced = earlier(tx)
      if (raced) return raced
      if (facts.revision !== request.aggregate.revision)
        stop('revision_conflict', 'aggregate is not at its current revision')
      const eventId = randomUUID()
      const record = validateRuntime('DomainEventRecord', {
        event: {
          eventId,
          typeId: request.typeId,
          schema: request.domainSchema,
          source: producer,
          scope,
          occurredAt: new Date().toISOString(),
          payload: request.payload,
          idempotencyKey: request.idempotencyKey,
          causation: origin.causation,
          principalRef: context.principalRef,
          correlationId: context.traceRef,
          provenance: { sourceRefs: [], producer, trustLabels: [] },
        },
        authorityId: authority,
        sequence: tx.lastSequence() + 1,
        aggregate: request.aggregate,
        fingerprint,
      })
      if (!record.ok) stop('permission_denied', 'the events gate vouched for facts that form no event')
      tx.putEvent(record.value)
      return refOf(eventId)
    })
  }

  const entry =
    <T>(work: (input: unknown, context: CallContext) => Promise<T>) =>
    async (input: unknown, context: CallContext): Promise<Outcome<T>> => {
      if (!open) return fail('backend_unavailable', 'events provider is closed', DIAGNOSTIC)
      if (context.signal.aborted) return fail('cancelled', 'call was cancelled', DIAGNOSTIC)
      try {
        return { ok: true, value: await work(input, context) }
      } catch (caught) {
        return caught instanceof Refused
          ? { ok: false, error: caught.error }
          : fail('internal_error', 'events call failed', DIAGNOSTIC)
      }
    }
  const methods = { subscribe: entry(subscribe), publish: entry(publish) }

  return {
    binding,
    ...methods,
    async query(request: Wire.ServiceQuery, context: CallContext): Promise<Outcome<Wire.QueryReply>> {
      if (request.method !== 'subscribe')
        return fail('operation_not_supported', `${request.method} is not a query`, DIAGNOSTIC)
      const refs = RuntimeMethodSchemaRefs['agh.events'].subscribe
      if (request.input.kind !== 'inline' || jcs(request.input.schema) !== jcs(refs.input))
        return fail('invalid_request', 'input does not carry the method schema', DIAGNOSTIC)
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
    /** Wakes waiting reads; later calls are refused. Closes the store only when this provider owns it. */
    close() {
      if (!open) return
      open = false
      for (const wake of waitingReads) wake()
      waitingReads.clear()
      if (options.ownsStore) store.close()
    },
  }
}
