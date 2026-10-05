import { existsSync, readdirSync } from 'node:fs'
import { pid } from 'node:process'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeErrorDetails,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, CaseContext, ConformanceHarness, TestServiceBinding } from '../harness.js'
import { inline } from './projection.js'

const CONTRACT = 'agh.events'
const HEX = /^[a-f0-9]{64}$/

const schemaRef = (typeId: string): Wire.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest(typeId),
})
const NOTED = schemaRef('conformance.events/noted@1')
const CLOSED = schemaRef('conformance.events/closed@1')
const UNREGISTERED = schemaRef('conformance.events/unregistered@1')
const TYPES = [NOTED.typeId, CLOSED.typeId]
const DOMAIN_AUTHORITY = 'conformance-domain'

const WORKSPACE = {
  kind: 'workspace',
  installationId: 'conformance',
  runtimeId: 'conformance',
  workspaceId: 'conformance',
} as const
const sessionScope = (sessionId: string): Wire.ScopeRef => ({ ...WORKSPACE, kind: 'session', sessionId })
const runRef = (sessionId: string, runId = `${sessionId}-run`): Wire.PublicRef => ({
  kind: 'run',
  value: {
    runId,
    session: {
      sessionId,
      authority: { authorityId: 'conformance-state', tenantId: 'conformance', authorityEpoch: 1 },
    },
  },
})
/** A session no reader may read. */
const CLOSED_SESSION = 'vault'

/** The binding the Host registered as the producer of both event types. */
const EVENTS_PRODUCER: Wire.BindingRef = {
  bindingId: 'conformance-producer',
  contract: 'conformance.events',
  logicalName: 'notes',
  providerId: 'conformance-producer',
}
const PRODUCER_PRINCIPAL = 'events-producer'
const READER = 'events-reader'
const OTHER_READER = 'events-other-reader'

const refusal = (detail: keyof typeof RuntimeErrorDetails, message: string): Outcome<never> => ({
  ok: false,
  error: {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'events-conformance',
  },
})

function call(
  principalRef: string,
  scope: Wire.ScopeRef,
  bindingId: string,
  signal?: AbortSignal,
): CallContext {
  return {
    principalRef,
    scope,
    bindingId,
    invocationId: 'conformance-invocation',
    deadline: '2100-01-01T00:00:00.000Z',
    traceRef: `${principalRef}-trace`,
    authorizationRef: `${principalRef}-authorization`,
    signal: signal ?? new AbortController().signal,
  }
}
const cancelled = () => AbortSignal.abort()
const producer = (sessionId: string, signal?: AbortSignal, bindingId = EVENTS_PRODUCER.bindingId) =>
  call(PRODUCER_PRINCIPAL, sessionScope(sessionId), bindingId, signal)
const reader = (signal?: AbortSignal) => call(READER, WORKSPACE, 'events-reader-binding', signal)

/** The Host checks a binding wires into its provider: registration, the aggregate authority and readers. */
export interface EventsGate {
  /** The registered producer binding when the caller may publish `typeId` with exactly `schema`. */
  producer(typeId: string, schema: Wire.SchemaRef, context: CallContext): Promise<Outcome<Wire.BindingRef>>
  /** The current revision of `aggregate` at its authority, or null when the authority does not know it. */
  revision(aggregate: Wire.DomainObjectRef): Promise<number | null>
  /** Reads immutable aggregate/causation ownership and current coverage, even for a stale replay. */
  origin(
    aggregate: Wire.DomainObjectRef,
    causation: Wire.PublicRef,
    producer: Wire.BindingRef,
    context: CallContext,
  ): Promise<Outcome<{ scope: Wire.ScopeRef; causation: Wire.DomainEvent['causation'] }>>
  /** Holds current producer, origin and aggregate revision until `body` returns. */
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
      revision: number | null
    }) => T,
  ): Outcome<T>
  /** Whether the caller may read events in `scope` now. */
  canRead(scope: Wire.ScopeRef, context: CallContext): Promise<boolean>
}

export interface EventsFixture {
  readonly gate: EventsGate
  /** Moves an aggregate on by one revision, as a commit at its authority does. */
  revise(id: string): void
  recordAggregate(id: string, scope: Wire.ScopeRef): void
  revokeProducer(): void
  restoreProducer(): void
  revokeReader(principalRef: string): void
  restoreReader(principalRef: string): void
  /** Holds the next producer or revision check until `release`; `started` settles once it waits. */
  holdAdmission(): { started: Promise<void>; release(): void }
}

export function createEventsFixture(): EventsFixture {
  const revisions = new Map<string, number>()
  const revoked = new Set<string>()
  const origins = new Map<string, Wire.ScopeRef>()
  for (const session of ['normal', 'elsewhere', 'deny', 'cancel', 'recover', 'dispose'])
    origins.set(`${session}-item`, sessionScope(session))
  origins.set('deny-other', sessionScope('deny'))
  let producerActive = true
  let publicationHeld = false
  let hold: { begin(): void; wait: Promise<void> } | null = null
  const admit = async () => {
    const held = hold
    hold = null
    if (held === null) return
    held.begin()
    await held.wait
  }
  const producerNow = (
    typeId: string,
    schema: Wire.SchemaRef,
    context: CallContext,
  ): Outcome<Wire.BindingRef> => {
    if (!TYPES.includes(typeId) || jcs(schema) !== jcs(schemaRef(typeId)))
      return refusal('invalid_request', 'event type is not registered with this schema')
    return producerActive &&
      context.principalRef === PRODUCER_PRINCIPAL &&
      context.bindingId === EVENTS_PRODUCER.bindingId
      ? { ok: true, value: EVENTS_PRODUCER }
      : refusal('permission_denied', 'binding is not a registered producer of this type')
  }
  const originNow = (
    aggregate: Wire.DomainObjectRef,
    causation: Wire.PublicRef,
    producer: Wire.BindingRef,
    context: CallContext,
  ): Outcome<{ scope: Wire.ScopeRef; causation: Wire.DomainEvent['causation'] }> => {
    const scope = origins.get(aggregate.id)
    if (scope === undefined && aggregate.authorityId === DOMAIN_AUTHORITY)
      return refusal('not_found', 'aggregate is unknown to its authority')
    if (
      scope === undefined ||
      aggregate.authorityId !== DOMAIN_AUTHORITY ||
      aggregate.typeId !== 'conformance.events/item@1' ||
      !producerActive ||
      producer.bindingId !== EVENTS_PRODUCER.bindingId ||
      context.principalRef !== PRODUCER_PRINCIPAL ||
      context.bindingId !== EVENTS_PRODUCER.bindingId
    )
      return refusal('permission_denied', 'aggregate has no authorized producer origin')
    const covers = Object.entries(context.scope).every(
      ([field, value]) => field === 'kind' || scope[field as keyof Wire.ScopeRef] === value,
    )
    if (!covers || scope.kind !== 'session' || !same(causation, runRef(scope.sessionId)))
      return refusal('permission_denied', 'aggregate scope or causation is not owned by this producer')
    return { ok: true, value: { scope, causation: { runId: `${scope.sessionId}-run` } } }
  }
  return {
    gate: {
      async producer(typeId, schema, context) {
        await admit()
        return producerNow(typeId, schema, context)
      },
      async revision(aggregate) {
        await admit()
        return aggregate.authorityId === DOMAIN_AUTHORITY && origins.has(aggregate.id)
          ? (revisions.get(aggregate.id) ?? 1)
          : null
      },
      async origin(aggregate, causation, producer, context) {
        return originNow(aggregate, causation, producer, context)
      },
      withCommit(typeId, schema, aggregate, causation, context, body) {
        if (publicationHeld) return refusal('permission_denied', 'publication authority is already held')
        const producer = producerNow(typeId, schema, context)
        if (!producer.ok) return producer
        const origin = originNow(aggregate, causation, producer.value, context)
        if (!origin.ok) return origin
        publicationHeld = true
        try {
          return {
            ok: true,
            value: body({
              producer: producer.value,
              ...origin.value,
              revision: revisions.get(aggregate.id) ?? 1,
            }),
          }
        } finally {
          publicationHeld = false
        }
      },
      async canRead(scope, context) {
        return (
          (context.principalRef === READER || context.principalRef === OTHER_READER) &&
          !revoked.has(context.principalRef) &&
          'workspaceId' in scope &&
          scope.installationId === WORKSPACE.installationId &&
          scope.runtimeId === WORKSPACE.runtimeId &&
          scope.workspaceId === WORKSPACE.workspaceId &&
          !('sessionId' in scope && scope.sessionId === CLOSED_SESSION)
        )
      },
    },
    revise: (id) => {
      if (publicationHeld) throw new Error('aggregate revision is held by a publication')
      revisions.set(id, (revisions.get(id) ?? 1) + 1)
    },
    recordAggregate: (id, scope) => {
      if (publicationHeld) throw new Error('aggregate origin is held by a publication')
      origins.set(id, scope)
    },
    revokeProducer: () => {
      if (publicationHeld) throw new Error('producer is held by a publication')
      producerActive = false
    },
    restoreProducer: () => {
      if (publicationHeld) throw new Error('producer is held by a publication')
      producerActive = true
    },
    revokeReader: (principalRef) => revoked.add(principalRef),
    restoreReader: (principalRef) => revoked.delete(principalRef),
    holdAdmission() {
      let begin = () => {}
      let release = () => {}
      const started = new Promise<void>((resolve) => {
        begin = resolve
      })
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      hold = { begin, wait }
      return { started, release }
    },
  }
}

const aggregate = (id: string, revision = 1): Wire.DomainObjectRef => ({
  authorityId: DOMAIN_AUTHORITY,
  typeId: 'conformance.events/item@1',
  id,
  revision,
})

/** A publication in `sessionId` under idempotency key `key`, caused by the session's run. */
function publication(
  sessionId: string,
  key: string,
  schema = NOTED,
  extra: Record<string, unknown> = {},
): Wire.EventsPublishRequest {
  return {
    domainSchema: schema,
    payload: inline(schema, { note: key }),
    causationRef: runRef(sessionId),
    typeId: schema.typeId,
    idempotencyKey: key,
    aggregate: aggregate(`${sessionId}-item`),
    ...extra,
  }
}

const subscription = (sessionId: string, cursor: string | null = null, types = TYPES, limit = 10) => ({
  scopeRef: sessionScope(sessionId),
  types,
  cursor,
  limit,
})

/** In session `normal`, even events are `closed`, odd ones `noted`; the sixth follows a revision. */
const normalRequest = (n: number) =>
  publication(
    'normal',
    `normal-${n}`,
    n % 2 === 0 ? CLOSED : NOTED,
    n === 6 ? { aggregate: aggregate('normal-item', 2) } : {},
  )

type Handler<T> = (request: unknown, context: CallContext) => Promise<Outcome<T>>

/** The agh.events methods of one provider instance. */
export interface EventsMethods {
  subscribe: Handler<Wire.EventsSubscribeResult>
  publish: Handler<Wire.EventsPublishResult>
}

/** What a provider process does before the suite kills it: commit `committed`, then hold `held`. */
export type EventsCrash = Readonly<{
  sessionId: string
  committed: readonly Wire.EventsPublishRequest[]
  held: Wire.EventsPublishRequest
}>

/** One events provider as the suite drives it, wired to the fixture it was given. */
export interface EventsSubject {
  /** The binding the provider offers, carrying its query entry. */
  readonly binding: TestServiceBinding
  readonly fixture: EventsFixture
  /** The methods of the instance open now; a crash or a reopen replaces it. */
  service(): EventsMethods
  /**
   * Closes the provider here, starts a provider process over the same storage that runs `crashEvents`
   * with `crash` and kills it with SIGKILL where that stops, then opens the provider here again.
   * Resolves to the killed process's exit signal and pid.
   */
  crash(crash: EventsCrash): Promise<{ signal: string | null; pid: number | null }>
  /** Closes the provider; closing a closed provider does nothing. Synchronous. */
  close(): void
  /** Opens the provider over its storage again, synchronously. */
  reopen(): void
  /** Whether the provider's stored data is still there. */
  remains(): boolean
  /**
   * Mounts the provider over storage that is not its own, so the mount fails after whatever it
   * acquires first, and says whether the mount was refused. Synchronous.
   */
  mountRefused(): boolean
}

/**
 * The provider process side of `EventsSubject.crash`: commits each publication, then submits the held
 * one and calls `stop` once its admission check has begun. `stop` must not return, since the process is
 * killed there. Throws when a publication is refused or the held one settles before its admission.
 */
export async function crashEvents(
  subject: Pick<EventsSubject, 'fixture' | 'service'>,
  crash: EventsCrash,
  stop: () => void,
): Promise<void> {
  for (const request of crash.committed) {
    const committed = await subject.service().publish(request, producer(crash.sessionId))
    if (!committed.ok) throw new Error(`a crash publication was refused: ${committed.error.detailCode}`)
  }
  const held = subject.fixture.holdAdmission()
  const settled = await Promise.race([
    held.started.then(() => null),
    subject.service().publish(crash.held, producer(crash.sessionId)),
  ])
  if (settled)
    throw new Error(`the held publication settled before its admission: ${JSON.stringify(settled)}`)
  stop()
}

export type EventsFact<T> = T | { readonly refused: string }
type Page = EventsFact<Wire.EventsSubscribeResult>
type Ref = EventsFact<Wire.EventsPublishResult>

/**
 * Facts each scenario reports. The port only drives the provider and reads back; this module decides
 * whether the facts meet the events rules, so every implementation is judged the same way.
 */
export interface EventsObservations {
  readonly select: { readonly binding: TestServiceBinding }
  /**
   * Session `normal`: five publications of two types (`refs`) and one in another session. `pages` reads
   * both types two at a time from the start, following each cursor; `filtered` reads one type. `replay`
   * publishes the first again after its aggregate moved on. A sixth publication follows at the new
   * revision (the last of `refs`) and `resumed` reads from the last page cursor. Then `fixed` follows
   * the second page's cursor again and `exactResumed` reads one type from the checkpoint of `exact`.
   * Revocation refuses a same-key replay without a new event; a broader authorized context replays
   * the original event under its aggregate-owned namespace.
   */
  readonly normal: {
    readonly refs: readonly Ref[]
    readonly pages: readonly Page[]
    readonly filtered: Page
    readonly exact: Page
    readonly empty: Page
    readonly revokedReplay: Ref
    readonly revokedVisible: Page
    readonly coveringReplay: Ref
    readonly replay: Ref
    readonly resumed: Page
    readonly fixed: Page
    readonly exactResumed: Page
  }
  /**
   * Session `deny`, one publication committed first. `refusals` are detail codes, in order, of
   * publications whose type disagrees with the schema; whose payload schema disagrees; with a field the
   * request does not define; of a type nobody registered; from a binding that is no registered producer;
   * at a stale aggregate revision; for an aggregate its authority does not know; the committed key with
   * another payload and with another aggregate; from a wrong scope, aggregate or causation; then of reads of a closed session; with a cursor issued
   * for another type filter; for another session; with a cursor the provider never issued; with a
   * tampered signed checkpoint; from another authorized reader; with the reader revoked. `visible`
   * reads the session after the reader is restored.
   */
  readonly deny: { readonly refusals: readonly string[]; readonly visible: Page }
  /**
   * Session `cancel`. `refusals` are the codes of a read and a publication sent with an aborted signal,
   * then of a publication aborted while its admission check runs. `untouched` reads the session after
   * them; `retried` is that publication sent again twice, and `after` the session read after it.
   */
  readonly cancel: {
    readonly refusals: readonly string[]
    readonly untouched: Page
    readonly retried: readonly Ref[]
    readonly after: Page
  }
  /**
   * Session `recover`: one publication and a read of it (`first`). A provider process commits two more
   * publications and is killed with SIGKILL while a fourth waits for admission; `kills` holds its exit
   * signal and pid. After the restart, `resumed` reads from the cursor of `first`, `replayed` sends the
   * second publication again, `held` sends the fourth twice and `all` reads the session from the start.
   */
  readonly recover: {
    readonly kills: readonly { readonly signal: string | null; readonly pid: number | null }[]
    readonly first: Page
    readonly resumed: Page
    readonly replayed: Ref
    readonly held: readonly Ref[]
    readonly all: Page
  }
  /**
   * Session `dispose`: a publication and a read of it, then the provider is closed. `refused` are the
   * codes of a read and a publication after close, `storeRemains` whether the stored data is still there.
   * After a reopen and a second publication, `resumed` reads from the cursor taken before close. Then
   * `mountRefused` is whether a mount over foreign storage was refused, and `handles` counts open file
   * descriptors with no provider open, after the refused mount and after the provider is opened and
   * closed again. The counts are null only where the platform offers nothing to count them with, which
   * means not measurable there, never passed.
   */
  readonly dispose: {
    readonly refused: readonly string[]
    readonly storeRemains: boolean
    readonly resumed: Page
    readonly mountRefused: boolean
    readonly handles: {
      readonly baseline: number | null
      readonly afterFailedMount: number | null
      readonly afterClose: number | null
    }
  }
}

export type EventsContractPort = {
  readonly [K in ScenarioName]: (context: CaseContext) => Promise<EventsObservations[K]>
}

async function factOf<T>(call: () => Promise<Outcome<T>>): Promise<EventsFact<T>> {
  try {
    const outcome = await call()
    return outcome.ok ? outcome.value : { refused: outcome.error.detailCode }
  } catch {
    return { refused: 'thrown' }
  }
}

const code = (fact: unknown): string =>
  fact !== null && typeof fact === 'object' && 'refused' in fact && typeof fact.refused === 'string'
    ? fact.refused
    : ''

/** Open descriptors of this process, or null where there is no `/dev/fd` to list them (Windows). */
const openHandles = () => (existsSync('/dev/fd') ? readdirSync('/dev/fd').length : null)

const cursorOf = (fact: Page | undefined) =>
  fact !== undefined && !('refused' in fact)
    ? ((fact.page.complete ? fact.checkpoint : fact.page.nextCursor) ?? '')
    : ''

const forgedCheckpoint = (cursor: string) => {
  const fields = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]
  fields[3] = 'page'
  return Buffer.from(JSON.stringify(fields)).toString('base64url')
}

/** Drives one events provider through the six scenarios. */
export function eventsContractPort(subject: EventsSubject): EventsContractPort {
  const { fixture } = subject
  const subscribe = (request: unknown, context = reader()) =>
    factOf(() => subject.service().subscribe(request, context))
  const publish = (request: unknown, context: CallContext) =>
    factOf(() => subject.service().publish(request, context))
  return {
    async select() {
      return { binding: subject.binding }
    },
    async normal() {
      const refs: Ref[] = []
      for (const n of [1, 2, 3, 4, 5]) refs.push(await publish(normalRequest(n), producer('normal')))
      await publish(publication('elsewhere', 'elsewhere-1'), producer('elsewhere'))
      const pages = [await subscribe(subscription('normal', null, TYPES, 2))]
      for (let next = 1; next < 3; next++)
        pages.push(await subscribe(subscription('normal', cursorOf(pages[next - 1]), TYPES, 2)))
      const filtered = await subscribe(subscription('normal', null, [NOTED.typeId]))
      const exact = await subscribe(subscription('normal', null, [CLOSED.typeId], 2))
      const empty = await subscribe(subscription('normal', null, [UNREGISTERED.typeId], 2))
      fixture.revokeProducer()
      const revokedReplay = await publish(normalRequest(1), producer('normal'))
      const revokedVisible = await subscribe(subscription('normal'))
      fixture.restoreProducer()
      const coveringReplay = await publish(
        normalRequest(1),
        call(PRODUCER_PRINCIPAL, WORKSPACE, EVENTS_PRODUCER.bindingId),
      )
      fixture.revise('normal-item')
      const replay = await publish(normalRequest(1), producer('normal'))
      refs.push(await publish(normalRequest(6), producer('normal')))
      const resumed = await subscribe(subscription('normal', cursorOf(pages[2]), TYPES, 2))
      const fixed = await subscribe(subscription('normal', cursorOf(pages[1]), TYPES, 2))
      const exactResumed = await subscribe(subscription('normal', cursorOf(exact), [CLOSED.typeId], 2))
      return {
        refs,
        pages,
        filtered,
        exact,
        empty,
        revokedReplay,
        revokedVisible,
        coveringReplay,
        replay,
        resumed,
        fixed,
        exactResumed,
      }
    },
    async deny() {
      const sent = (request: unknown, context = producer('deny')) => publish(request, context)
      await sent(publication('deny', 'deny-1'))
      const narrow = await subscribe(subscription('deny', null, [NOTED.typeId]))
      const refusals: unknown[] = [
        await sent(publication('deny', 'deny-2', NOTED, { typeId: CLOSED.typeId })),
        await sent(publication('deny', 'deny-2', NOTED, { payload: inline(CLOSED, { note: 'deny-2' }) })),
        await sent({ ...publication('deny', 'deny-2'), eventId: 'forged-event' }),
        await sent(publication('deny', 'deny-2', UNREGISTERED)),
        await sent(publication('deny', 'deny-2'), producer('deny', undefined, 'conformance-intruder')),
      ]
      fixture.revise('deny-item')
      refusals.push(
        await sent(publication('deny', 'deny-2')),
        await sent(publication('deny', 'deny-2', NOTED, { aggregate: aggregate('deny-unknown') })),
        await sent(publication('deny', 'deny-1', NOTED, { payload: inline(NOTED, { note: 'changed' }) })),
        await sent(publication('deny', 'deny-1', NOTED, { aggregate: aggregate('deny-other') })),
        await sent(publication('deny', 'deny-2'), producer('elsewhere')),
        await sent(publication('deny', 'deny-2', NOTED, { aggregate: aggregate('normal-item') })),
        await sent(publication('deny', 'deny-2', NOTED, { causationRef: runRef('deny', 'forged-run') })),
        await subscribe(subscription(CLOSED_SESSION)),
        await subscribe(subscription('deny', cursorOf(narrow), [CLOSED.typeId])),
        await subscribe(subscription('normal', cursorOf(narrow), [NOTED.typeId])),
        await subscribe(subscription('deny', 'conformance-foreign-cursor')),
        await subscribe(subscription('deny', forgedCheckpoint(cursorOf(narrow)), [NOTED.typeId])),
        await subscribe(
          subscription('deny', cursorOf(narrow), [NOTED.typeId]),
          call(OTHER_READER, WORKSPACE, 'events-reader-binding'),
        ),
      )
      fixture.revokeReader(READER)
      refusals.push(await subscribe(subscription('deny', cursorOf(narrow), [NOTED.typeId])))
      fixture.restoreReader(READER)
      return { refusals: refusals.map(code), visible: await subscribe(subscription('deny')) }
    },
    async cancel() {
      const request = publication('cancel', 'cancel-1')
      const refusals = [
        await subscribe(subscription('cancel'), reader(cancelled())),
        await publish(request, producer('cancel', cancelled())),
      ]
      const running = new AbortController()
      const held = fixture.holdAdmission()
      const pending = publish(request, producer('cancel', running.signal))
      await Promise.race([held.started, pending])
      running.abort()
      held.release()
      refusals.push(await pending)
      const untouched = await subscribe(subscription('cancel'))
      const retried = [await publish(request, producer('cancel')), await publish(request, producer('cancel'))]
      return {
        refusals: refusals.map(code),
        untouched,
        retried,
        after: await subscribe(subscription('cancel')),
      }
    },
    async recover() {
      const request = (n: number) => publication('recover', `recover-${n}`)
      await publish(request(1), producer('recover'))
      const first = await subscribe(subscription('recover'))
      const kills = [
        await subject.crash({ sessionId: 'recover', committed: [request(2), request(3)], held: request(4) }),
      ]
      const resumed = await subscribe(subscription('recover', cursorOf(first)))
      const replayed = await publish(request(2), producer('recover'))
      const held = [
        await publish(request(4), producer('recover')),
        await publish(request(4), producer('recover')),
      ]
      return { kills, first, resumed, replayed, held, all: await subscribe(subscription('recover')) }
    },
    async dispose() {
      await publish(publication('dispose', 'dispose-1'), producer('dispose'))
      const before = await subscribe(subscription('dispose'))
      subject.close()
      const refused = [
        await subscribe(subscription('dispose')),
        await publish(publication('dispose', 'dispose-2'), producer('dispose')),
      ].map(code)
      const storeRemains = subject.remains()
      subject.reopen()
      await publish(publication('dispose', 'dispose-2'), producer('dispose'))
      const resumed = await subscribe(subscription('dispose', cursorOf(before)))
      subject.close()
      // Counted synchronously: no provider is open and no call or child process is in flight.
      const baseline = openHandles()
      const mountRefused = subject.mountRefused()
      const afterFailedMount = openHandles()
      subject.reopen()
      subject.close()
      const afterClose = openHandles()
      return {
        refused,
        storeRemains,
        resumed,
        mountRefused,
        handles: { baseline, afterFailedMount, afterClose },
      }
    },
  }
}

const same = (left: unknown, right: unknown) => jcs(left) === jcs(right)

/** The page when the read succeeded with a valid result, else undefined. */
const page = (fact: Page | undefined) =>
  fact !== undefined && !('refused' in fact) && validateRuntime('EventsSubscribeResult', fact).ok
    ? fact.page
    : undefined
const records = (fact: Page | undefined) => page(fact)?.items ?? []
const keys = (fact: Page | undefined) => records(fact).map((record) => record.event.idempotencyKey)
const eventRef = (fact: Ref | undefined) =>
  fact !== undefined && !('refused' in fact) && validateRuntime('EventsPublishResult', fact).ok
    ? fact.eventRef
    : undefined
const refOf = (record: Wire.DomainEventRecord | undefined): Wire.PublicRef | undefined =>
  record && { kind: 'event', authorityId: record.authorityId, eventId: record.event.eventId }

/**
 * The record holds what `request` asked for, in the caller's scope, and the identity the provider issued
 * from the call: the registered producer, the caller's principal and trace, and the run that caused it.
 */
function issued(
  record: Wire.DomainEventRecord | undefined,
  request: Wire.EventsPublishRequest,
  sessionId: string,
) {
  if (record === undefined || !validateRuntime('DomainEventRecord', record).ok) return false
  const { event } = record
  return (
    event.typeId === request.typeId &&
    same(event.schema, request.domainSchema) &&
    same(event.payload, request.payload) &&
    event.idempotencyKey === request.idempotencyKey &&
    same(record.aggregate, request.aggregate) &&
    same(event.scope, sessionScope(sessionId)) &&
    same(event.source, EVENTS_PRODUCER) &&
    same(event.provenance.producer, EVENTS_PRODUCER) &&
    event.principalRef === PRODUCER_PRINCIPAL &&
    event.correlationId === `${PRODUCER_PRINCIPAL}-trace` &&
    same(event.causation, { runId: `${sessionId}-run` })
  )
}

const ascending = (items: readonly Wire.DomainEventRecord[]) =>
  items.every((item, index) => index === 0 || item.sequence > (items[index - 1]?.sequence ?? Infinity))
/** No sequence is skipped: a publication that never committed left no hole. */
const contiguous = (items: readonly Wire.DomainEventRecord[]) =>
  items.every((item, index) => index === 0 || item.sequence === (items[index - 1]?.sequence ?? 0) + 1)

/** Every count back at the baseline, or no count at all where descriptors cannot be counted. */
function returned({ baseline, afterFailedMount, afterClose }: EventsObservations['dispose']['handles']) {
  return baseline === null
    ? afterFailedMount === null && afterClose === null
    : afterFailedMount === baseline && afterClose === baseline
}

type Judge = {
  readonly [K in ScenarioName]: (
    seen: EventsObservations[K],
    context: CaseContext,
    providerId: string,
  ) => boolean | Promise<boolean>
}

const JUDGE: Judge = {
  async select(seen, context, providerId) {
    const { requirement } = seen.binding
    if (requirement.contract !== CONTRACT || requirement.major !== RuntimeServiceCatalog[CONTRACT].major)
      return false
    try {
      context.container.register(seen.binding)
    } catch {
      return false
    }
    const chosen = context.container.dependencies.get(requirement)
    if (!chosen.ok || chosen.value.binding.providerId !== providerId) return false
    const refs = RuntimeMethodSchemaRefs[CONTRACT].subscribe
    const reply = await chosen.value.query(
      {
        target: chosen.value.binding,
        method: 'subscribe',
        input: inline(refs.input, subscription('select')),
      },
      reader(),
    )
    return (
      reply.ok &&
      reply.value.kind === 'value' &&
      same(reply.value.output.schema, refs.output) &&
      reply.value.output.kind === 'inline' &&
      page(reply.value.output.value as Page) !== undefined
    )
  },
  normal(seen) {
    const pages = seen.pages.map(page)
    const read = pages.flatMap((item) => item?.items ?? [])
    const refs = seen.refs.map(eventRef)
    const [sixth] = records(seen.resumed)
    return (
      same(
        seen.pages.map((fact) =>
          'refused' in fact
            ? null
            : [
                fact.page.items.length,
                fact.page.complete,
                fact.page.nextCursor === null ? null : typeof fact.page.nextCursor,
                fact.checkpoint === null ? null : typeof fact.checkpoint,
              ],
        ),
        [
          [2, false, 'string', null],
          [2, false, 'string', null],
          [1, true, null, 'string'],
        ],
      ) &&
      read.every((record, index) => issued(record, normalRequest(index + 1), 'normal')) &&
      same(read.map(refOf), refs.slice(0, 5)) &&
      ascending(read) &&
      new Set(read.map((record) => record.event.eventId)).size === 5 &&
      same(keys(seen.filtered), ['normal-1', 'normal-3', 'normal-5']) &&
      same(keys(seen.exact), ['normal-2', 'normal-4']) &&
      page(seen.exact)?.complete === true &&
      page(seen.exact)?.nextCursor === null &&
      !('refused' in seen.exact) &&
      typeof seen.exact.checkpoint === 'string' &&
      records(seen.empty).length === 0 &&
      page(seen.empty)?.complete === true &&
      page(seen.empty)?.nextCursor === null &&
      !('refused' in seen.empty) &&
      typeof seen.empty.checkpoint === 'string' &&
      refs[0] !== undefined &&
      code(seen.revokedReplay) === 'permission_denied' &&
      same(records(seen.revokedVisible).map(refOf), refs.slice(0, 5)) &&
      same(eventRef(seen.coveringReplay), refs[0]) &&
      same(eventRef(seen.replay), refs[0]) &&
      records(seen.resumed).length === 1 &&
      page(seen.resumed)?.complete === true &&
      issued(sixth, normalRequest(6), 'normal') &&
      same(refOf(sixth), refs[5]) &&
      ascending([...read, ...records(seen.resumed)]) &&
      // A page cursor keeps its page set; the event published after it waits for the checkpoint.
      same(records(seen.fixed).map(refOf), records(seen.pages[2]).map(refOf)) &&
      page(seen.fixed)?.complete === true &&
      same(keys(seen.exactResumed), ['normal-6'])
    )
  },
  deny: (seen) =>
    same(seen.refusals, [
      'invalid_request',
      'invalid_request',
      'invalid_request',
      'invalid_request',
      'permission_denied',
      'revision_conflict',
      'not_found',
      'idempotency_conflict',
      'idempotency_conflict',
      'permission_denied',
      'permission_denied',
      'permission_denied',
      'permission_denied',
      'resync_required',
      'resync_required',
      'resync_required',
      'resync_required',
      'resync_required',
      'permission_denied',
    ]) &&
    same(keys(seen.visible), ['deny-1']) &&
    issued(records(seen.visible)[0], publication('deny', 'deny-1'), 'deny'),
  cancel(seen) {
    const [record] = records(seen.after)
    const retried = eventRef(seen.retried[0])
    return (
      same(seen.refusals, ['cancelled', 'cancelled', 'cancelled']) &&
      page(seen.untouched)?.items.length === 0 &&
      same(keys(seen.after), ['cancel-1']) &&
      issued(record, publication('cancel', 'cancel-1'), 'cancel') &&
      retried !== undefined &&
      same(retried, refOf(record)) &&
      same(eventRef(seen.retried[1]), retried)
    )
  },
  recover(seen) {
    const all = records(seen.all)
    const named = (key: string) => refOf(all.find((record) => record.event.idempotencyKey === key))
    const [held, again] = seen.held.map(eventRef)
    return (
      seen.kills.length === 1 &&
      seen.kills.every((kill) => kill.signal === 'SIGKILL' && kill.pid !== null && kill.pid !== pid) &&
      same(keys(seen.first), ['recover-1']) &&
      same(keys(seen.resumed), ['recover-2', 'recover-3']) &&
      same(keys(seen.all), ['recover-1', 'recover-2', 'recover-3', 'recover-4']) &&
      all.every((record) => issued(record, publication('recover', record.event.idempotencyKey), 'recover')) &&
      contiguous(all) &&
      same(eventRef(seen.replayed), named('recover-2')) &&
      held !== undefined &&
      same(held, named('recover-4')) &&
      same(again, held)
    )
  },
  dispose: (seen) =>
    seen.refused.length === 2 &&
    seen.refused.every((detail) => Object.hasOwn(RuntimeErrorDetails, detail)) &&
    seen.storeRemains &&
    same(keys(seen.resumed), ['dispose-2']) &&
    seen.mountRefused &&
    returned(seen.handles),
}

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['subscribe'],
  normal: ['publish', 'subscribe'],
  deny: ['publish', 'subscribe'],
  cancel: ['publish', 'subscribe'],
  recover: ['publish', 'subscribe'],
  dispose: ['publish', 'subscribe'],
}

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

export interface EventsConformanceBinding {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the provider code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly port: EventsContractPort
}

/** Register select, normal, deny, cancel, recover and dispose for one events provider. */
export function registerEventsContract(harness: ConformanceHarness, binding: EventsConformanceBinding): void {
  const digests = [binding.providerDigest, binding.configDigest, binding.releaseSetDigest]
  const observe = async <K extends ScenarioName>(scenario: K, context: CaseContext) => {
    try {
      return await JUDGE[scenario](await binding.port[scenario](context), context, binding.providerId)
    } catch {
      return false
    }
  }
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract: CONTRACT,
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(context): Promise<AssertionInput> {
        const passed = digests.every((digest) => HEX.test(digest)) && (await observe(scenario, context))
        return {
          id: `${CONTRACT}/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: binding.recipe,
          features: [...FEATURES[scenario]],
          build: binding.build,
          consumer: `${CONTRACT}-conformance-consumer`,
          command: binding.command,
          status: passed ? 'passed' : 'failed',
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          fixture: scenario === 'select' ? 'test-service-container' : null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'runtime',
            methodKind: scenario === 'select' ? 'query' : 'action',
            lifecycle: LIFECYCLE[scenario],
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
  }
}
