import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import {
  createRuntimeInboxFixture,
  RUNTIME_INBOX_FIXTURE,
  type TestServiceBinding,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  createDomainCommands,
  type DispatchProgress,
  type DomainCommandStorage,
  fail,
  type RegisteredDomainCommand,
  type StoredDispatch,
  type StoredDomainCommand,
  type StoredDomainState,
} from '../../src/runtime/projection/commands.js'
import {
  createDomainProjection,
  type DomainProjectionPorts,
  type ProjectionDelta,
  type ReaderGrant,
} from '../../src/runtime/projection/domain.js'
import {
  createProjectionProvider,
  type NativeConversation,
  type ProjectionAccess,
  type ProjectionDomain,
} from '../../src/runtime/providers/projection.js'

const schema = (typeId: string): Wire.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest(typeId),
})
const inline = (ref: Wire.SchemaRef, value: Wire.JsonValue): Wire.DataRef => ({
  kind: 'inline',
  schema: ref,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})

const inputSchema = schema('acme.tasks/rename-input@1')
const resultSchema = schema('acme.tasks/rename-result@1')
const stateSchema = schema('acme.tasks/state@1')
const eventSchema = schema('acme.tasks/renamed@1')
const signalSchema = schema('acme.tasks/wake@1')
const viewSchema = schema('acme.tasks/card@1')
const readStateSchema = schema('acme.tasks/read-state@1')
const querySchema = schema('acme.tasks/query@1')
const sessionScope = {
  kind: 'session' as const,
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
}
const source = { bindingId: 'binding-1', contract: 'agh.projection', logicalName: 'tasks', providerId: 'p-1' }

const context = (principalRef = 'alice'): CallContext => ({
  principalRef,
  scope: sessionScope,
  bindingId: 'binding-1',
  invocationId: 'invocation-1',
  deadline: '2026-10-02T00:00:00Z',
  traceRef: 'trace-1',
  authorizationRef: 'authorization-1',
  signal: new AbortController().signal,
})

const commandAction = (actionKey: string, command: string, extra: Partial<Wire.ViewAction> = {}) =>
  ({
    actionKey,
    label: actionKey,
    requiredFeatures: [],
    availability: 'enabled',
    disabledReason: null,
    kind: 'command',
    command,
    inputSchema,
    ...extra,
  }) as Wire.ViewAction

const domainView = (viewId: string, extra: Partial<Wire.DomainView> = {}): Wire.DomainView => ({
  kind: 'domain',
  viewId,
  revision: 3,
  domainType: 'acme.tasks',
  viewSchema,
  renderKey: 'acme.tasks/card',
  scope: sessionScope,
  source: { eventIds: [], projectionRevision: 1 },
  phase: 'finalized',
  fallbackText: `card ${viewId}`,
  data: { viewId },
  resources: [],
  actions: [],
  ...extra,
})

/** Copy-on-write store: a body that throws leaves the committed data untouched. */
function memoryStore() {
  const db = {
    commands: new Map<string, StoredDomainCommand>(),
    state: { value: null, revision: 0 } as StoredDomainState,
    events: [] as Wire.DomainEventRecord[],
    dispatches: [] as { row: StoredDispatch; ack: DispatchProgress['ack'] }[],
  }
  const faults = { unavailable: false, failPutCommand: false }
  const storage: DomainCommandStorage = {
    async transaction(body) {
      if (faults.unavailable) throw new Error('store unavailable')
      const draft = {
        commands: new Map(db.commands),
        state: db.state,
        events: [...db.events],
        dispatches: db.dispatches.map((entry) => ({ ...entry })),
      }
      const result = body({
        command: (key) => draft.commands.get(key),
        putCommand: (command) => {
          if (faults.failPutCommand) throw new Error('disk full')
          draft.commands.set(command.key, command)
        },
        state: () => draft.state,
        putState: (state) => {
          draft.state = state
        },
        lastSequence: () => draft.events.at(-1)?.sequence ?? 0,
        putEvent: (record) => void draft.events.push(record),
        putDispatch: (row) => void draft.dispatches.push({ row, ack: null }),
        dispatches: (commandId) =>
          draft.dispatches
            .filter((entry) => entry.row.commandId === commandId)
            .map((entry) => ({ key: entry.row.key, ack: entry.ack })),
      })
      Object.assign(db, draft)
      return result
    },
  }
  return { db, storage, faults }
}

const signal: Wire.DomainDispatch = {
  key: 'wake',
  kind: 'signal',
  runId: 'run-1',
  typeId: signalSchema.typeId,
  schema: signalSchema,
  payload: inline(signalSchema, { go: true }),
}

function commandHarness() {
  const store = memoryStore()
  const env = {
    view: domainView('board', {
      actions: [
        commandAction('rename', 'rename'),
        commandAction('launch', 'launch'),
        commandAction('ping', 'ping'),
        commandAction('orphan', 'orphan'),
        commandAction('locked', 'rename', { availability: 'disabled', disabledReason: 'archived' }),
        commandAction('beta', 'rename', { requiredFeatures: ['acme.beta.v1'] }),
        {
          actionKey: 'form',
          label: 'Form',
          requiredFeatures: [],
          availability: 'enabled',
          disabledReason: null,
          kind: 'open-form',
          interactionId: 'i-1',
          version: 1,
        },
      ],
    }),
    readable: true,
    prepared: 0,
    dispatches: [] as Wire.DomainDispatch[],
    registryInput: inputSchema,
    planOverride: undefined as ((plan: Wire.DomainCommandPlan) => unknown) | undefined,
    duringPrepare: () => {},
  }
  const register = (
    completion: RegisteredDomainCommand['completion'],
    dispatches: () => Wire.DomainDispatch[],
  ) => ({
    get inputSchema() {
      return env.registryInput
    },
    resultSchema,
    completion,
    async prepare(frame: Wire.DomainCommandFrame): Promise<Outcome<Wire.DomainCommandPlan>> {
      env.prepared++
      env.duringPrepare()
      const plan: Wire.DomainCommandPlan = {
        expectedRevision: frame.stateRevision,
        state: inline(stateSchema, { title: 'renamed', revision: frame.stateRevision + 1 }),
        events: [
          {
            typeId: eventSchema.typeId,
            schema: eventSchema,
            payload: inline(eventSchema, { title: 'renamed' }),
            idempotencyKey: `${frame.requestId}/renamed`,
          },
        ],
        dispatches: dispatches(),
        result: inline(resultSchema, { ok: true }),
      }
      return { ok: true, value: (env.planOverride?.(plan) ?? plan) as Wire.DomainCommandPlan }
    },
  })
  let ids = 0
  const commands = createDomainCommands({
    namespace: 'acme.tasks',
    authorityId: 'authority-1',
    aggregate: { typeId: 'acme.tasks/board@1', id: 'board-1' },
    source,
    stateSchema,
    destination: 'runtime-inbox',
    storage: store.storage,
    views: {
      async resolve(ref) {
        const action = env.view.actions.find((candidate) => candidate.actionKey === ref.actionKey)
        return ref.viewId === env.view.viewId && action
          ? { ok: true, value: { view: env.view, action } }
          : fail('not_found', 'no such action in the authorized projection')
      },
      canRead: async () => env.readable,
    },
    commands: new Map([
      ['rename', register('domain-commit', () => [])],
      ['launch', register('runtime-accepted', () => [signal])],
      ['ping', register('runtime-accepted', () => [])],
    ]),
    clock: { now: () => '2026-10-01T00:00:00Z', newId: () => `id-${++ids}` },
  })
  const request = (actionKey: string, overrides: Record<string, unknown> = {}) => ({
    negotiatedSession: 'negotiated-1',
    clientInstanceId: 'client-1',
    catalogRevision: 1,
    ownerToken: 'owner-token',
    action: { viewId: 'board', actionKey, viewRevision: 3 },
    input: inline(inputSchema, { title: 'renamed' }),
    requestId: 'request-1',
    expectedRevision: 0,
    commandSchema: inputSchema,
    ...overrides,
  })
  const submit = (actionKey: string, overrides: Record<string, unknown> = {}, principal = 'alice') =>
    commands.submit({ request: request(actionKey, overrides), context: context(principal), features: [] })
  return { store, env, commands, submit }
}

const detail = (outcome: Outcome<unknown>) => (outcome.ok ? 'ok' : outcome.error.detailCode)

describe('domain commands', () => {
  it('commits state, the event record and a succeeded handle together for a domain-commit command', async () => {
    const { store, submit } = commandHarness()
    const handle = await submit('rename')
    expect(handle).toEqual({
      ok: true,
      value: {
        commandId: 'id-1',
        requestId: 'request-1',
        revision: 1,
        completion: 'domain-commit',
        status: 'succeeded',
        result: inline(resultSchema, { ok: true }),
        error: null,
      },
    })
    expect(store.db.state.revision).toBe(1)
    expect(store.db.events).toHaveLength(1)
    const [record] = store.db.events
    expect(validateRuntime('DomainEventRecord', record).ok).toBe(true)
    expect(record).toMatchObject({
      authorityId: 'authority-1',
      sequence: 1,
      aggregate: { authorityId: 'authority-1', id: 'board-1', revision: 1 },
      event: { principalRef: 'alice', correlationId: 'trace-1', causation: { commandId: 'id-1' }, source },
    })
    expect(store.db.commands.size).toBe(1)
  })

  it('returns the original handle for the same request and refuses another meaning under the same id', async () => {
    const { store, env, submit } = commandHarness()
    const first = await submit('rename')
    expect(await submit('rename')).toEqual(first)
    // An old view no longer resolving must not stop a retry from reading its original decision.
    env.view = domainView('board', { revision: 4 })
    expect(await submit('rename')).toEqual(first)
    expect(env.prepared).toBe(1)
    expect(detail(await submit('rename', { input: inline(inputSchema, { title: 'other' }) }))).toBe(
      'idempotency_conflict',
    )
    expect(detail(await submit('rename', { expectedRevision: 1 }))).toBe('idempotency_conflict')
    expect(store.db.commands.size).toBe(1)
    // Another principal reusing the id is a separate request identity.
    env.view = domainView('board', { actions: [commandAction('rename', 'rename')] })
    expect(detail(await submit('rename', { expectedRevision: 1 }, 'bob'))).toBe('ok')
    expect(store.db.commands.size).toBe(2)
  })

  it.each([
    ['commandSchema differs from input.schema', { commandSchema: schema('acme.tasks/other@1') }, 'rename'],
    ['input.schema differs', { input: inline(schema('acme.tasks/other@1'), {}) }, 'rename'],
    ['view revision moved', { action: { viewId: 'board', actionKey: 'rename', viewRevision: 2 } }, 'rename'],
    ['action is disabled', {}, 'locked'],
    ['required feature not negotiated', {}, 'beta'],
    ['action is not a command', {}, 'form'],
    ['command is not registered', {}, 'orphan'],
    ['action is missing', {}, 'absent'],
  ])('refuses before prepare when %s', async (_name, overrides, actionKey) => {
    const { store, env, submit } = commandHarness()
    const outcome = await submit(actionKey, overrides)
    expect(outcome.ok).toBe(false)
    expect(env.prepared).toBe(0)
    expect(store.db.commands.size).toBe(0)
  })

  it('refuses a registry schema that differs from the view action schema', async () => {
    const { env, submit } = commandHarness()
    env.registryInput = schema('acme.tasks/rename-input@2')
    expect(detail(await submit('rename'))).toBe('invalid_request')
    expect(env.prepared).toBe(0)
  })

  it('applies expectedRevision as a compare-and-swap before prepare and again at commit', async () => {
    const { store, env, submit } = commandHarness()
    expect(detail(await submit('rename', { expectedRevision: 5 }))).toBe('revision_conflict')
    expect(env.prepared).toBe(0)
    env.duringPrepare = () => {
      store.db.state = { value: null, revision: 1 }
    }
    expect(detail(await submit('rename', { requestId: 'request-2' }))).toBe('revision_conflict')
    expect(store.db.commands.size).toBe(0)
    expect(store.db.events).toEqual([])
  })

  it.each([
    [
      'a start-run dispatch',
      (plan: Wire.DomainCommandPlan) => ({
        ...plan,
        dispatches: [
          { key: 'run', kind: 'start-run', presetId: 'p', presetDigest: 'a'.repeat(64), input: plan.result },
        ],
      }),
      'unsupported',
    ],
    [
      'a foreign result schema',
      (plan: Wire.DomainCommandPlan) => ({
        ...plan,
        result: inline(schema('acme.tasks/other@1'), {}),
      }),
      'invalid_request',
    ],
    [
      'a plan for another revision',
      (plan: Wire.DomainCommandPlan) => ({ ...plan, expectedRevision: 9 }),
      'revision_conflict',
    ],
    [
      'an event whose payload schema disagrees',
      (plan: Wire.DomainCommandPlan) => ({
        ...plan,
        events: [{ ...plan.events[0], payload: inline(signalSchema, {}) }],
      }),
      'invalid_request',
    ],
    [
      'repeated dispatch keys',
      (plan: Wire.DomainCommandPlan) => ({ ...plan, dispatches: [signal, signal] }),
      'invalid_request',
    ],
  ])('refuses %s without writing anything', async (_name, override, code) => {
    const { store, env, submit } = commandHarness()
    env.planOverride = override
    expect(detail(await submit('rename'))).toBe(code)
    expect(store.db.state.revision).toBe(0)
    expect(store.db.commands.size + store.db.events.length + store.db.dispatches.length).toBe(0)
  })

  it('rolls the whole commit back when one write fails', async () => {
    const { store, submit } = commandHarness()
    store.faults.failPutCommand = true
    expect(detail(await submit('launch'))).toBe('backend_unavailable')
    expect(store.db.state.revision).toBe(0)
    expect(store.db.events.length + store.db.dispatches.length).toBe(0)
  })

  it('keeps runtime-accepted running until every dispatch is acked, without preparing again', async () => {
    const { store, env, commands, submit } = commandHarness()
    const running = await submit('launch')
    expect(running).toMatchObject({
      ok: true,
      value: { completion: 'runtime-accepted', status: 'running', revision: 1 },
    })
    const [row] = store.db.dispatches
    expect(row?.row).toMatchObject({
      key: 'wake',
      destination: 'runtime-inbox',
      event: { typeId: signalSchema.typeId },
    })
    expect(validateRuntime('DomainEvent', row?.row.event).ok).toBe(true)
    // The ack was lost: a retry and a status read both stay running and never re-run prepare.
    expect(await submit('launch')).toEqual(running)
    expect(await commands.commandStatus('request-1', context())).toEqual(running)
    expect(env.prepared).toBe(1)

    const inbox = createRuntimeInboxFixture()
    const { deliveryId } = inbox.notify(row?.row.event.eventId ?? '')
    const runtimeRef: Wire.PublicRef = {
      kind: 'event',
      authorityId: RUNTIME_INBOX_FIXTURE,
      eventId: deliveryId,
    }
    // The outbox records the ack on the live row; earlier reads copied the table.
    const live = store.db.dispatches[0]
    if (live) live.ack = { deliveryId, runtimeRef }
    const done = await commands.commandStatus('request-1', context())
    expect(done).toMatchObject({
      ok: true,
      value: { status: 'succeeded', revision: 2, completion: 'runtime-accepted' },
    })
    if (!done.ok || done.value.status !== 'succeeded' || done.value.result?.kind !== 'inline')
      throw new Error('no result')
    expect(done.value.result.schema).toEqual(RuntimeSchemaRefs.CommandRuntimeAcceptanceResult)
    expect(done.value.result.value).toEqual({
      value: inline(resultSchema, { ok: true }),
      deliveries: [{ deliveryId, runtimeRef }],
    })
    expect(env.prepared).toBe(1)
  })

  it('succeeds a runtime-accepted command with no dispatch at commit with empty deliveries', async () => {
    const { submit } = commandHarness()
    const handle = await submit('ping')
    if (!handle.ok || handle.value.status !== 'succeeded' || handle.value.result?.kind !== 'inline')
      throw new Error('no result')
    expect(handle.value.result.value).toEqual({ value: inline(resultSchema, { ok: true }), deliveries: [] })
  })

  it('answers not-accepted only when the store proves the request was never accepted', async () => {
    const { store, env, commands, submit } = commandHarness()
    expect(await commands.commandStatus('missing', context())).toEqual({
      ok: true,
      value: {
        requestId: 'missing',
        status: 'not-accepted',
        commandId: null,
        revision: null,
        completion: null,
        result: null,
        error: null,
      },
    })
    await submit('rename')
    // Another principal's identical request id is not this caller's command.
    expect(await commands.commandStatus('request-1', context('bob'))).toMatchObject({
      value: { status: 'not-accepted' },
    })
    store.faults.unavailable = true
    expect(detail(await commands.commandStatus('request-1', context()))).toBe('backend_unavailable')
    store.faults.unavailable = false
    env.readable = false
    expect(detail(await commands.commandStatus('request-1', context()))).toBe('permission_denied')
    expect(detail(await submit('rename'))).toBe('permission_denied')
  })
})

function projectionHarness() {
  const env = {
    calls: [] as string[],
    grant: { ok: true, value: { readerId: 'reader-1', role: 'viewer' } } as Outcome<ReaderGrant>,
    revision: 1,
    views: [domainView('a'), domainView('b')],
    delta: { ok: true, value: { kind: 'reset' } } as Outcome<ProjectionDelta>,
    hidden: new Set<string>(),
    stateSchema: readStateSchema,
  }
  const ports: DomainProjectionPorts = {
    domainType: 'acme.tasks',
    readStateSchema,
    viewSchema,
    async authorize() {
      env.calls.push('authorize')
      return env.grant
    },
    async readState() {
      env.calls.push('readState')
      return {
        ok: true,
        value: {
          state: inline(env.stateSchema, { revision: env.revision }),
          projectionRevision: env.revision,
        },
      }
    },
    async select() {
      env.calls.push('select')
      return { ok: true, value: { items: env.views, pageState: null, complete: true } }
    },
    async changes(_query, after) {
      env.calls.push(`changes:${after}`)
      return env.delta
    },
    async canReadResource(resource) {
      env.calls.push('resource')
      return !env.hidden.has(resource.artifactId)
    },
  }
  return { env, ports, projection: createDomainProjection(ports) }
}

const query = (overrides: Record<string, unknown> = {}) => ({
  domainType: 'acme.tasks',
  query: inline(querySchema, { open: true }),
  scope: sessionScope,
  cursor: null,
  limit: 1,
  ...overrides,
})
const reserved = (artifactId: string) =>
  ({
    artifactId,
    version: 1,
    title: artifactId,
    mime: null,
    size: null,
    status: 'reserved',
  }) as Wire.ArtifactViewRef

async function firstPage(projection: ReturnType<typeof createDomainProjection>, overrides = {}) {
  const page = await projection.snapshot(query(overrides), context())
  if (!page.ok) throw new Error(page.error.message)
  return page.value
}

describe('authorized domain projection', () => {
  it('reads in policy, state, selector, recheck order and pages under owner-issued cursors', async () => {
    const { env, projection } = projectionHarness()
    env.views = [domainView('a', { resources: [reserved('art-a')] }), domainView('b')]
    const first = await firstPage(projection)
    expect(env.calls).toEqual(['authorize', 'readState', 'select', 'resource'])
    expect(first.items.map((view) => view.viewId)).toEqual(['a'])
    expect(first.complete).toBe(false)
    const second = await firstPage(projection, { cursor: first.nextPageCursor })
    expect(second.items.map((view) => view.viewId)).toEqual(['b'])
    expect(second).toMatchObject({ complete: true, nextPageCursor: null, projectionRevision: 1 })
  })

  it.each([
    [
      'state uses another schema',
      (env: ReturnType<typeof projectionHarness>['env']) => {
        env.stateSchema = schema('acme.tasks/other@1')
      },
    ],
    [
      'selector returns another domain schema',
      (env: ReturnType<typeof projectionHarness>['env']) => {
        env.views = [domainView('a', { viewSchema: schema('acme.tasks/other@1') })]
      },
    ],
  ])('fails closed when the %s', async (_name, arrange) => {
    const { env, projection } = projectionHarness()
    arrange(env)
    expect(detail(await projection.snapshot(query(), context()))).toBe('integrity')
  })

  it('refuses to swap page and delta cursors', async () => {
    const { projection } = projectionHarness()
    const page = await firstPage(projection)
    expect(detail(await projection.snapshot(query({ cursor: page.cursor }), context()))).toBe(
      'invalid_request',
    )
    const swapped = { query: query(), afterCursor: page.nextPageCursor, limit: 1 }
    expect(detail(await projection.changes(swapped, context()))).toBe('invalid_request')
  })

  it.each([
    [
      'a page cursor in query.cursor',
      (cursor: string) => ({ query: query({ cursor }), afterCursor: cursor, limit: 1 }),
    ],
    [
      'a query limit that differs',
      (cursor: string) => ({ query: query({ limit: 2 }), afterCursor: cursor, limit: 1 }),
    ],
    [
      'a cursor bound to another page size',
      (cursor: string) => ({ query: query({ limit: 2 }), afterCursor: cursor, limit: 2 }),
    ],
    [
      'a cursor bound to another query',
      (cursor: string) => ({
        query: query({ query: inline(querySchema, { open: false }) }),
        afterCursor: cursor,
        limit: 1,
      }),
    ],
  ])('changes refuses %s', async (_name, build) => {
    const { projection } = projectionHarness()
    const page = await firstPage(projection)
    expect(detail(await projection.changes(build(page.cursor), context()))).toBe('invalid_request')
  })

  it('returns an empty delta at the same revision and authorized changes after it', async () => {
    const { env, projection } = projectionHarness()
    const page = await firstPage(projection)
    const request = { query: query(), afterCursor: page.cursor, limit: 1 }
    expect(await projection.changes(request, context())).toEqual({
      ok: true,
      value: { changes: [], cursor: page.cursor, hasMore: false },
    })
    env.revision = 2
    env.hidden.add('art-c')
    env.delta = {
      ok: true,
      value: {
        kind: 'changes',
        projectionRevision: 2,
        hasMore: false,
        changes: [
          { kind: 'upsert', view: domainView('b', { revision: 4 }) },
          { kind: 'upsert', view: domainView('c', { revision: 5, resources: [reserved('art-c')] }) },
        ],
      },
    }
    const changed = await projection.changes(request, context())
    if (!changed.ok) throw new Error(changed.error.message)
    expect(env.calls).toContain('changes:1')
    expect(changed.value.changes).toEqual([
      { kind: 'upsert', view: domainView('b', { revision: 4 }) },
      { kind: 'remove', viewId: 'c', revision: 5, reason: 'hidden' },
    ])
    expect(JSON.stringify(changed.value)).not.toContain('card c')
    // The returned cursor continues from revision 2.
    expect(
      await projection.changes({ ...request, afterCursor: changed.value.cursor }, context()),
    ).toMatchObject({
      ok: true,
      value: { changes: [] },
    })
  })

  it('sends a reset as the only change of its batch, with the snapshot cursor', async () => {
    const { env, projection } = projectionHarness()
    const page = await firstPage(projection)
    env.revision = 3
    const reset = await projection.changes({ query: query(), afterCursor: page.cursor, limit: 1 }, context())
    if (!reset.ok) throw new Error(reset.error.message)
    const [change] = reset.value.changes
    expect(reset.value.changes).toHaveLength(1)
    expect(reset.value.hasMore).toBe(false)
    if (change?.kind !== 'reset') throw new Error('expected a reset')
    expect(reset.value.cursor).toBe(change.snapshot.cursor)
    expect(change.snapshot.projectionRevision).toBe(3)
  })

  it.each([
    [
      'the process restarted',
      async (h: ReturnType<typeof projectionHarness>) => createDomainProjection(h.ports),
    ],
    [
      'reader access was revoked',
      async (h: ReturnType<typeof projectionHarness>) => {
        h.env.grant = fail('permission_denied', 'revoked')
        return h.projection
      },
    ],
    [
      'the reader scope narrowed',
      async (h: ReturnType<typeof projectionHarness>) => {
        h.env.grant = { ok: true, value: { readerId: 'reader-1-narrowed', role: 'viewer' } }
        return h.projection
      },
    ],
    [
      'the history has a gap',
      async (h: ReturnType<typeof projectionHarness>) => {
        h.env.revision = 9
        h.env.delta = fail('resync_required', 'revision 1 is no longer retained')
        return h.projection
      },
    ],
    [
      'the projection went backwards',
      async (h: ReturnType<typeof projectionHarness>) => {
        h.env.revision = 0
        return h.projection
      },
    ],
  ])('asks for resync when %s', async (_name, arrange) => {
    const h = projectionHarness()
    const page = await firstPage(h.projection)
    const projection = await arrange(h)
    const outcome = await projection.changes(
      { query: query(), afterCursor: page.cursor, limit: 1 },
      context(),
    )
    expect(outcome).toMatchObject({ ok: false, error: { code: 'conflict', detailCode: 'resync_required' } })
  })

  it('asks for resync when the projection moves between snapshot pages', async () => {
    const { env, projection } = projectionHarness()
    const first = await firstPage(projection)
    env.revision = 2
    expect(detail(await projection.snapshot(query({ cursor: first.nextPageCursor }), context()))).toBe(
      'resync_required',
    )
  })
})

/** The shared suite lives outside this package's build, so it is loaded by URL. Only what is used is typed. */
type SuiteFixture = {
  domain: ProjectionDomain & { commandStateSchema: Wire.SchemaRef }
  gate: ProjectionAccess
  native: NativeConversation
  turnOf(event: Wire.DomainEvent): string | null
}
type ProjectionSuite = {
  createProjectionFixture(): SuiteFixture & { prepared(): number }
  domainEvent(
    eventId: string,
    type: string,
    sessionId: string,
    payload: Record<string, string>,
  ): Wire.DomainEvent
  callContext(): CallContext
  listQuery(sessionId: string, limit: number, cursor?: string | null): Wire.DomainQuery
  renameRequest(viewId: string, viewRevision: number, requestId: string, expectedRevision: number): unknown
}
const loadSuite = async () =>
  (await import(
    new URL('../../../extension-api/testkit/runtime/contracts/projection.ts', import.meta.url).href
  )) as ProjectionSuite

const NO_READS = {
  query: async () => fail('unsupported', 'no selector reads in this test'),
  resolveData: async () => fail('unsupported', 'no selector reads in this test'),
}
const PROJECTION_BINDING = {
  bindingId: 'default-projection',
  contract: 'agh.projection',
  logicalName: 'tasks',
  providerId: 'default',
}

/** The default provider over the copy-on-write store, which outlives every provider instance. */
function defaultProjection(fixture: SuiteFixture, retainedRevisions?: number) {
  const store = memoryStore()
  let ids = 0
  const open = () =>
    createProjectionProvider({
      binding: PROJECTION_BINDING,
      reads: NO_READS,
      domain: fixture.domain,
      access: fixture.gate,
      native: fixture.native,
      turnOf: fixture.turnOf,
      journal: async (after, limit) =>
        store.db.events.filter((record) => record.sequence > after).slice(0, limit),
      owner: {
        namespace: 'conformance.tasks',
        authorityId: 'conformance-authority',
        aggregate: { typeId: 'conformance.tasks/board@1', id: 'board' },
        source: PROJECTION_BINDING,
        stateSchema: fixture.domain.commandStateSchema,
        destination: 'runtime-inbox',
        storage: store.storage,
        clock: { now: () => '2026-10-01T00:00:00Z', newId: () => `default-${++ids}` },
      },
      ...(retainedRevisions === undefined ? {} : { retainedRevisions }),
    })
  let current = open()
  const binding: TestServiceBinding = {
    requirement: {
      contract: 'agh.projection',
      major: 1,
      logicalName: 'tasks',
      features: [],
      scope: 'workspace',
      optional: false,
    },
    binding: PROJECTION_BINDING,
    query: (request, context) => current.query(request, context),
  }
  return {
    store,
    binding,
    service: () => current,
    async append(events: readonly Wire.DomainEvent[]) {
      await store.storage.transaction((tx) => {
        for (const event of events) {
          const sequence = tx.lastSequence() + 1
          tx.putEvent({
            event,
            authorityId: 'conformance-authority',
            sequence,
            aggregate: {
              authorityId: 'conformance-authority',
              typeId: 'conformance.tasks/board@1',
              id: 'board',
              revision: sequence,
            },
            fingerprint: canonicalJsonDigest(event.eventId),
          })
        }
      })
      await current.refresh()
    },
    async reopen() {
      current.close()
      current = open()
    },
  }
}

describe('default projection provider', () => {
  async function provider(retainedRevisions?: number) {
    const suite = await loadSuite()
    const fixture = suite.createProjectionFixture()
    const subject = defaultProjection(fixture, retainedRevisions)
    let n = 0
    const add = (taskId: string, type = 'added', board = 'open') =>
      suite.domainEvent(`unit-${++n}`, type, 'unit', { taskId, board, title: taskId })
    const read = async (limit = 10) => {
      const page = await subject.service().snapshot(suite.listQuery('unit', limit), suite.callContext())
      if (!page.ok) throw new Error(page.error.detailCode)
      return page.value
    }
    return { suite, fixture, subject, add, read }
  }

  it('applies only the reader policy rules, then the read state schema check', async () => {
    const { suite, fixture } = await provider()
    const domain = (rules: ProjectionDomain['readerPolicy']['rules']) => ({
      ...fixture.domain,
      readerPolicy: { capability: fixture.domain.readerPolicy.capability, rules },
    })
    const bad =
      (pointer: string, resourcePointer = '') =>
      () =>
        defaultProjection({ ...fixture, domain: domain([{ pointer, resourcePointer, operation: 'read' }]) })
    expect(bad('/tasks/*x/title')).toThrow('not supported')
    expect(bad('tasks/0')).toThrow('not supported')
    expect(bad('/tasks/0/title', '/tasks/*/board')).toThrow('only bind array elements')
    const whole = defaultProjection({
      ...fixture,
      domain: domain([{ pointer: '', resourcePointer: '/tasks/0/board', operation: 'read' }]),
    })
    await whole.append([
      suite.domainEvent('w-1', 'added', 'unit', { taskId: 'w', board: 'open', title: 'w' }),
    ])
    // The whole private state carries fields the read state schema does not allow.
    const refused = await whole.service().snapshot(suite.listQuery('unit', 10), suite.callContext())
    expect(detail(refused)).toBe('integrity')
    const none = defaultProjection({ ...fixture, domain: domain([]) })
    await none.append([suite.domainEvent('n-1', 'added', 'unit', { taskId: 'n', board: 'open', title: 'n' })])
    const empty = await none.service().snapshot(suite.listQuery('unit', 10), suite.callContext())
    expect(empty).toMatchObject({ ok: true, value: { items: [] } })
  })

  it('folds a journal in sequence order, waits at a gap and ignores a repeated record', async () => {
    const { subject, add, read } = await provider()
    await subject.append([add('a'), add('b'), add('c')])
    const [first, second, third] = subject.store.db.events.splice(0)
    if (!first || !second || !third) throw new Error('three records')
    subject.store.db.events.push(first, third)
    await subject.reopen()
    expect((await read()).items.map((view) => view.viewId)).toEqual(['a'])
    // The record that filled the gap arrives twice; the repeat must not stop the fold.
    subject.store.db.events.splice(1, 0, second, second)
    const caught = await read()
    expect(caught.items.map((view) => view.viewId)).toEqual(['a', 'b', 'c'])
    expect(caught.projectionRevision).toBe(3)
  })

  it('stops before an event the reducer refuses, without passing it on a later read or a restart', async () => {
    const { subject, add, read } = await provider()
    await subject.append([add('a'), add('a', 'broken'), add('b')])
    expect(await subject.service().refresh()).toMatchObject({ detailCode: 'invalid_request' })
    expect((await read()).items.map((view) => view.viewId)).toEqual(['a'])
    await subject.reopen()
    expect((await read()).projectionRevision).toBe(1)
  })

  it('answers resync for a revision no longer kept and reset for a delta larger than its page', async () => {
    const { suite, subject, add, read } = await provider(2)
    await subject.append([add('a')])
    const old = await read(1)
    await subject.append([add('b'), add('c'), add('d')])
    const stale = await subject
      .service()
      .changes({ query: suite.listQuery('unit', 1), afterCursor: old.cursor, limit: 1 }, suite.callContext())
    expect(detail(stale)).toBe('resync_required')
    const recent = await read(1)
    await subject.append([add('e'), add('f')])
    const reset = await subject
      .service()
      .changes(
        { query: suite.listQuery('unit', 1), afterCursor: recent.cursor, limit: 1 },
        suite.callContext(),
      )
    if (!reset.ok) throw new Error(reset.error.detailCode)
    expect(reset.value.changes.map((change) => change.kind)).toEqual(['reset'])
    expect(reset.value.hasMore).toBe(false)
  })

  it('serves command and acceptCommand from one journal', async () => {
    const { suite, fixture, subject, add, read } = await provider()
    await subject.append([add('a')])
    const request = suite.renameRequest('a', (await read()).items[0]?.revision ?? 0, 'unit-rename', 0)
    const command = await subject.service().command(request, suite.callContext())
    expect(command).toMatchObject({ ok: true, value: { status: 'succeeded', completion: 'domain-commit' } })
    expect(await subject.service().acceptCommand(request, suite.callContext())).toEqual(command)
    expect(fixture.prepared()).toBe(1)
    expect((await read()).items[0]?.data).toEqual({ title: 'a renamed' })
  })

  it('answers queries only with the method schemas and leaves listing unsupported', async () => {
    const { suite, subject } = await provider()
    const refs = RuntimeMethodSchemaRefs['agh.projection']
    const ask = (method: string, schema: Wire.SchemaRef, value: Wire.JsonValue) =>
      subject.binding.query?.(
        { target: PROJECTION_BINDING, method, input: inline(schema, value) },
        suite.callContext(),
      ) ?? Promise.reject(new Error('no query entry'))
    const listing = {
      scope: {
        kind: 'workspace',
        installationId: 'conformance',
        runtimeId: 'conformance',
        workspaceId: 'conformance',
      },
      text: null,
      cursor: null,
      limit: 10,
    }
    expect(detail(await ask('command', refs.command.input, {}))).toBe('operation_not_supported')
    expect(detail(await ask('snapshot', refs.changes.input, suite.listQuery('unit', 1)))).toBe(
      'invalid_request',
    )
    expect(detail(await ask('listConversations', refs.listConversations.input, listing))).toBe('unsupported')
    expect(await ask('snapshot', refs.snapshot.input, suite.listQuery('unit', 1))).toMatchObject({
      ok: true,
      value: { kind: 'value', output: { schema: refs.snapshot.output } },
    })
  })
})

describe('default projection provider: reader policy paths', () => {
  it('copies a __proto__ key as plain data and never onto a prototype', async () => {
    const suite = await loadSuite()
    const fixture = suite.createProjectionFixture()
    const state = JSON.parse('{"__proto__":{"polluted":"yes"},"ok":"open"}') as Wire.JsonValue
    const subject = defaultProjection({
      ...fixture,
      domain: {
        ...fixture.domain,
        readerPolicy: {
          capability: fixture.domain.readerPolicy.capability,
          rules: [{ pointer: '/__proto__/polluted', resourcePointer: '/ok', operation: 'read' }],
        },
        reducer: { reduce: () => ({ ok: true, value: inline(fixture.domain.stateSchema, state) }) },
        selector: {
          async selectAuthorized(input) {
            expect(input.state.kind === 'inline' && Object.getPrototypeOf(input.state.value)).toBe(
              Object.prototype,
            )
            expect(JSON.stringify(input.state.kind === 'inline' ? input.state.value : null)).toBe(
              '{"__proto__":{"polluted":"yes"}}',
            )
            return { ok: true, value: { items: [], pageState: null, complete: true } }
          },
        },
        checkReadState: () => true,
      },
    })
    await subject.append([
      suite.domainEvent('p-1', 'added', 'unit', { taskId: 'p', board: 'open', title: 'p' }),
    ])
    expect(await subject.service().snapshot(suite.listQuery('unit', 1), suite.callContext())).toMatchObject({
      ok: true,
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
