import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeErrorDetails,
  RuntimeSchemaRefs,
  validateDomainCommandSchemas,
  validateRuntime,
} from '@agnes/protocol/runtime'

type Detail = keyof typeof RuntimeErrorDetails
type Refusal = { ok: false; error: Wire.RuntimeError }
type AcceptedHandle = Exclude<Wire.CommandHandle, { status: 'not-accepted' }>
type Completion = AcceptedHandle['completion']
type Delivery = Wire.CommandRuntimeAcceptanceResult['deliveries'][number]

export const fail = (detail: Detail, message: string): Refusal => ({
  ok: false,
  error: {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice: {
      kind: (RuntimeErrorDetails[detail].retryAdviceKinds as readonly string[]).includes('never')
        ? 'never'
        : 'retry_read',
    },
    diagnosticId: 'domain-projection',
  },
})

/** One accepted command. The handle is stored once; later progress is derived from its dispatch acks. */
export type StoredDomainCommand = Readonly<{
  key: Wire.Digest
  fingerprint: Wire.Digest
  name: string
  handle: AcceptedHandle
  /** The plan result, reported again inside the runtime acceptance record. */
  value: Wire.DataRef | null
  dispatchKeys: readonly string[]
}>

export type StoredDomainState = Readonly<{ value: Wire.DataRef | null; revision: number }>

/** One planned dispatch, delivered at least once under its owner-issued event identity. */
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

export interface DomainCommandTransaction {
  /** Undefined only when this consistent read proves absence; a store that cannot prove it must throw. */
  command(key: Wire.Digest): StoredDomainCommand | undefined
  putCommand(command: StoredDomainCommand): void
  state(): StoredDomainState
  putState(state: StoredDomainState): void
  lastSequence(): number
  putEvent(record: Wire.DomainEventRecord): void
  putDispatch(dispatch: StoredDispatch): void
  dispatches(commandId: Wire.Id): readonly DispatchProgress[]
}

export interface DomainCommandStorage {
  /** Commits every put of one body together. A body that throws leaves nothing behind. */
  transaction<T>(body: (tx: DomainCommandTransaction) => T): Promise<T>
}

export type ResolvedCommandAction = Readonly<{ view: Wire.DomainView; action: Wire.ViewAction }>

export interface DomainCommandViews {
  /** Finds the action in the caller's current authorized projection, never in a stale copy. */
  resolve(ref: Wire.DomainActionRef, context: CallContext): Promise<Outcome<ResolvedCommandAction>>
  /** Whether the caller may still read this owner's commands; checked again on every replay and status. */
  canRead(context: CallContext): Promise<boolean>
}

/** An author command as the owner registered it; prepare plans only and never writes. */
export type RegisteredDomainCommand = Readonly<{
  inputSchema: Wire.SchemaRef
  resultSchema: Wire.SchemaRef
  completion: Completion
  prepare(frame: Wire.DomainCommandFrame): Promise<Outcome<Wire.DomainCommandPlan>>
}>

export type DomainCommandOwner = Readonly<{
  /** The domain owner or command namespace; part of every request identity. */
  namespace: string
  authorityId: Wire.Id
  aggregate: Readonly<{ typeId: Wire.TypeId; id: Wire.Id }>
  source: Wire.BindingRef
  stateSchema: Wire.SchemaRef
  /** The Runtime inbox consumer that receives this owner's dispatches. */
  destination: Wire.Id
  storage: DomainCommandStorage
  views: DomainCommandViews
  commands: ReadonlyMap<string, RegisteredDomainCommand>
  clock: Readonly<{ now(): Wire.Timestamp; newId(): Wire.Id }>
}>

/** A command request from a trusted Host entry; features are the ones the session negotiated. */
export type DomainCommandSubmit = Readonly<{
  request: unknown
  context: CallContext
  features: readonly string[]
}>

const same = (left: unknown, right: unknown) => jcs(left) === jcs(right)

/** The fixed runtime acceptance record: the plan result plus one Runtime ack per planned dispatch. */
function acceptance(value: Wire.DataRef | null, deliveries: Delivery[]) {
  const result: Wire.JsonValue = { value, deliveries }
  return {
    kind: 'inline' as const,
    schema: RuntimeSchemaRefs.CommandRuntimeAcceptanceResult,
    value: result,
    digest: canonicalJsonDigest(result),
    bytes: new TextEncoder().encode(jcs(result)).length,
  }
}

function checkedHandle(handle: unknown): Outcome<AcceptedHandle> {
  const parsed = validateRuntime('CommandHandle', handle)
  return parsed.ok && parsed.value.status !== 'not-accepted'
    ? { ok: true, value: parsed.value }
    : fail('internal_error', 'command handle failed its own schema')
}

const wireContext = (context: CallContext): Wire.CallContextWire => ({
  principalRef: context.principalRef,
  scope: context.scope,
  bindingId: context.bindingId,
  invocationId: context.invocationId,
  deadline: context.deadline,
  traceRef: context.traceRef,
  authorizationRef: context.authorizationRef,
})

/** Checks an untrusted plan before any effect; returns the reason it cannot commit. */
function planError(
  plan: Wire.DomainCommandPlan,
  command: RegisteredDomainCommand,
  stateSchema: Wire.SchemaRef,
): string | undefined {
  if (!same(plan.state.schema, stateSchema)) return 'plan state does not use the domain state schema'
  if (!same(plan.result.schema, command.resultSchema))
    return 'plan result does not use the command result schema'
  for (const event of plan.events)
    if (event.typeId !== event.schema.typeId || !same(event.schema, event.payload.schema))
      return 'planned event type and payload schema disagree'
  if (new Set(plan.dispatches.map((dispatch) => dispatch.key)).size !== plan.dispatches.length)
    return 'dispatch keys repeat'
  for (const dispatch of plan.dispatches)
    if (
      dispatch.kind === 'signal' &&
      (dispatch.typeId !== dispatch.schema.typeId || !same(dispatch.schema, dispatch.payload.schema))
    )
      return 'signal type and payload schema disagree'
  return undefined
}

/**
 * Domain command rules over any atomic store: one journal entry per request identity, a plan prepared
 * once, and state, events, dispatches and the handle committed together.
 */
export function createDomainCommands(owner: DomainCommandOwner) {
  const { storage, views, clock } = owner

  async function transaction<T>(body: (tx: DomainCommandTransaction) => T): Promise<T | Refusal> {
    try {
      return await storage.transaction(body)
    } catch (error) {
      return fail('backend_unavailable', error instanceof Error ? error.message : 'command store unavailable')
    }
  }

  // Scope, principal, owner namespace and request id: the identity a retry must repeat exactly.
  const requestKey = (context: CallContext, requestId: string) =>
    canonicalJsonDigest({
      scope: context.scope,
      principalRef: context.principalRef,
      namespace: owner.namespace,
      requestId,
    })

  /** A runtime-accepted command succeeds once every dispatch it planned holds an ack; acks never revert. */
  function derive(
    stored: StoredDomainCommand,
    progress: readonly DispatchProgress[],
  ): Outcome<AcceptedHandle> {
    const { handle } = stored
    if (handle.status !== 'running' || handle.completion !== 'runtime-accepted')
      return { ok: true, value: handle }
    const acks = new Map(progress.map((entry) => [entry.key, entry.ack]))
    const deliveries: Delivery[] = []
    for (const key of stored.dispatchKeys) {
      const ack = acks.get(key)
      if (!ack) return { ok: true, value: handle }
      deliveries.push(ack)
    }
    return checkedHandle({
      ...handle,
      status: 'succeeded',
      revision: handle.revision + 1,
      result: acceptance(stored.value, deliveries),
    })
  }

  async function read(key: Wire.Digest, context: CallContext) {
    if (!(await views.canRead(context)))
      return fail('permission_denied', 'caller may no longer read this command')
    const found = await transaction((tx) => {
      const stored = tx.command(key)
      if (!stored) return { ok: true as const, value: undefined }
      const progress = stored.handle.status === 'running' ? tx.dispatches(stored.handle.commandId) : []
      return { ok: true as const, value: { stored, progress } }
    })
    return found
  }

  async function replay(key: Wire.Digest, fingerprint: Wire.Digest, context: CallContext) {
    const found = await read(key, context)
    if (!found.ok || !found.value) return found
    return found.value.stored.fingerprint === fingerprint
      ? derive(found.value.stored, found.value.progress)
      : fail('idempotency_conflict', 'request id already names another command')
  }

  return {
    async submit(input: DomainCommandSubmit): Promise<Outcome<Wire.CommandHandle>> {
      const parsed = validateRuntime('DomainCommandRequest', input.request)
      if (!parsed.ok) return fail('invalid_request', 'command request does not match its schema')
      const { action, input: data, requestId, expectedRevision, commandSchema } = parsed.value
      const { context } = input
      const key = requestKey(context, requestId)
      // The view identity at a fixed revision names exactly one action, so it stands for the resolved target.
      const fingerprint = canonicalJsonDigest({
        action,
        commandSchema,
        input: canonicalJsonDigest(data),
        expectedRevision,
      })
      const prior = await replay(key, fingerprint, context)
      if (!prior.ok || prior.value) return prior as Outcome<Wire.CommandHandle>

      const resolved = await views.resolve(action, context)
      if (!resolved.ok) return resolved
      const { view, action: found } = resolved.value
      if (view.viewId !== action.viewId || view.revision !== action.viewRevision)
        return fail('revision_conflict', 'view is no longer at the requested revision')
      if (found.kind !== 'command' || found.actionKey !== action.actionKey)
        return fail('invalid_request', 'action is not a command of this view')
      if (found.availability !== 'enabled')
        return fail('blocked', found.disabledReason ?? 'action is disabled')
      if (!found.requiredFeatures.every((feature) => input.features.includes(feature)))
        return fail('unsupported', 'a feature the action requires was not negotiated')
      const command = owner.commands.get(found.command)
      if (!command) return fail('not_found', 'command is not registered by this owner')
      const business = { action, input: data, requestId, expectedRevision, commandSchema }
      const schemas = validateDomainCommandSchemas(business, found.inputSchema, command.inputSchema)
      if (!schemas.ok) return fail('invalid_request', schemas.errors[0]?.message ?? 'command schema mismatch')

      const current = await transaction((tx) => tx.state())
      if ('ok' in current) return current
      if (current.revision !== expectedRevision)
        return fail('revision_conflict', 'domain state is no longer at the expected revision')
      const commandId = clock.newId()
      const prepared = await command.prepare({
        commandId,
        requestId,
        name: found.command,
        input: data,
        state: current.value,
        stateRevision: current.revision,
        expectedRevision,
        sourceView: action,
        observedAt: clock.now(),
        context: wireContext(context),
        commandSchema,
      })
      if (!prepared.ok) return prepared
      const planned = validateRuntime('DomainCommandPlan', prepared.value)
      if (!planned.ok) return fail('invalid_request', 'command plan does not match its schema')
      const plan = planned.value
      if (plan.expectedRevision !== current.revision)
        return fail('revision_conflict', 'plan was prepared against another revision')
      const invalid = planError(plan, command, owner.stateSchema)
      if (invalid) return fail('invalid_request', invalid)
      // ponytail: start-run has no Runtime intake that names a run yet; refused until that contract exists.
      if (plan.dispatches.some((dispatch) => dispatch.kind === 'start-run'))
        return fail('unsupported', 'start-run dispatch has no runtime intake yet')

      const now = clock.now()
      const commitId = clock.newId()
      const revision = current.revision + 1
      const causation = { commandId }
      const base = {
        source: owner.source,
        scope: context.scope,
        occurredAt: now,
        causation,
        principalRef: context.principalRef,
        correlationId: context.traceRef,
        provenance: { sourceRefs: [], producer: owner.source, trustLabels: [] },
      }
      const aggregate = { authorityId: owner.authorityId, ...owner.aggregate }
      const event = (typeId: string, schema: Wire.SchemaRef, payload: Wire.DataRef, idempotencyKey: string) =>
        validateRuntime('DomainEvent', {
          ...base,
          eventId: clock.newId(),
          typeId,
          schema,
          payload,
          idempotencyKey,
        })
      const events: { event: Wire.DomainEvent; fingerprint: Wire.Digest }[] = []
      for (const intent of plan.events) {
        const built = event(intent.typeId, intent.schema, intent.payload, intent.idempotencyKey)
        if (!built.ok) return fail('invalid_request', 'planned event does not form a valid event')
        events.push({
          event: built.value,
          fingerprint: canonicalJsonDigest({ intent, aggregate, causation }),
        })
      }
      const dispatches: StoredDispatch[] = []
      for (const dispatch of plan.dispatches as Extract<Wire.DomainDispatch, { kind: 'signal' }>[]) {
        const built = event(
          dispatch.typeId,
          dispatch.schema,
          dispatch.payload,
          `${commandId}/${dispatch.key}`,
        )
        if (!built.ok) return fail('invalid_request', 'planned dispatch does not form a valid event')
        dispatches.push({
          commandId,
          key: dispatch.key,
          destination: owner.destination,
          sourceCommitId: commitId,
          event: built.value,
          dispatch,
          fingerprint: canonicalJsonDigest({ dispatch, causation, destination: owner.destination }),
        })
      }
      const accepted = { commandId, requestId, revision: 1, error: null }
      const handle = checkedHandle(
        command.completion === 'domain-commit'
          ? { ...accepted, completion: 'domain-commit', status: 'succeeded', result: plan.result }
          : dispatches.length
            ? { ...accepted, completion: 'runtime-accepted', status: 'running', result: null }
            : {
                ...accepted,
                completion: 'runtime-accepted',
                status: 'succeeded',
                result: acceptance(plan.result, []),
              },
      )
      if (!handle.ok) return handle

      const committed = await transaction((tx): Outcome<Wire.CommandHandle> | 'raced' => {
        if (tx.command(key)) return 'raced'
        if (tx.state().revision !== plan.expectedRevision)
          return fail('revision_conflict', 'domain state moved while the plan was prepared')
        const first = tx.lastSequence() + 1
        const records = events.map(({ event, fingerprint }, index) =>
          validateRuntime('DomainEventRecord', {
            event,
            authorityId: owner.authorityId,
            sequence: first + index,
            aggregate: { ...aggregate, revision },
            fingerprint,
          }),
        )
        if (records.some((record) => !record.ok))
          return fail('invalid_request', 'planned event does not form a valid record')
        tx.putState({ value: plan.state, revision })
        for (const record of records) if (record.ok) tx.putEvent(record.value)
        for (const dispatch of dispatches) tx.putDispatch(dispatch)
        tx.putCommand({
          key,
          fingerprint,
          name: found.command,
          handle: handle.value,
          value: plan.result,
          dispatchKeys: dispatches.map((dispatch) => dispatch.key),
        })
        return { ok: true, value: handle.value }
      })
      // Another submit with the same identity committed first; answer exactly as a retry would.
      if (committed === 'raced')
        return replay(key, fingerprint, context) as Promise<Outcome<Wire.CommandHandle>>
      return committed
    },

    /** Reads the journal; not-accepted is returned only when this owner's store proves absence. */
    async commandStatus(requestId: unknown, context: CallContext): Promise<Outcome<Wire.CommandHandle>> {
      const parsed = validateRuntime('DomainCommandClientCommandStatusRequest', requestId)
      if (!parsed.ok) return fail('invalid_request', 'status request is not a request id')
      const found = await read(requestKey(context, parsed.value), context)
      if (!found.ok) return found
      if (found.value) return derive(found.value.stored, found.value.progress)
      return {
        ok: true,
        value: {
          requestId: parsed.value,
          status: 'not-accepted',
          commandId: null,
          revision: null,
          completion: null,
          result: null,
          error: null,
        },
      }
    },
  }
}

export type DomainCommands = ReturnType<typeof createDomainCommands>
