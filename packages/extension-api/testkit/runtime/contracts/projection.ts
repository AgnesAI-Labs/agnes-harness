import type {
  CallContext,
  DomainCommandHandler,
  DomainReducer,
  DomainSelector,
  Outcome,
} from '@agnes/extension-api/runtime'
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

const CONTRACT = 'agh.projection'
const HEX = /^[a-f0-9]{64}$/
export const TASKS_DOMAIN = 'conformance.tasks/task@1'
export const TASKS_CAPABILITY = 'conformance.tasks.read'

const schemaRef = (typeId: string): Wire.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest(typeId),
})
export const TASKS_SCHEMAS = {
  state: schemaRef('conformance.tasks/state@1'),
  readState: schemaRef('conformance.tasks/read-state@1'),
  query: schemaRef('conformance.tasks/query@1'),
  view: schemaRef('conformance.tasks/card@1'),
  commandState: schemaRef('conformance.tasks/command-state@1'),
  renameInput: schemaRef('conformance.tasks/rename-input@1'),
  renameResult: schemaRef('conformance.tasks/rename-result@1'),
} as const
const EVENT_TYPES = ['added', 'progressed', 'settled', 'renamed', 'removed', 'broken'] as const
export type EventType = (typeof EVENT_TYPES)[number] | 'noise'
const typeId = (type: EventType) => `conformance.tasks/${type}@1`

export const inline = (schema: Wire.SchemaRef, value: Wire.JsonValue): Wire.DataRef => ({
  kind: 'inline',
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(jcs(value)).length,
})

const refusal = (detail: keyof typeof RuntimeErrorDetails, message: string): Outcome<never> => ({
  ok: false,
  error: {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'projection-conformance',
  },
})

export const WORKSPACE = {
  kind: 'workspace',
  installationId: 'conformance',
  runtimeId: 'conformance',
  workspaceId: 'conformance',
} as const
export const sessionScope = (sessionId: string): Extract<Wire.ScopeRef, { kind: 'session' }> => ({
  ...WORKSPACE,
  kind: 'session',
  sessionId,
})
export const READER = {
  principalRef: 'projection-reader',
  authorizationRef: 'projection-reader-authorization',
}

export function callContext(principalRef = READER.principalRef, aborted = false): CallContext {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return {
    principalRef,
    scope: WORKSPACE,
    bindingId: 'conformance-binding',
    invocationId: 'conformance-invocation',
    deadline: '2100-01-01T00:00:00.000Z',
    traceRef: 'conformance-trace',
    authorizationRef: READER.authorizationRef,
    signal: controller.signal,
  }
}

/** The Host checks a binding wires into its provider. Every change moves the reader's grant on. */
export interface ProjectionGate {
  grant(
    capability: string,
    scope: Wire.ScopeRef,
    context: CallContext,
  ): Promise<Outcome<{ readerId: string; role: string }>>
  allows(operation: string, resource: Wire.JsonValue, context: CallContext): Promise<boolean>
  canReadResource(resource: Wire.ArtifactViewRef, context: CallContext): Promise<boolean>
  revokeReader(principalRef: string): void
  restoreReader(principalRef: string): void
  closeBoard(board: string): void
  hideArtifact(artifactId: string): void
}

function createGate(): ProjectionGate {
  let revision = 0
  const revoked = new Set<string>()
  const closed = new Set<string>(['vault'])
  const hidden = new Set<string>()
  const change = (apply: () => void) => {
    apply()
    revision++
  }
  return {
    async grant(capability, _scope, context) {
      return capability === TASKS_CAPABILITY &&
        context.authorizationRef === READER.authorizationRef &&
        !revoked.has(context.principalRef)
        ? { ok: true, value: { readerId: `${context.principalRef}#${revision}`, role: 'reader' } }
        : refusal('permission_denied', 'reader may not read tasks')
    },
    allows: async (operation, resource) =>
      operation === 'read' && typeof resource === 'string' && !closed.has(resource),
    canReadResource: async (resource) => !hidden.has(resource.artifactId),
    revokeReader: (principal) => change(() => revoked.add(principal)),
    restoreReader: (principal) => change(() => revoked.delete(principal)),
    closeBoard: (board) => change(() => closed.add(board)),
    hideArtifact: (artifactId) => change(() => hidden.add(artifactId)),
  }
}

/** A native conversation as the existing protocol serves it: assistant nodes, one turn, history paging. */
export interface NativeConversationFixture {
  head(sessionId: string): { generation: number; upto: number }
  page(
    sessionId: string,
    beforeIndex: number | null,
    limit: number,
    context: CallContext,
  ): Promise<Outcome<Wire.UIOpeningResult>>
  say(sessionId: string, count: number): void
  /** Invalidates the native history, as a rewritten ledger does. */
  regenerate(sessionId: string): void
  ids(sessionId: string): string[]
}

function createNative(): NativeConversationFixture {
  const sessions = new Map<string, { generation: number; nodes: Wire.UIOpeningResult['timeline']['nodes'] }>()
  const of = (sessionId: string) => {
    const found = sessions.get(sessionId) ?? { generation: 1, nodes: [] }
    sessions.set(sessionId, found)
    return found
  }
  const upto = (sessionId: string) => of(sessionId).nodes.length
  return {
    head: (sessionId) => ({ generation: of(sessionId).generation, upto: upto(sessionId) }),
    async page(sessionId, beforeIndex, limit) {
      if (!Number.isInteger(limit) || limit < 0) return refusal('invalid_request', 'bad native page size')
      const { generation, nodes } = of(sessionId)
      const end = Math.min(beforeIndex ?? nodes.length, nodes.length)
      const start = Math.max(0, end - limit)
      const page = nodes.slice(start, end)
      const turnNodes = nodes.slice(0, 2).map((node) => node.id)
      const turns = page.some((node) => turnNodes.includes(node.id))
        ? [
            {
              id: `${sessionId}-turn-1`,
              turn: 1,
              startSeq: 1,
              startedAt: '2026-10-01T00:00:00.000Z',
              status: 'completed' as const,
              nodeIds: turnNodes,
              usage: {
                totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
                reasoningComplete: true,
                billingComplete: true,
                calls: [],
              },
              inherited: false,
              forkable: true,
            },
          ]
        : []
      const totalNodes = nodes.length
      return {
        ok: true,
        value: {
          timeline: { sessionId, upto: upto(sessionId), generation, opState: null, nodes: page, turns },
          history:
            start > 0
              ? { hasEarlier: true, cursor: `native-${generation}-${start}`, startIndex: start, totalNodes }
              : { hasEarlier: false, startIndex: start, totalNodes },
        },
      }
    },
    say(sessionId, count) {
      const { nodes } = of(sessionId)
      for (let index = 0; index < count; index++) {
        const seq = nodes.length + 1
        nodes.push({ kind: 'assistant', id: `${sessionId}-n${seq}`, seq, text: `reply ${seq}` })
      }
    },
    regenerate(sessionId) {
      of(sessionId).generation++
    },
    ids: (sessionId) => of(sessionId).nodes.map((node) => node.id),
  }
}

type Task = {
  taskId: string
  board: string
  title: string
  privateNote: string
  artifact: string | null
  phase: Wire.DomainView['phase']
  stream: { streamId: string; generation: number; revision: number }
  revision: number
  scope: Wire.JsonValue
  eventIds: string[]
}

const READ_FIELDS = ['taskId', 'title', 'artifact', 'phase', 'stream', 'revision', 'scope', 'eventIds']

const reducer: DomainReducer = {
  reduce({ state, event }) {
    const tasks = state?.kind === 'inline' ? ((state.value as { tasks: Task[] }).tasks ?? []) : []
    const input = (event.payload.kind === 'inline' ? event.payload.value : {}) as Record<string, string>
    const id = input.taskId ?? ''
    // A session event names the task of its session; a wider one, such as a command's, the id anywhere.
    const session = event.scope.kind === 'session' ? event.scope.sessionId : null
    const named = (task: Task) =>
      task.taskId === id && (session === null || (task.scope as { sessionId?: string }).sessionId === session)
    const touch = (task: Task, change: Partial<Task>): Task => {
      const ids = [...task.eventIds, event.eventId]
      return {
        ...task,
        ...change,
        revision: task.revision + 1,
        eventIds: ids.length > 8 ? [ids[0] ?? '', ...ids.slice(-7)] : ids,
      }
    }
    const each = (change: (task: Task) => Partial<Task>) =>
      tasks.map((task) => (named(task) ? touch(task, change(task)) : task))
    let next = tasks
    if (event.typeId === typeId('broken')) return refusal('invalid_request', 'this event cannot be folded')
    if (event.typeId === typeId('added') && !tasks.some(named))
      next = [
        ...tasks,
        {
          taskId: id,
          board: input.board ?? '',
          title: input.title ?? '',
          privateNote: `private-${id}`,
          artifact: input.artifact ?? null,
          phase: 'provisional',
          stream: { streamId: id, generation: 1, revision: 1 },
          revision: 1,
          scope: event.scope as Wire.JsonValue,
          eventIds: [event.eventId],
        },
      ]
    if (event.typeId === typeId('progressed'))
      next = each((task) => ({ stream: { ...task.stream, revision: task.stream.revision + 1 } }))
    if (event.typeId === typeId('settled')) next = each(() => ({ phase: input.phase as Task['phase'] }))
    if (event.typeId === typeId('renamed')) next = each(() => ({ title: input.title ?? '' }))
    if (event.typeId === typeId('removed')) next = tasks.filter((task) => !named(task))
    return { ok: true, value: inline(TASKS_SCHEMAS.state, { tasks: next } as unknown as Wire.JsonValue) }
  },
}

const action = (actionKey: string, enabled: boolean): Wire.ViewAction => ({
  actionKey,
  label: actionKey,
  requiredFeatures: [],
  availability: enabled ? 'enabled' : 'disabled',
  disabledReason: enabled ? null : 'archiving is closed',
  kind: 'command',
  command: 'rename',
  inputSchema: TASKS_SCHEMAS.renameInput,
})

const selector: DomainSelector = {
  async selectAuthorized(input) {
    if (input.state.kind !== 'inline' || jcs(input.state.schema) !== jcs(TASKS_SCHEMAS.readState))
      return refusal('integrity', 'selector reads the read state only')
    const tasks = ((input.state.value as { tasks?: Partial<Task>[] }).tasks ?? []).filter(
      (task): task is Task => typeof task.taskId === 'string',
    )
    const items = tasks.map(
      (task): Wire.DomainView => ({
        kind: 'domain',
        viewId: task.taskId,
        revision: task.revision,
        domainType: TASKS_DOMAIN,
        viewSchema: TASKS_SCHEMAS.view,
        renderKey: 'conformance.tasks/card',
        scope: task.scope as Wire.DomainView['scope'],
        source: { eventIds: task.eventIds, projectionRevision: input.projectionRevision },
        phase: task.phase,
        stream: task.stream,
        fallbackText: `Task ${task.title} (${task.phase})`,
        data: { title: task.title },
        resources: task.artifact
          ? [
              {
                artifactId: task.artifact,
                version: 1,
                title: task.title,
                mime: null,
                size: null,
                status: 'reserved',
              },
            ]
          : [],
        actions: [action('rename', true), action('archive', false)],
      }),
    )
    return { ok: true, value: { items, pageState: null, complete: true } }
  },
}

/** The domain, Host checks and native conversation a binding wires into its provider. */
export interface ProjectionFixture {
  readonly domain: Readonly<{
    domainType: string
    stateSchema: Wire.SchemaRef
    readStateSchema: Wire.SchemaRef
    viewSchema: Wire.SchemaRef
    commandStateSchema: Wire.SchemaRef
    onCommittedTypes: readonly string[]
    readerPolicy: {
      capability: string
      rules: { pointer: string; resourcePointer: string; operation: string }[]
    }
    reducer: DomainReducer
    selector: DomainSelector
    checkReadState(value: Wire.JsonValue): boolean
    listQuery: Wire.DataRef
    commands: ReadonlyMap<
      string,
      Readonly<{
        inputSchema: Wire.SchemaRef
        resultSchema: Wire.SchemaRef
        completion: 'domain-commit'
        handler: DomainCommandHandler
      }>
    >
  }>
  readonly gate: ProjectionGate
  readonly native: NativeConversationFixture
  /** The native turn evidence for an event: its run names the session's first turn. */
  turnOf(event: Wire.DomainEvent): string | null
  /** Prepare runs so far, which is also the command state revision. */
  prepared(): number
}

export function createProjectionFixture(): ProjectionFixture {
  let prepared = 0
  const handler: DomainCommandHandler = {
    async prepare(frame) {
      prepared++
      const title =
        frame.input.kind === 'inline' ? (frame.input.value as { title?: string }).title : undefined
      const renames =
        frame.state?.kind === 'inline' ? ((frame.state.value as { renames?: number }).renames ?? 0) : 0
      const renamed = schemaRef(typeId('renamed'))
      return {
        ok: true,
        value: {
          expectedRevision: frame.stateRevision,
          state: inline(TASKS_SCHEMAS.commandState, { renames: renames + 1 }),
          events: [
            {
              typeId: typeId('renamed'),
              schema: renamed,
              payload: inline(renamed, { taskId: frame.sourceView.viewId, title: title ?? '' }),
              idempotencyKey: `${frame.requestId}/renamed`,
            },
          ],
          dispatches: [],
          result: inline(TASKS_SCHEMAS.renameResult, { taskId: frame.sourceView.viewId }),
        },
      }
    },
  }
  return {
    domain: {
      domainType: TASKS_DOMAIN,
      stateSchema: TASKS_SCHEMAS.state,
      readStateSchema: TASKS_SCHEMAS.readState,
      viewSchema: TASKS_SCHEMAS.view,
      commandStateSchema: TASKS_SCHEMAS.commandState,
      onCommittedTypes: EVENT_TYPES.map(typeId),
      readerPolicy: {
        capability: TASKS_CAPABILITY,
        rules: READ_FIELDS.map((field) => ({
          pointer: `/tasks/*/${field}`,
          resourcePointer: '/tasks/*/board',
          operation: 'read',
        })),
      },
      reducer,
      selector,
      checkReadState: (value) => {
        const tasks = (value as { tasks?: unknown }).tasks ?? []
        return (
          Array.isArray(tasks) &&
          Object.keys(value as object).every((key) => key === 'tasks') &&
          tasks.every((task) => Object.keys(task as object).every((key) => READ_FIELDS.includes(key)))
        )
      },
      listQuery: inline(TASKS_SCHEMAS.query, { all: true }),
      commands: new Map([
        [
          'rename',
          {
            inputSchema: TASKS_SCHEMAS.renameInput,
            resultSchema: TASKS_SCHEMAS.renameResult,
            completion: 'domain-commit',
            handler,
          },
        ],
      ]),
    },
    gate: createGate(),
    native: createNative(),
    turnOf: (event) =>
      event.scope.kind === 'session' && event.causation.runId === 'run-1'
        ? `${event.scope.sessionId}-turn-1`
        : null,
    prepared: () => prepared,
  }
}

const SOURCE: Wire.BindingRef = {
  bindingId: 'conformance-author',
  contract: CONTRACT,
  logicalName: 'tasks',
  providerId: 'conformance-author',
}

/** One event of the fixture domain, scoped to a session. */
export function domainEvent(
  eventId: string,
  type: EventType,
  sessionId: string,
  payload: Record<string, string>,
  runId?: string,
): Wire.DomainEvent {
  const schema = schemaRef(typeId(type))
  return {
    eventId,
    typeId: typeId(type),
    schema,
    source: SOURCE,
    scope: sessionScope(sessionId),
    occurredAt: '2026-10-01T00:00:00.000Z',
    payload: inline(schema, payload),
    idempotencyKey: eventId,
    causation: runId ? { runId } : {},
    principalRef: 'conformance-author',
    correlationId: null,
    provenance: { sourceRefs: [], producer: SOURCE, trustLabels: [] },
  }
}

type Handler<T> = (request: unknown, context: CallContext) => Promise<Outcome<T>>

/** The agh.projection methods of one provider instance. */
export interface ProjectionMethods {
  snapshot: Handler<Wire.ProjectionSnapshot>
  changes: Handler<Wire.ProjectionChanges>
  command: Handler<Wire.CommandHandle>
  commandStatus: Handler<Wire.CommandHandle>
  openConversation: Handler<Wire.RuntimeConversationWindow>
  conversationHistory: Handler<Wire.RuntimeConversationWindow>
  listConversations: Handler<Wire.PageConversationSummary>
}

/** One projection provider as the suite drives it, wired to the fixture it was given. */
export interface ProjectionSubject {
  /** The binding the provider offers, carrying its query entry. */
  readonly binding: TestServiceBinding
  readonly fixture: ProjectionFixture
  /** The methods of the instance open now; a reopen replaces it. */
  service(): ProjectionMethods
  /** Commits events to the provider's own journal in order and returns once the projection took them. */
  append(events: readonly Wire.DomainEvent[]): Promise<void>
  /** Closes the provider and opens it again over the same storage. */
  reopen(): Promise<void>
  close(): Promise<void>
  /** Whether the provider's stored data is still there. */
  remains(): boolean
}

export type Fact<T> = T | { readonly refused: string }
type Window = Fact<Wire.RuntimeConversationWindow>
type Snapshot = Fact<Wire.ProjectionSnapshot>
type Handle = Fact<Wire.CommandHandle>

/**
 * Facts each scenario reports. The port only drives the provider and reads back; this module decides
 * whether the facts meet the projection rules, so every implementation is judged the same way.
 */
export interface ProjectionObservations {
  readonly select: { readonly binding: TestServiceBinding }
  /**
   * Session `normal`: four native nodes, tasks a (run-1), b, c (closed board) and d (artifact) and an
   * event outside the domain, two more native nodes, then a progressed and settled. `pages` is a
   * two-item snapshot and its next page; `quiet` the changes after the first page cursor at once and
   * `delta` after b progressed and d was removed. `windows` is a three-item open followed by every
   * history page. `handles` is a rename of a, the same request again and its status; `renamed` a
   * snapshot after it. `invalidated` opens the window after b is removed and again after the native
   * history is regenerated; `revived` is the first history cursor after the removal and the second
   * one after the regeneration. `outputs` is every result serialized, for the leak check.
   */
  readonly normal: {
    readonly pages: readonly Snapshot[]
    readonly quiet: Fact<Wire.ProjectionChanges>
    readonly delta: Fact<Wire.ProjectionChanges>
    readonly windows: readonly Window[]
    readonly nativeIds: readonly string[]
    readonly handles: readonly Handle[]
    readonly renamed: Snapshot
    readonly invalidated: readonly Window[]
    readonly revived: readonly string[]
    readonly prepared: number
    readonly outputs: readonly string[]
  }
  /**
   * Session `deny`: f and h readable, e behind a hidden artifact, g on a closed board. `visible` is the
   * snapshot the reader gets. `refusals` are detail codes, in order, of: another domain; a delta cursor
   * as a page cursor; a page cursor as a delta cursor; a cursor bound to another query; a tampered
   * cursor; a command on an unknown action, a disabled action, the hidden view, and with a mismatched
   * command schema; a conversation list; with the reader revoked a snapshot, the old delta cursor and
   * a window open; with the reader restored and then its board closed, a fresh delta cursor and a
   * window history page taken before the revocation.
   * `narrowed` is the snapshot after the board closed.
   */
  readonly deny: {
    readonly visible: Snapshot
    readonly refusals: readonly string[]
    readonly narrowed: Snapshot
    readonly prepared: number
    readonly outputs: readonly string[]
  }
  /** Snapshot, changes, command, status, window open and history with an aborted signal, then status. */
  readonly cancel: {
    readonly refusals: readonly string[]
    readonly status: Handle
    readonly prepared: number
  }
  /**
   * Session `recover`: a snapshot and a two-item window, a rename and an interruption, a snapshot, then
   * a reopen. `stale` is the old delta cursor and old history page after it; `replay` the rename before
   * and after. `later` follows a progressed event; `stalled` follows an event the reducer refuses and a
   * settle behind it, read before and after another reopen.
   */
  readonly recover: {
    readonly committed: Snapshot
    readonly after: Snapshot
    readonly stale: readonly string[]
    readonly replay: readonly Handle[]
    readonly windows: readonly Window[]
    readonly later: Snapshot
    readonly stalled: readonly Snapshot[]
    readonly prepared: number
  }
  /** Refusal codes of a snapshot, a window open, a command and a status after close; storage kept. */
  readonly dispose: { readonly refusals: readonly string[]; readonly remains: boolean }
}

export type ProjectionContractPort = {
  readonly [K in ScenarioName]: (context: CaseContext) => Promise<ProjectionObservations[K]>
}

async function factOf<T>(call: () => Promise<Outcome<T>>): Promise<Fact<T>> {
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

export const listQuery = (sessionId: string, limit: number, cursor: string | null = null) => ({
  domainType: TASKS_DOMAIN,
  query: inline(TASKS_SCHEMAS.query, { all: true }),
  scope: sessionScope(sessionId),
  cursor,
  limit,
})

export const renameRequest = (
  viewId: string,
  viewRevision: number,
  requestId: string,
  expectedRevision: number,
  extra: Record<string, unknown> = {},
) => ({
  negotiatedSession: 'conformance-session',
  clientInstanceId: 'conformance-client',
  catalogRevision: 1,
  ownerToken: 'conformance-owner',
  action: { viewId, actionKey: 'rename', viewRevision },
  input: inline(TASKS_SCHEMAS.renameInput, { title: `${viewId} renamed` }),
  requestId,
  expectedRevision,
  commandSchema: TASKS_SCHEMAS.renameInput,
  ...extra,
})

const items = (fact: Snapshot | undefined): readonly Wire.DomainView[] =>
  fact !== undefined && !('refused' in fact) ? fact.items : []
const revisionOf = (fact: Snapshot, viewId: string) =>
  items(fact).find((view) => view.viewId === viewId)?.revision ?? 0

/** Drives one projection provider through the six scenarios. */
export function projectionContractPort(subject: ProjectionSubject): ProjectionContractPort {
  const { fixture } = subject
  const reader = (aborted = false) => callContext(READER.principalRef, aborted)
  const drive = (sink: string[]) => {
    const record =
      <T>(name: keyof ProjectionMethods) =>
      (request: unknown, context = reader()) =>
        factOf(async () => {
          const outcome = (await subject.service()[name](request, context)) as Outcome<T>
          sink.push(JSON.stringify(outcome.ok ? outcome.value : outcome.error))
          return outcome
        })
    return {
      snapshot: record<Wire.ProjectionSnapshot>('snapshot'),
      changes: record<Wire.ProjectionChanges>('changes'),
      command: record<Wire.CommandHandle>('command'),
      status: record<Wire.CommandHandle>('commandStatus'),
      open: (sessionId: string, limit: number, context = reader()) =>
        record<Wire.RuntimeConversationWindow>('openConversation')({ sessionId, limit }, context),
      history: (sessionId: string, cursor: string, limit: number, context = reader()) =>
        record<Wire.RuntimeConversationWindow>('conversationHistory')({ sessionId, cursor, limit }, context),
      list: record<Wire.PageConversationSummary>('listConversations'),
    }
  }
  const add = (session: string, id: string, extra: Record<string, string>, runId?: string) =>
    domainEvent(`${session}-${id}-added`, 'added', session, { taskId: `${session}-${id}`, ...extra }, runId)
  const touch = (
    session: string,
    id: string,
    type: EventType,
    n: number,
    extra: Record<string, string> = {},
  ) => domainEvent(`${session}-${id}-${type}-${n}`, type, session, { taskId: `${session}-${id}`, ...extra })
  return {
    async select() {
      return { binding: subject.binding }
    },
    async normal() {
      const outputs: string[] = []
      const call = drive(outputs)
      const before = fixture.prepared()
      fixture.native.say('normal', 4)
      await subject.append([
        add('normal', 'a', { board: 'open', title: 'Alpha' }, 'run-1'),
        add('normal', 'b', { board: 'open', title: 'Bravo' }),
        add('normal', 'c', { board: 'vault', title: 'Vault plan' }),
        add('normal', 'd', { board: 'open', title: 'Delta', artifact: 'normal-art' }),
        domainEvent('normal-noise', 'noise', 'normal', {}),
      ])
      fixture.native.say('normal', 2)
      await subject.append([
        touch('normal', 'a', 'progressed', 1),
        touch('normal', 'a', 'settled', 1, { phase: 'finalized' }),
      ])
      const first = await call.snapshot(listQuery('normal', 2))
      const cursor = 'refused' in first ? '' : first.cursor
      const next = 'refused' in first ? null : first.nextPageCursor
      const pages = [first, await call.snapshot(listQuery('normal', 2, next))]
      const changes = { query: listQuery('normal', 2), afterCursor: cursor, limit: 2 }
      const quiet = await call.changes(changes)
      await subject.append([touch('normal', 'b', 'progressed', 1), touch('normal', 'd', 'removed', 1)])
      const delta = await call.changes(changes)
      const windows = [await call.open('normal', 3)]
      for (
        let page = windows[0];
        page && !('refused' in page) && page.nextPageCursor && windows.length < 10;
      ) {
        page = await call.history('normal', page.nextPageCursor, 3)
        windows.push(page)
      }
      const rename = renameRequest(
        'normal-a',
        revisionOf(first, 'normal-a'),
        'normal-rename',
        fixture.prepared(),
      )
      const handles = [
        await call.command(rename),
        await call.command(rename),
        await call.status('normal-rename'),
      ]
      const renamed = await call.snapshot(listQuery('normal', 10))
      const nextOf = (window: Window | undefined) =>
        window && !('refused' in window) ? (window.nextPageCursor ?? '') : ''
      await subject.append([touch('normal', 'b', 'removed', 1)])
      const invalidated = [await call.open('normal', 3)]
      const revived = [await call.history('normal', nextOf(windows[0]), 3)]
      fixture.native.regenerate('normal')
      invalidated.push(await call.open('normal', 3))
      revived.push(await call.history('normal', nextOf(invalidated[0]), 3))
      return {
        pages,
        quiet,
        delta,
        windows,
        nativeIds: fixture.native.ids('normal'),
        handles,
        renamed,
        invalidated,
        revived: revived.map(code),
        prepared: fixture.prepared() - before,
        outputs,
      }
    },
    async deny() {
      const outputs: string[] = []
      const call = drive(outputs)
      const before = fixture.prepared()
      await subject.append([
        add('deny', 'e', { board: 'deny-board', title: 'Hidden artifact task', artifact: 'deny-art' }),
        add('deny', 'f', { board: 'deny-board', title: 'Foxtrot' }),
        add('deny', 'g', { board: 'vault', title: 'Vault plan' }),
        add('deny', 'h', { board: 'deny-board', title: 'Hotel' }),
      ])
      fixture.gate.hideArtifact('deny-art')
      const visible = await call.snapshot(listQuery('deny', 10))
      const page = await call.snapshot(listQuery('deny', 1))
      const cursor = 'refused' in page ? '' : page.cursor
      const pageCursor = 'refused' in page ? '' : (page.nextPageCursor ?? '')
      const delta = (afterCursor: string, query = listQuery('deny', 1)) => ({ query, afterCursor, limit: 1 })
      const f = revisionOf(visible, 'deny-f')
      const refusals: unknown[] = [
        await call.snapshot({ ...listQuery('deny', 1), domainType: 'conformance.other/task@1' }),
        await call.snapshot(listQuery('deny', 1, cursor)),
        await call.changes(delta(pageCursor)),
        await call.changes(
          delta(cursor, { ...listQuery('deny', 1), query: inline(TASKS_SCHEMAS.query, { all: false }) }),
        ),
        await call.changes(delta(`${cursor.startsWith('0') ? '1' : '0'}${cursor.slice(1)}`)),
        await call.command(
          renameRequest('deny-f', f, 'deny-1', 0, {
            action: { viewId: 'deny-f', actionKey: 'delete', viewRevision: f },
          }),
        ),
        await call.command(
          renameRequest('deny-f', f, 'deny-2', 0, {
            action: { viewId: 'deny-f', actionKey: 'archive', viewRevision: f },
          }),
        ),
        await call.command(renameRequest('deny-e', 1, 'deny-3', 0)),
        await call.command(
          renameRequest('deny-f', f, 'deny-4', 0, { commandSchema: TASKS_SCHEMAS.renameResult }),
        ),
        await call.list({ scope: WORKSPACE, text: null, cursor: null, limit: 10 }),
      ]
      const window = await call.open('deny', 1)
      fixture.gate.revokeReader(READER.principalRef)
      refusals.push(
        await call.snapshot(listQuery('deny', 1)),
        await call.changes(delta(cursor)),
        await call.open('deny', 5),
      )
      fixture.gate.restoreReader(READER.principalRef)
      const fresh = await call.snapshot(listQuery('deny', 1))
      fixture.gate.closeBoard('deny-board')
      refusals.push(
        await call.changes(delta('refused' in fresh ? '' : fresh.cursor)),
        await call.history('deny', 'refused' in window ? '' : (window.nextPageCursor ?? ''), 1),
      )
      return {
        visible,
        refusals: refusals.map(code),
        narrowed: await call.snapshot(listQuery('deny', 10)),
        prepared: fixture.prepared() - before,
        outputs,
      }
    },
    async cancel() {
      const call = drive([])
      const before = fixture.prepared()
      await subject.append([add('cancel', 'k', { board: 'open', title: 'Kilo' })])
      const live = await call.snapshot(listQuery('cancel', 1))
      const window = await call.open('cancel', 1)
      const aborted = reader(true)
      const refusals = [
        await call.snapshot(listQuery('cancel', 1), aborted),
        await call.changes(
          { query: listQuery('cancel', 1), afterCursor: 'refused' in live ? '' : live.cursor, limit: 1 },
          aborted,
        ),
        await call.command(
          renameRequest('cancel-k', revisionOf(live, 'cancel-k'), 'cancel-rename', fixture.prepared()),
          aborted,
        ),
        await call.status('cancel-rename', aborted),
        await call.open('cancel', 1, aborted),
        await call.history('cancel', 'refused' in window ? '' : (window.nextPageCursor ?? ''), 1, aborted),
      ].map(code)
      return { refusals, status: await call.status('cancel-rename'), prepared: fixture.prepared() - before }
    },
    async recover() {
      const call = drive([])
      const before = fixture.prepared()
      fixture.native.say('recover', 3)
      await subject.append([
        add('recover', 'r1', { board: 'open', title: 'Romeo' }, 'run-1'),
        add('recover', 'r2', { board: 'open', title: 'Sierra' }),
      ])
      const first = await call.snapshot(listQuery('recover', 10))
      const window = await call.open('recover', 2)
      const rename = renameRequest(
        'recover-r1',
        revisionOf(first, 'recover-r1'),
        'recover-rename',
        fixture.prepared(),
      )
      const replay = [await call.command(rename)]
      await subject.append([touch('recover', 'r1', 'settled', 1, { phase: 'interrupted' })])
      const committed = await call.snapshot(listQuery('recover', 10))
      await subject.reopen()
      const stale = [
        await call.changes({
          query: listQuery('recover', 10),
          afterCursor: 'refused' in committed ? '' : committed.cursor,
          limit: 10,
        }),
        await call.history('recover', 'refused' in window ? '' : (window.nextPageCursor ?? ''), 2),
      ].map(code)
      const after = await call.snapshot(listQuery('recover', 10))
      replay.push(await call.command(rename))
      const windows = [window, await call.open('recover', 2)]
      await subject.append([touch('recover', 'r2', 'progressed', 1)])
      const later = await call.snapshot(listQuery('recover', 10))
      await subject.append([
        touch('recover', 'r2', 'broken', 1),
        touch('recover', 'r2', 'settled', 1, { phase: 'finalized' }),
      ])
      const stalled = [await call.snapshot(listQuery('recover', 10))]
      await subject.reopen()
      stalled.push(await call.snapshot(listQuery('recover', 10)))
      return {
        committed,
        after,
        stale,
        replay,
        windows,
        later,
        stalled,
        prepared: fixture.prepared() - before,
      }
    },
    async dispose() {
      const call = drive([])
      await subject.append([add('dispose', 'z', { board: 'open', title: 'Zulu' })])
      await subject.close()
      const refusals = [
        await call.snapshot(listQuery('dispose', 1)),
        await call.open('dispose', 1),
        await call.command(renameRequest('dispose-z', 1, 'dispose-rename', fixture.prepared())),
        await call.status('dispose-rename'),
      ].map(code)
      return { refusals, remains: subject.remains() }
    },
  }
}

const same = (left: unknown, right: unknown) => jcs(left) === jcs(right)
const entryId = (sessionId: string, viewId: string) =>
  `domain:${canonicalJsonDigest({ domainType: TASKS_DOMAIN, scope: sessionScope(sessionId), viewId })}`
const valid = <
  K extends 'ProjectionSnapshot' | 'ProjectionChanges' | 'RuntimeConversationWindow' | 'CommandHandle',
>(
  name: K,
  fact: unknown,
) => fact !== undefined && code(fact) === '' && validateRuntime(name, fact).ok
const ids = (fact: Snapshot | undefined) => items(fact).map((view) => view.viewId)
const view = (fact: Snapshot | undefined, viewId: string) =>
  items(fact).find((item) => item.viewId === viewId)

/** No output names a private field, a closed-board task or a task behind a hidden artifact. */
const clean = (outputs: readonly string[]) =>
  outputs.length > 0 &&
  outputs.every(
    (text) => !text.includes('private-') && !text.includes('Vault plan') && !text.includes('Hidden artifact'),
  )

/** Pages from newest to oldest share one epoch and chain to a complete last page. */
function chained(windows: readonly Window[]): Wire.RuntimeConversationWindow[] | null {
  const pages = windows.filter((page): page is Wire.RuntimeConversationWindow =>
    valid('RuntimeConversationWindow', page),
  )
  if (pages.length === 0 || pages.length !== windows.length) return null
  const last = pages[pages.length - 1]
  const linked = pages.every(
    (page, index) =>
      page.epoch === pages[0]?.epoch &&
      page.complete === (index === pages.length - 1) &&
      (page.nextPageCursor === null) === page.complete &&
      same(
        page.native.timeline.nodes.map((node) => node.id),
        page.order.filter((item) => item.kind === 'native').map((item) => item.id),
      ) &&
      same(
        page.domains.map((entry) => entry.id),
        page.order.filter((item) => item.kind === 'domain').map((item) => item.id),
      ),
  )
  return linked && last?.complete ? pages : null
}

/** A removal and then a native regeneration each start a new epoch; the removed entry is gone. */
function invalidated(windows: readonly Window[], epoch: string | undefined, removed: string): boolean {
  const [afterRemoval, afterRegeneration] = windows.map((window) =>
    valid('RuntimeConversationWindow', window) && !('refused' in window) ? window : undefined,
  )
  return (
    afterRemoval !== undefined &&
    afterRegeneration !== undefined &&
    epoch !== undefined &&
    afterRemoval.epoch !== epoch &&
    !afterRemoval.domains.some((entry) => entry.id === removed) &&
    afterRegeneration.epoch !== afterRemoval.epoch &&
    afterRegeneration.native.timeline.generation === 2
  )
}

const chronological = (pages: readonly Wire.RuntimeConversationWindow[]) =>
  [...pages].reverse().flatMap((page) => page.order.map((item) => item.id))

type Judge = {
  readonly [K in ScenarioName]: (
    seen: ProjectionObservations[K],
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
    const refs = RuntimeMethodSchemaRefs[CONTRACT].snapshot
    const reply = await chosen.value.query(
      { target: chosen.value.binding, method: 'snapshot', input: inline(refs.input, listQuery('select', 5)) },
      callContext(),
    )
    return (
      reply.ok &&
      reply.value.kind === 'value' &&
      same(reply.value.output.schema, refs.output) &&
      reply.value.output.kind === 'inline' &&
      valid('ProjectionSnapshot', reply.value.output.value)
    )
  },
  normal(seen) {
    const [first, second] = seen.pages.map((page) =>
      valid('ProjectionSnapshot', page) && !('refused' in page) ? page : undefined,
    )
    const alpha = view(first, 'normal-a')
    const delta =
      valid('ProjectionChanges', seen.delta) && !('refused' in seen.delta) ? seen.delta.changes : []
    const pages = chained(seen.windows)
    const [handle, repeat, status] = seen.handles
    const a = entryId('normal', 'normal-a')
    const b = entryId('normal', 'normal-b')
    const quiet = valid('ProjectionChanges', seen.quiet) && !('refused' in seen.quiet) ? seen.quiet : null
    return (
      first !== undefined &&
      second !== undefined &&
      same(ids(first), ['normal-a', 'normal-b']) &&
      same(ids(second), ['normal-d']) &&
      !first.complete &&
      second.complete &&
      second.nextPageCursor === null &&
      first.projectionRevision === second.projectionRevision &&
      [...items(first), ...items(second)].every(
        (item) =>
          same(item.scope, sessionScope('normal')) &&
          item.fallbackText.includes(String((item.data as { title?: string }).title)),
      ) &&
      alpha?.phase === 'finalized' &&
      same(alpha.stream, { streamId: 'normal-a', generation: 1, revision: 2 }) &&
      same(alpha.data, { title: 'Alpha' }) &&
      same(
        view(second, 'normal-d')?.resources.map((resource) => resource.artifactId),
        ['normal-art'],
      ) &&
      quiet?.changes.length === 0 &&
      !quiet.hasMore &&
      delta.length === 2 &&
      delta.some(
        (change) =>
          change.kind === 'upsert' && change.view.viewId === 'normal-b' && change.view.stream?.revision === 2,
      ) &&
      delta.some(
        (change) => change.kind === 'remove' && change.viewId === 'normal-d' && change.reason !== '',
      ) &&
      pages !== null &&
      seen.nativeIds.length === 6 &&
      same(chronological(pages), [...seen.nativeIds.slice(0, 4), a, b, ...seen.nativeIds.slice(4)]) &&
      same(
        pages.flatMap((page) => page.domains.map((entry) => [entry.id, entry.turnId])).sort(),
        [
          [a, 'normal-turn-1'],
          [b, null],
        ].sort(),
      ) &&
      valid('CommandHandle', handle) &&
      same(handle && code(handle) === '' ? { ...handle, commandId: null } : null, {
        commandId: null,
        requestId: 'normal-rename',
        revision: 1,
        completion: 'domain-commit',
        status: 'succeeded',
        result: inline(TASKS_SCHEMAS.renameResult, { taskId: 'normal-a' }),
        error: null,
      }) &&
      same(repeat, handle) &&
      same(status, handle) &&
      same(view(seen.renamed, 'normal-a')?.data, { title: 'normal-a renamed' }) &&
      invalidated(seen.invalidated, pages?.[0]?.epoch, b) &&
      same(seen.revived, ['resync_required', 'resync_required']) &&
      seen.prepared === 1 &&
      clean(seen.outputs)
    )
  },
  deny: (seen) =>
    same(ids(seen.visible), ['deny-f', 'deny-h']) &&
    same(seen.refusals, [
      'invalid_request',
      'invalid_request',
      'invalid_request',
      'invalid_request',
      'resync_required',
      'not_found',
      'blocked',
      'not_found',
      'invalid_request',
      'unsupported',
      'permission_denied',
      'resync_required',
      'permission_denied',
      'resync_required',
      'resync_required',
    ]) &&
    valid('ProjectionSnapshot', seen.narrowed) &&
    ids(seen.narrowed).length === 0 &&
    seen.prepared === 0 &&
    clean(seen.outputs),
  cancel: (seen) =>
    same(seen.refusals, Array(6).fill('cancelled')) &&
    valid('CommandHandle', seen.status) &&
    !('refused' in seen.status) &&
    seen.status.status === 'not-accepted' &&
    seen.prepared === 0,
  recover(seen) {
    const [handle, replayed] = seen.replay
    const [before, after] = seen.windows
    const [stalledBefore, stalledAfter] = seen.stalled
    const r2 = view(seen.later, 'recover-r2')
    return (
      valid('ProjectionSnapshot', seen.committed) &&
      same(view(seen.committed, 'recover-r1')?.data, { title: 'recover-r1 renamed' }) &&
      view(seen.committed, 'recover-r1')?.phase === 'interrupted' &&
      same(items(seen.after), items(seen.committed)) &&
      same(seen.stale, ['resync_required', 'resync_required']) &&
      valid('CommandHandle', handle) &&
      same(replayed, handle) &&
      seen.prepared === 1 &&
      valid('RuntimeConversationWindow', before) &&
      valid('RuntimeConversationWindow', after) &&
      !('refused' in (before ?? { refused: '' })) &&
      before !== undefined &&
      after !== undefined &&
      !('refused' in before) &&
      !('refused' in after) &&
      before.epoch !== after.epoch &&
      same(before.order, after.order) &&
      same(before.order.slice(-2), [
        { kind: 'domain', id: entryId('recover', 'recover-r1') },
        { kind: 'domain', id: entryId('recover', 'recover-r2') },
      ]) &&
      same(r2?.stream, { streamId: 'recover-r2', generation: 1, revision: 2 }) &&
      r2?.phase === 'provisional' &&
      same(items(stalledBefore), items(seen.later)) &&
      same(items(stalledAfter), items(seen.later))
    )
  },
  dispose: (seen) =>
    seen.refusals.length === 4 &&
    seen.refusals.every((detail) => Object.hasOwn(RuntimeErrorDetails, detail)) &&
    seen.remains,
}

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['snapshot'],
  normal: ['snapshot', 'changes', 'openConversation', 'conversationHistory', 'command', 'commandStatus'],
  deny: ['snapshot', 'changes', 'openConversation', 'command', 'listConversations'],
  cancel: ['snapshot', 'changes', 'openConversation', 'conversationHistory', 'command', 'commandStatus'],
  recover: ['snapshot', 'changes', 'openConversation', 'conversationHistory', 'command'],
  dispose: ['snapshot', 'openConversation', 'command', 'commandStatus'],
}

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

export interface ProjectionConformanceBinding {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the provider code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly port: ProjectionContractPort
}

/** Register select, normal, deny, cancel, recover and dispose for one projection provider. */
export function registerProjectionContract(
  harness: ConformanceHarness,
  binding: ProjectionConformanceBinding,
): void {
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
            scope: 'workspace',
            methodKind: 'query',
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
