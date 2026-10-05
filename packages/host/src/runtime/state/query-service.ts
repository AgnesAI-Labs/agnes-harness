import { defaultIds } from '@agnes/core'
import type { CallContext, Outcome, QueryHandler, RuntimeError } from '@agnes/extension-api/runtime'
import {
  type ActionRecordValue,
  type AttemptRecordValue,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type JsonValue,
  type RunBinding,
  type RunRecordValue,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
  type SnapshotRef,
  type StateAuthorityRef,
  type StateOpenRequest,
  type StateOpenResult,
  type StateScanRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { createNativeStateReadOwner } from './native-read-owner.js'
import {
  DEFAULT_READABLE,
  type ReadableSchema,
  type StateReadBridge,
  type StateReadGrant,
} from './read-scope.js'
import { actionRecordId, attemptRecordId, runBindingRecordId, runRecordId, sameJson } from './records.js'
import { StateRefusal } from './refusal.js'
import { bodyItem, PAGE_MAX_BYTES, type Stored, storedItem, storedOf } from './stored-record.js'
import type { NativeStateRecordFact } from './transactions.js'

type Owner = ReturnType<typeof createNativeStateReadOwner>
type FailureCode = RuntimeError['code']
const scanSchemas = RuntimeMethodSchemaRefs['agh.state'].scan
const PAGE_ITEM_BUDGET = PAGE_MAX_BYTES - 1_024
const COLLECTIONS = ['records', 'actions', 'signals'] as const
const LIMITS = { maxBytes: 1_048_576, maxDepth: 64, maxMembers: 10_000 }
const INPUT_KEYS = ['owner', 'bridge', 'authority', 'now', 'readable']

class Failure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly detailCode: string,
    message: string,
    readonly retry: 'never' | 'retry_read' = 'never',
  ) {
    super(message)
  }
}
const scopeFailure = () => new Failure('denied', 'state_scope', 'state read is outside the granted scope')
const requestFailure = () => new Failure('invalid_input', 'state_request', 'state read request is not valid')
const cancelled = () => new Failure('cancelled', 'state_cancelled', 'call was cancelled')
const resync = () =>
  new Failure('conflict', 'resync_required', 'open a fresh snapshot and read again', 'retry_read')

export type StoredRead<T = JsonValue> = Readonly<{
  stored: Readonly<{ meta: Stored['meta']; owner: Stored['owner']; value: T }>
  valueDigest: string
  versionDigest: string
  ledgerSeq: number
}>

export type StateRecordReader = Readonly<{
  open(caller: CallContext, sessionId: string | null): Promise<Outcome<SnapshotRef>>
  release(snapshot: SnapshotRef): void
  get(
    caller: CallContext,
    snapshot: SnapshotRef,
    recordId: string,
    schema: SchemaRef,
  ): Promise<Outcome<StoredRead | null>>
  getRun(
    caller: CallContext,
    snapshot: SnapshotRef,
    runId: string,
  ): Promise<Outcome<StoredRead<RunRecordValue> | null>>
  getRunBinding(
    caller: CallContext,
    snapshot: SnapshotRef,
    runId: string,
  ): Promise<Outcome<StoredRead<RunBinding> | null>>
  getAction(
    caller: CallContext,
    snapshot: SnapshotRef,
    actionId: string,
  ): Promise<Outcome<StoredRead<ActionRecordValue> | null>>
  getAttempt(
    caller: CallContext,
    snapshot: SnapshotRef,
    attemptId: string,
  ): Promise<Outcome<StoredRead<AttemptRecordValue> | null>>
}>

export type StateQueryService = Readonly<{
  query: QueryHandler
  open(
    request: Extract<StateOpenRequest, { mode: 'read' }>,
    caller: CallContext,
  ): Promise<Outcome<StateOpenResult>>
  reader: StateRecordReader
  /**
   * First step of the close order (service, then read owner, then State). New calls are refused at
   * once; the promise resolves after the owner has drained the reads already running. It never
   * touches the database, which State closes afterwards.
   */
  close(): Promise<void>
}>

type Registered = { snapshot: SnapshotRef; grant: StateReadGrant; deadline: number }

/**
 * Host-private State read service over State's own read owner. It receives no database handle and
 * no identity module: who may read is answered only by the bridge, whose `check()` runs on every
 * page and every point read, before and after the owner reads. Envelope items carry a placeholder
 * schema reference until the envelope is registered in the public protocol, so this service must
 * not be wired into a production path or its items published yet.
 */
export function createStateQueryService(
  input: Readonly<{
    owner: Owner
    bridge: StateReadBridge
    authority: StateAuthorityRef
    now: () => number
    readable?: readonly ReadableSchema[]
  }>,
): StateQueryService {
  if (Object.keys(input).some((key) => !INPUT_KEYS.includes(key)))
    throw new Error('the State query service takes only an owner, a bridge, an authority and a clock')
  const { owner, bridge, authority, now } = input
  const readable = input.readable ?? DEFAULT_READABLE
  const ids = defaultIds(now)
  const registry = new Map<string, Registered>()
  let closed = false
  let closing: Promise<void> | null = null

  function fail(caught: unknown): RuntimeError {
    let failure: Failure
    if (caught instanceof Failure) failure = caught
    else if (caught instanceof StateRefusal) {
      const detail = caught.failure.detailCode
      if (detail.startsWith('state_'))
        failure = new Failure(caught.failure.code, detail, caught.failure.message)
      else if (detail === 'integrity')
        failure = new Failure('incompatible', 'state_integrity', 'original State history failed verification')
      else failure = scopeFailure()
    } else failure = new Failure('internal', 'state_unavailable', 'state read failed')
    return {
      code: failure.code,
      detailCode: failure.detailCode,
      message: failure.message,
      retryAdvice: { kind: failure.retry },
      diagnosticId: ids.ulid(),
    } as RuntimeError
  }
  async function guard<T>(caller: CallContext, body: () => Promise<T>): Promise<Outcome<T>> {
    try {
      if (closed) throw resync()
      if (caller.signal.aborted) throw cancelled()
      return { ok: true, value: await body() }
    } catch (caught) {
      if (closed) return { ok: false, error: fail(resync()) }
      return { ok: false, error: fail(caller.signal.aborted ? cancelled() : caught) }
    }
  }
  function prune() {
    const at = now()
    for (const [id, entry] of registry) if (entry.deadline <= at) registry.delete(id)
  }
  /** Synchronous and throwing; a refusal never says why. */
  function check(grant: StateReadGrant) {
    try {
      grant.check()
    } catch {
      throw scopeFailure()
    }
  }
  type Resolved = { registered: Registered; current: StateReadGrant }
  function resolve(caller: CallContext, wire: SnapshotRef): Resolved {
    prune()
    const registered = registry.get(wire.snapshotId)
    if (!registered) throw resync()
    if (!sameJson(registered.snapshot, wire))
      throw new Failure('denied', 'state_snapshot', 'snapshot does not match its original')
    check(registered.grant)
    const current = bridge.grant(caller, null)
    if (!current || current.fingerprint !== registered.grant.fingerprint) throw scopeFailure()
    check(current)
    return { registered, current }
  }
  /** The post-read check: a revoke committed while the owner was reading drops the result. */
  function recheck(caller: CallContext, resolved: Resolved) {
    if (caller.signal.aborted) throw cancelled()
    if (closed) throw resync()
    check(resolved.registered.grant)
    check(resolved.current)
  }

  async function openSnapshot(caller: CallContext, sessionId: string | null) {
    const grant = bridge.grant(caller, sessionId)
    if (!grant || (sessionId !== null && grant.sessionId !== sessionId)) throw scopeFailure()
    check(grant)
    const result = await owner.openVerifiedResult(grant.sessionId, grant)
    if (caller.signal.aborted || closed) {
      owner.releaseSnapshot(result.snapshot, grant)
      throw caller.signal.aborted ? cancelled() : resync()
    }
    const deadline = Math.min(grant.deadline, Date.parse(result.snapshot.expiresAt))
    registry.set(result.snapshot.snapshotId, { snapshot: result.snapshot, grant, deadline })
    return result
  }

  function decode(request: unknown): StateScanRequest {
    const query = validateRuntime('ServiceQuery', request)
    if (!query.ok) throw requestFailure()
    if (query.value.target.contract !== 'agh.state') throw requestFailure()
    if (query.value.method === 'probeCommit')
      throw new Failure('incompatible', 'state_method', 'probeCommit is not served here')
    if (query.value.method !== 'scan' || query.value.page !== undefined) throw requestFailure()
    const raw = query.value.input
    if (
      raw.kind !== 'inline' ||
      !sameJson(raw.schema, scanSchemas.input) ||
      canonicalJsonDigest(raw.value) !== raw.digest
    )
      throw requestFailure()
    const scan = validateRuntime('StateScanRequest', raw.value)
    if (!scan.ok) throw requestFailure()
    if (query.value.snapshot !== undefined && query.value.snapshot !== scan.value.snapshot.snapshotId)
      throw requestFailure()
    if (scan.value.limit < 1 || scan.value.limit > 500) throw requestFailure()
    return scan.value
  }

  function checkFilter(scan: StateScanRequest, grant: StateReadGrant) {
    if (!(COLLECTIONS as readonly string[]).includes(scan.collection))
      throw new Failure('incompatible', 'state_collection', 'this collection is not served')
    const allowed =
      scan.collection === 'records'
        ? ['typeIds']
        : scan.collection === 'actions'
          ? ['runId', 'parentActionId', 'states']
          : ['runId', 'targetActionId', 'typeIds', 'fromSeq', 'toSeq']
    if (Object.keys(scan.filter).some((key) => !allowed.includes(key))) throw requestFailure()
    if (scan.collection !== 'records' && scan.filter.runId === undefined) throw requestFailure()
    const window = grant.window
    if (window.kind !== 'session' && scan.filter.runId !== undefined && scan.filter.runId !== window.runId)
      throw scopeFailure()
    if (scan.collection === 'records')
      for (const typeId of scan.filter.typeIds ?? [])
        if (!readable.some((entry) => entry.schema.typeId === typeId))
          throw new Failure('incompatible', 'state_type', 'a requested record type is not readable')
  }

  function packer(collection: StateScanRequest['collection']) {
    return (facts: readonly NativeStateRecordFact[]): number => {
      let total = 0
      let count = 0
      for (const fact of facts) {
        const item = collection === 'records' ? storedItem(fact) : bodyItem(fact)
        if (count > 0 && total + item.bytes + 256 > PAGE_ITEM_BUDGET) break
        total += item.bytes + 256
        count++
      }
      return count
    }
  }

  function reply(
    snapshot: SnapshotRef,
    page: { items: DataRef[]; nextCursor: string | null; complete: boolean },
  ) {
    const result = {
      items: page.items,
      snapshot: snapshot.snapshotId,
      nextCursor: page.nextCursor,
      complete: page.complete,
    }
    if (!validateRuntime('StateScanResult', result).ok)
      throw new Failure('internal', 'state_unavailable', 'state read failed')
    const body = boundedCanonicalJson(result, LIMITS)
    if (!body.ok || body.value.bytes > PAGE_MAX_BYTES)
      throw new Failure('incompatible', 'state_item_oversize', 'a page exceeds the inline limit')
    return {
      kind: 'value' as const,
      snapshot: snapshot.snapshotId,
      output: {
        kind: 'inline' as const,
        schema: scanSchemas.output,
        value: body.value.json,
        digest: canonicalJsonDigest(body.value.json),
        bytes: body.value.bytes,
      },
    }
  }

  const scan: QueryHandler = (request, caller) =>
    guard(caller, async () => {
      const scanRequest = decode(request)
      const resolved = resolve(caller, scanRequest.snapshot)
      const { registered } = resolved
      checkFilter(scanRequest, registered.grant)
      if (scanRequest.collection === 'records' && scanRequest.filter.typeIds?.length === 0)
        return reply(registered.snapshot, { items: [], nextCursor: null, complete: true })
      const page = await owner.scanVerifiedPage(
        registered.snapshot,
        { ...scanRequest, snapshot: registered.snapshot },
        registered.grant,
        { window: registered.grant.window, pack: packer(scanRequest.collection) },
      )
      recheck(caller, resolved)
      const items = page.items.map((fact) =>
        scanRequest.collection === 'records' ? storedItem(fact) : bodyItem(fact),
      )
      return reply(registered.snapshot, { items, nextCursor: page.nextCursor, complete: page.complete })
    })

  async function point(caller: CallContext, wire: SnapshotRef, recordId: string, schema: SchemaRef) {
    if (!readable.some((entry) => sameJson(entry.schema, schema)))
      throw new Failure('incompatible', 'state_type', 'the record type is not readable')
    const resolved = resolve(caller, wire)
    const { registered } = resolved
    const fact = await owner.readVerifiedRecord(
      registered.snapshot,
      recordId,
      schema,
      registered.grant,
      registered.grant.window,
    )
    recheck(caller, resolved)
    if (!fact) return null
    return Object.freeze({
      stored: storedOf(fact),
      valueDigest: canonicalJsonDigest(fact.value),
      versionDigest: fact.digest,
      ledgerSeq: fact.ledgerSeq,
    })
  }
  const schemaOf = (definition: keyof RuntimeWireTypes) => {
    const entry = readable.find((item) => item.definition === definition)
    if (!entry) throw new Error(`readable schema missing: ${definition}`)
    return entry.schema
  }
  const typed =
    <T>(definition: keyof RuntimeWireTypes, idOf: (id: string) => string) =>
    (caller: CallContext, snapshot: SnapshotRef, id: string) =>
      guard(caller, async () => {
        const read = await point(caller, snapshot, idOf(id), schemaOf(definition))
        if (!read) return null
        if (!validateRuntime(definition, read.stored.value).ok)
          throw new Failure('incompatible', 'state_integrity', 'original State history failed verification')
        return read as unknown as StoredRead<T>
      })

  const reader: StateRecordReader = Object.freeze({
    open: (caller, sessionId) => guard(caller, async () => (await openSnapshot(caller, sessionId)).snapshot),
    release(snapshot) {
      const registered = registry.get(snapshot.snapshotId)
      if (!registered || !sameJson(registered.snapshot, snapshot)) return
      registry.delete(snapshot.snapshotId)
      owner.releaseSnapshot(registered.snapshot, registered.grant)
    },
    get: (caller, snapshot, recordId, schema) =>
      guard(caller, () => point(caller, snapshot, recordId, schema)),
    getRun: typed<RunRecordValue>('RunRecordValue', runRecordId),
    getRunBinding: typed<RunBinding>('RunBinding', runBindingRecordId),
    getAction: typed<ActionRecordValue>('ActionRecordValue', actionRecordId),
    getAttempt: typed<AttemptRecordValue>('AttemptRecordValue', attemptRecordId),
  })

  return Object.freeze({
    query: scan,
    open: (request, caller) =>
      guard(caller, async () => {
        const checked = validateRuntime('StateOpenRequest', request)
        if (!checked.ok || checked.value.mode !== 'read') throw requestFailure()
        if (!sameJson(checked.value.authority, authority)) throw scopeFailure()
        const result = await openSnapshot(caller, checked.value.sessionId)
        return {
          snapshot: result.snapshot,
          formatVersion: result.formatVersion,
          minReader: result.minReader,
          claim: null,
          parent: null,
        }
      }),
    reader,
    close(): Promise<void> {
      closed = true
      registry.clear()
      closing ??= owner.close()
      return closing
    },
  })
}
