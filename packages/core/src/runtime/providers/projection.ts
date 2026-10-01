import type {
  CallContext,
  DomainCommandHandler,
  DomainReducer,
  DomainSelector,
  Outcome,
  ProjectionReadContext,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import {
  createDomainCommands,
  type DomainCommandOwner,
  fail,
  type RegisteredDomainCommand,
} from '../projection/commands.js'
import { createDomainProjection, type ProjectionDelta, type ReaderGrant } from '../projection/domain.js'

export type ReaderPolicy = Readonly<{
  capability: string
  rules: readonly Readonly<{ pointer: string; resourcePointer: string; operation: string }>[]
}>

export type ProjectionCommand = Readonly<{
  inputSchema: Wire.SchemaRef
  resultSchema: Wire.SchemaRef
  completion: RegisteredDomainCommand['completion']
  handler: DomainCommandHandler
}>

/** One domain as its owner registered it. */
export type ProjectionDomain = Readonly<{
  domainType: string
  stateSchema: Wire.SchemaRef
  readStateSchema: Wire.SchemaRef
  viewSchema: Wire.SchemaRef
  onCommittedTypes: readonly string[]
  readerPolicy: ReaderPolicy
  reducer: DomainReducer
  selector: DomainSelector
  /** The registered readStateSchema check for a state the reader policy trimmed. */
  checkReadState(value: Wire.JsonValue): boolean
  /** A query under the domain query schema that lists every view of the scope it is asked with. */
  listQuery: Wire.DataRef
  commands: ReadonlyMap<string, ProjectionCommand>
}>

/** Current authorization, asked again on every call. */
export type ProjectionAccess = Readonly<{
  /** The reader grant; a revocation that narrows the reader must change the grant it returns. */
  grant(capability: string, scope: Wire.ScopeRef, context: CallContext): Promise<Outcome<ReaderGrant>>
  /** Whether the reader may perform a reader-policy operation on the resource the private state names. */
  allows(operation: string, resource: Wire.JsonValue, context: CallContext): Promise<boolean>
  canReadResource(resource: Wire.ArtifactViewRef, context: CallContext): Promise<boolean>
}>

/** The native conversation window as the existing protocol serves it. */
export type NativeConversation = Readonly<{
  head(sessionId: string): Readonly<{ generation: number; upto: number }>
  /** The newest `limit` nodes before a full-timeline node index, or the live tail when it is null. */
  page(
    sessionId: string,
    beforeIndex: number | null,
    limit: number,
    context: CallContext,
  ): Promise<Outcome<Wire.UIOpeningResult>>
}>

export type ProjectionProviderOptions = Readonly<{
  binding: Wire.BindingRef
  domain: ProjectionDomain
  access: ProjectionAccess
  native: NativeConversation
  /** Committed records after a source sequence, in sequence order; the only event input. */
  journal(afterSequence: number, limit: number): Promise<readonly Wire.DomainEventRecord[]>
  /** The command journal identity and store; views and commands come from this provider. */
  owner: Omit<DomainCommandOwner, 'views' | 'commands'>
  /** The native turn a session event belongs to, from evidence the Host holds. */
  turnOf?(event: Wire.DomainEvent): string | null
  features?(context: CallContext): readonly string[]
  /** The reader's query and data reads a selector or command handler may use. */
  reads: Pick<ProjectionReadContext, 'query' | 'resolveData'>
  /** Revisions kept for deltas; an older cursor asks the reader to resynchronize. */
  retainedRevisions?: number
}>

type Cut = Readonly<{ revision: number; state: Wire.DataRef | null }>
type Placement = Readonly<{ sessionId: string; position: number; anchor: number; turnId: string | null }>
type Entry = Placement & Readonly<{ id: string; view: Wire.DomainView }>
type Window = { reader: string; salt: string; revision: number; cut: string; visible: Set<string> }
type WindowCursor = Readonly<{
  kind: 'order' | 'page'
  reader: string
  role: string
  sessionId: string
  epoch: string
  revision: number
  nativeBefore: number | null
  domainBefore: number | null
}>

const PAGE = 500
const SELECT_TRIES = 3
const same = (left: unknown, right: unknown) => jcs(left) === jcs(right)
const ok = <T>(value: T) => ({ ok: true as const, value })
const random = () =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
const inline = (schema: Wire.SchemaRef, value: Wire.JsonValue): Wire.DataRef => ({
  kind: 'inline',
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(jcs(value)).length,
})

function pointer(text: string): string[] {
  if (text === '') return []
  const parts = text.startsWith('/') ? text.slice(1).split('/') : undefined
  const decoded = parts?.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (!decoded || decoded.some((part) => part.includes('*') && part !== '*'))
    throw new Error(`reader policy pointer is not supported: ${text}`)
  return decoded
}

type Hit = Readonly<{ path: readonly (string | number)[]; value: unknown; picks: readonly number[] }>

/** Every value a pointer reaches, a `*` segment standing for each element of an array. */
function expand(
  node: unknown,
  parts: readonly string[],
  at = 0,
  path: Hit['path'] = [],
  picks: Hit['picks'] = [],
): Hit[] {
  if (at === parts.length) return node === undefined ? [] : [{ path, value: node, picks }]
  const part = parts[at] ?? ''
  if (Array.isArray(node)) {
    if (part === '*')
      return node.flatMap((item, index) => expand(item, parts, at + 1, [...path, index], [...picks, index]))
    const index = /^(0|[1-9]\d*)$/.test(part) ? Number(part) : -1
    return index >= 0 && index < node.length
      ? expand(node[index], parts, at + 1, [...path, index], picks)
      : []
  }
  if (part === '*' || node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return []
  return expand((node as Record<string, unknown>)[part], parts, at + 1, [...path, part], picks)
}

function put(out: { root?: unknown }, path: readonly (string | number)[], value: unknown) {
  if (path.length === 0) {
    out.root = structuredClone(value)
    return
  }
  // Own properties only, so a state key such as __proto__ can never reach a prototype.
  const own = (node: object, key: string | number, item: unknown) =>
    Object.defineProperty(node, key, { value: item, enumerable: true, writable: true, configurable: true })
  const container = (key: string | number | undefined) => (typeof key === 'number' ? [] : {})
  out.root ??= container(path[0])
  let node = out.root as Record<string | number, unknown>
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index] ?? ''
    if (!Object.hasOwn(node, key)) own(node, key, container(path[index + 1]))
    node = node[key] as Record<string | number, unknown>
  }
  own(node, path[path.length - 1] ?? '', structuredClone(value))
}

/** Arrays lose the elements no rule copied; flatMap skips holes. */
const compact = (value: unknown): Wire.JsonValue =>
  Array.isArray(value)
    ? value.flatMap((item) => [compact(item)])
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]))
      : (value as Wire.JsonValue)

const sessionScope = (scope: Wire.ScopeRef, sessionId: string): Wire.ScopeRef | null => {
  if (scope.kind === 'session') return scope.sessionId === sessionId ? scope : null
  if (scope.kind !== 'workspace') return null
  const { installationId, runtimeId, workspaceId } = scope
  return { kind: 'session', installationId, runtimeId, workspaceId, sessionId }
}

/**
 * The default agh.projection provider. Committed domain events are folded one at a time into the live
 * state as the journal grows; the last revisions stay in memory for deltas, and a restart folds the
 * journal again under a new cursor key, so every earlier cursor asks for a resync.
 */
export function createProjectionProvider(options: ProjectionProviderOptions) {
  const { domain, access, native } = options
  const retained = options.retainedRevisions ?? 64
  const rules = domain.readerPolicy.rules.map((rule) => {
    const parts = pointer(rule.pointer)
    const resource = pointer(rule.resourcePointer)
    if (resource.filter((part) => part === '*').length > parts.filter((part) => part === '*').length)
      throw new Error('a resource pointer may only bind array elements its rule pointer binds')
    return { parts, resource, operation: rule.operation }
  })
  const { reads } = options
  const fold = {
    watermark: 0,
    cuts: [{ revision: 0, state: null }] as Cut[],
    stalled: null as Wire.RuntimeError | null,
  }
  const placements = new Map<Wire.Id, Placement>()
  const positions = new Map<string, number>()
  const windows = new Map<string, Map<string, Window>>()
  const secret = random()
  let closed = false
  let pulling: Promise<void> | undefined

  const head = (): Cut => fold.cuts[fold.cuts.length - 1] ?? { revision: 0, state: null }
  const capability = domain.readerPolicy.capability
  const readContext = (call: CallContext, revision: number): ProjectionReadContext => ({
    call,
    snapshot: `${domain.domainType}@${revision}`,
    ...reads,
  })

  function place(event: Wire.DomainEvent) {
    if (event.scope.kind !== 'session' || placements.has(event.eventId)) return
    const { sessionId } = event.scope
    const position = (positions.get(sessionId) ?? 0) + 1
    positions.set(sessionId, position)
    const anchor = native.head(sessionId).upto
    placements.set(event.eventId, { sessionId, position, anchor, turnId: options.turnOf?.(event) ?? null })
  }

  /** Folds one record; a failing reducer leaves the watermark before it. */
  function apply(record: Wire.DomainEventRecord): Wire.RuntimeError | null {
    const { event } = record
    if (domain.onCommittedTypes.includes(event.typeId)) {
      const current = head()
      let next: Outcome<Wire.DataRef>
      try {
        next = domain.reducer.reduce({ state: current.state, event })
      } catch {
        next = fail('integrity', 'reducer threw')
      }
      if (next.ok && !same(next.value.schema, domain.stateSchema))
        next = fail('integrity', 'reducer state does not use the domain state schema')
      if (!next.ok) return next.error
      fold.cuts.push({ revision: current.revision + 1, state: next.value })
      if (fold.cuts.length > retained + 1) fold.cuts.shift()
      place(event)
    }
    fold.watermark = record.sequence
    return null
  }

  async function pull() {
    for (;;) {
      const records = await options.journal(fold.watermark, PAGE)
      for (const record of records) {
        if (record.sequence <= fold.watermark) continue
        // A gap waits for the journal to fill it; the reader keeps the last complete cut.
        if (record.sequence !== fold.watermark + 1) return
        fold.stalled = apply(record)
        if (fold.stalled) return
      }
      if (records.length < PAGE) return
    }
  }

  async function catchUp() {
    pulling ??= pull().finally(() => {
      pulling = undefined
    })
    await pulling
  }

  /** Reader policy: only fields a rule names, and only where the reader may use the rule's resource. */
  async function trim(cut: Cut, context: CallContext): Promise<Outcome<Wire.DataRef>> {
    if (cut.state?.kind === 'blob') return fail('unsupported', 'a blob domain state is not folded inline')
    const state = cut.state?.value ?? null
    const decided = new Map<string, Promise<boolean>>()
    const out: { root?: unknown } = {}
    for (const rule of rules)
      for (const hit of expand(state, rule.parts)) {
        let pick = 0
        const at = rule.resource.map((part) => (part === '*' ? String(hit.picks[pick++]) : part))
        const [resource] = expand(state, at)
        if (resource === undefined) continue
        const key = `${rule.operation}\0${jcs(resource.value)}`
        if (!decided.has(key))
          decided.set(key, access.allows(rule.operation, resource.value as Wire.JsonValue, context))
        if (await decided.get(key)) put(out, hit.path, hit.value)
      }
    const value = compact(out.root ?? {})
    return domain.checkReadState(value)
      ? ok(inline(domain.readStateSchema, value))
      : fail('integrity', 'trimmed state does not match the read state schema')
  }

  async function select(request: Wire.DomainSelectorSelectAuthorizedRequest, context: CallContext) {
    try {
      return await domain.selector.selectAuthorized(request, readContext(context, request.projectionRevision))
    } catch {
      return fail('integrity', 'selector threw')
    }
  }

  async function viewsAt(cut: Cut, query: Wire.DomainQuery, context: CallContext) {
    const state = await trim(cut, context)
    if (!state.ok) return state
    const selected = await select(
      { state: state.value, query: { ...query, cursor: null }, projectionRevision: cut.revision },
      context,
    )
    return selected.ok ? ok(selected.value.items) : selected
  }

  const projection = createDomainProjection({
    domainType: domain.domainType,
    readStateSchema: domain.readStateSchema,
    viewSchema: domain.viewSchema,
    authorize: (query, context) => access.grant(capability, query.scope, context),
    async readState(_query, context) {
      await catchUp()
      const cut = head()
      const state = await trim(cut, context)
      return state.ok ? ok({ state: state.value, projectionRevision: cut.revision }) : state
    },
    select,
    // ponytail: one diff from the cursor's revision to the head; a diff larger than the page answers
    // reset instead of paging, and only `retainedRevisions` cuts stay in memory.
    async changes(query, after, limit, context): Promise<Outcome<ProjectionDelta>> {
      const old = fold.cuts.find((cut) => cut.revision === after)
      if (!old) return fail('resync_required', 'that projection revision is no longer retained')
      const now = head()
      const before = await viewsAt(old, query, context)
      if (!before.ok) return before
      const current = await viewsAt(now, query, context)
      if (!current.ok) return current
      const prior = new Map(before.value.map((view) => [view.viewId, view]))
      const present = new Set(current.value.map((view) => view.viewId))
      const changes: Wire.DomainViewChange[] = current.value
        .filter((view) => prior.get(view.viewId)?.revision !== view.revision)
        .map((view) => ({ kind: 'upsert', view }))
      for (const view of before.value)
        if (!present.has(view.viewId))
          changes.push({ kind: 'remove', viewId: view.viewId, revision: view.revision, reason: 'removed' })
      return changes.length > limit
        ? ok({ kind: 'reset' })
        : ok({ kind: 'changes', changes, projectionRevision: now.revision, hasMore: false })
    },
    canReadResource: (resource, context) => access.canReadResource(resource, context),
  })

  /** Every authorized view of a scope, read page by page from one projection cut. */
  async function allViews(scope: Wire.ScopeRef, context: CallContext): Promise<Outcome<Wire.DomainView[]>> {
    let last: Outcome<Wire.DomainView[]> = fail('resync_required', 'projection kept moving')
    for (let attempt = 0; attempt < SELECT_TRIES; attempt++) {
      const views: Wire.DomainView[] = []
      let cursor: string | null = null
      for (;;) {
        const query = { domainType: domain.domainType, query: domain.listQuery, scope, cursor, limit: PAGE }
        const page = await projection.snapshot(query, context)
        if (!page.ok) {
          last = page
          break
        }
        views.push(...page.value.items)
        if (page.value.nextPageCursor === null) return ok(views)
        cursor = page.value.nextPageCursor
      }
      if (last.ok || last.error.detailCode !== 'resync_required') return last
    }
    return last
  }

  const commands = createDomainCommands({
    ...options.owner,
    commands: new Map(
      [...domain.commands].map(([name, command]) => [
        name,
        {
          inputSchema: command.inputSchema,
          resultSchema: command.resultSchema,
          completion: command.completion,
          // ponytail: the frame carries the wire context only, so prepare cannot see the caller's
          // abort signal; the provider refuses an already cancelled call before it gets here.
          prepare: (frame) =>
            command.handler.prepare(
              frame,
              readContext({ ...frame.context, signal: new AbortController().signal }, frame.stateRevision),
            ),
        } satisfies RegisteredDomainCommand,
      ]),
    ),
    views: {
      async resolve(ref, context) {
        const views = await allViews(context.scope, context)
        if (!views.ok) return views
        const view = views.value.find((item) => item.viewId === ref.viewId)
        const action = view?.actions.find((item) => item.actionKey === ref.actionKey)
        return view && action
          ? ok({ view, action })
          : fail('not_found', 'no such action in the authorized projection')
      },
      canRead: async (context) => (await access.grant(capability, context.scope, context)).ok,
    },
  })

  const sign = (body: WindowCursor) => {
    const json = jcs(body)
    return `${canonicalJsonDigest({ body: json, secret })}.${json}`
  }
  function opened(cursor: string): WindowCursor | null {
    const dot = cursor.indexOf('.')
    const json = cursor.slice(dot + 1)
    if (dot < 0 || cursor.slice(0, dot) !== canonicalJsonDigest({ body: json, secret })) return null
    return JSON.parse(json) as WindowCursor
  }

  function earliest(view: Wire.DomainView): Placement | undefined {
    let found: Placement | undefined
    for (const eventId of view.source.eventIds) {
      const placement = placements.get(eventId)
      if (placement && (!found || placement.position < found.position)) found = placement
    }
    return found
  }

  /** The reader's window bookkeeping. A new grant starts over, and a view leaving the set changes the epoch. */
  function remember(principal: string, sessionId: string, grant: ReaderGrant, cut: string, ids: Set<string>) {
    const bucket = windows.get(principal) ?? new Map<string, Window>()
    windows.set(principal, bucket)
    const reader = jcs(grant)
    let window = bucket.get(sessionId)
    if (window?.reader !== reader) {
      window = { reader, salt: random(), revision: 0, cut: '', visible: new Set<string>() }
      bucket.set(sessionId, window)
    }
    if ([...window.visible].some((id) => !ids.has(id))) window.salt = random()
    if (window.cut !== cut) {
      window.revision++
      window.cut = cut
    }
    window.visible = ids
    return window
  }

  async function conversation(
    sessionId: string,
    limit: number,
    cursor: WindowCursor | null,
    context: CallContext,
  ): Promise<Outcome<Wire.RuntimeConversationWindow>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE)
      return fail('invalid_request', `limit must be an integer from 1 to ${PAGE}`)
    const scope = sessionScope(context.scope, sessionId)
    if (!scope) return fail('permission_denied', 'session is outside the caller scope')
    const grant = await access.grant(capability, scope, context)
    if (!grant.ok) {
      windows.delete(context.principalRef)
      return grant
    }
    if (cursor && (cursor.reader !== grant.value.readerId || cursor.role !== grant.value.role))
      return fail('resync_required', 'reader access changed since this page')
    const views = await allViews(scope, context)
    if (!views.ok) return views
    const entries: Entry[] = []
    for (const view of views.value) {
      const placement = earliest(view)
      if (placement?.sessionId !== sessionId) continue
      const id = `domain:${canonicalJsonDigest({ domainType: view.domainType, scope: view.scope, viewId: view.viewId })}`
      entries.push({ ...placement, id, view })
    }
    entries.sort((left, right) => left.position - right.position)
    const nativeHead = native.head(sessionId)
    const window = remember(
      context.principalRef,
      sessionId,
      grant.value,
      jcs([nativeHead, entries.map((entry) => [entry.id, entry.view.revision])]),
      new Set(entries.map((entry) => entry.id)),
    )
    const reader = { reader: grant.value.readerId, role: grant.value.role, sessionId }
    const epoch = canonicalJsonDigest({ ...reader, generation: nativeHead.generation, salt: window.salt })
    if (cursor && cursor.epoch !== epoch) return fail('resync_required', 'conversation window changed epoch')

    const nativeBefore = cursor?.nativeBefore ?? null
    const domainBefore = cursor?.domainBefore ?? null
    const candidates = entries
      .filter((entry) => domainBefore === null || entry.position < domainBefore)
      .slice(-limit)
    const first = await native.page(sessionId, nativeBefore, limit, context)
    if (!first.ok) return first
    if (first.value.timeline.generation !== nativeHead.generation)
      return fail('resync_required', 'native generation moved')
    // Native nodes stay in native order; a domain entry follows the native nodes it was accepted after.
    const merged: ({ kind: 'native'; id: string } | { kind: 'domain'; entry: Entry })[] = []
    const nodes = first.value.timeline.nodes
    let nodeIndex = 0
    let entryIndex = 0
    let seq = 0
    while (nodeIndex < nodes.length || entryIndex < candidates.length) {
      const node = nodes[nodeIndex]
      const entry = candidates[entryIndex]
      // A node without its own seq, such as a slot fill, sits with the node before it.
      const at = node && 'seq' in node ? node.seq : seq
      if (node && (!entry || at <= entry.anchor)) {
        merged.push({ kind: 'native', id: node.id })
        seq = at
        nodeIndex++
      } else if (entry) {
        merged.push({ kind: 'domain', entry })
        entryIndex++
      }
    }
    const kept = merged.slice(-limit)
    const domains = kept.flatMap((item) => (item.kind === 'domain' ? [item.entry] : []))
    const nativeCount = kept.length - domains.length
    const page =
      nativeCount === nodes.length ? first : await native.page(sessionId, nativeBefore, nativeCount, context)
    if (!page.ok) return page
    const keptNative = kept.flatMap((item) => (item.kind === 'native' ? [item.id] : []))
    if (
      !same(
        page.value.timeline.nodes.map((node) => node.id),
        keptNative,
      )
    )
      return fail('resync_required', 'native history moved while the page was read')
    const bound = domains[0]?.position ?? domainBefore ?? Number.POSITIVE_INFINITY
    const more = page.value.history.hasEarlier || entries.some((entry) => entry.position < bound)
    const next = {
      ...reader,
      epoch,
      revision: window.revision,
      nativeBefore: page.value.history.startIndex,
      domainBefore: Number.isFinite(bound) ? bound : null,
    }
    const result = validateRuntime('RuntimeConversationWindow', {
      sessionId,
      epoch,
      revision: window.revision,
      native: page.value,
      domains: domains.map((entry) => ({
        kind: 'domain',
        id: entry.id,
        view: entry.view,
        turnId: entry.turnId,
      })),
      order: kept.map((item) => (item.kind === 'native' ? item : { kind: 'domain', id: item.entry.id })),
      orderCursor: sign({ ...next, kind: 'order', nativeBefore: null, domainBefore: null }),
      nextPageCursor: more ? sign({ ...next, kind: 'page' }) : null,
      complete: !more,
    })
    return result.ok ? result : fail('integrity', 'conversation window failed its own schema')
  }

  const guard =
    <T>(body: (request: unknown, context: CallContext) => Promise<Outcome<T>>) =>
    async (request: unknown, context: CallContext): Promise<Outcome<T>> => {
      if (closed) return fail('backend_unavailable', 'projection provider is closed')
      if (context.signal.aborted) return fail('cancelled', 'call was cancelled')
      try {
        return await body(request, context)
      } catch {
        return fail('internal_error', 'projection failed')
      }
    }

  const submit = guard(async (request, context) => {
    const handle = await commands.submit({ request, context, features: options.features?.(context) ?? [] })
    await catchUp()
    return handle
  })

  const methods = {
    snapshot: guard(projection.snapshot),
    changes: guard(projection.changes),
    command: submit,
    acceptCommand: submit,
    commandStatus: guard(commands.commandStatus),
    openConversation: guard(async (request, context) => {
      const parsed = validateRuntime('ShellConversationClientOpenRequest', request)
      if (!parsed.ok) return fail('invalid_request', 'open request does not match its schema')
      return conversation(parsed.value.sessionId, parsed.value.limit, null, context)
    }),
    conversationHistory: guard(async (request, context) => {
      const parsed = validateRuntime('ShellConversationClientHistoryRequest', request)
      if (!parsed.ok) return fail('invalid_request', 'history request does not match its schema')
      const cursor = opened(parsed.value.cursor)
      if (!cursor) return fail('resync_required', 'page cursor was not issued by this projection')
      if (cursor.kind !== 'page') return fail('invalid_request', 'history takes a page cursor')
      if (cursor.sessionId !== parsed.value.sessionId)
        return fail('invalid_request', 'page cursor belongs to another session')
      return conversation(parsed.value.sessionId, parsed.value.limit, cursor, context)
    }),
    // ponytail: listing belongs to the session directory, whose owner is not settled yet.
    listConversations: guard(
      async (): Promise<Outcome<Wire.PageConversationSummary>> =>
        fail('unsupported', 'conversation listing is not served by this projection'),
    ),
  }
  const refs = RuntimeMethodSchemaRefs['agh.projection'] as Record<
    string,
    { input: Wire.SchemaRef; output: Wire.SchemaRef } | undefined
  >
  const queries: Record<
    string,
    ((request: unknown, context: CallContext) => Promise<Outcome<unknown>>) | undefined
  > = {
    snapshot: methods.snapshot,
    changes: methods.changes,
    commandStatus: methods.commandStatus,
    openConversation: methods.openConversation,
    conversationHistory: methods.conversationHistory,
    listConversations: methods.listConversations,
  }

  return {
    binding: options.binding,
    ...methods,
    /** The query entry a service container binds; inputs and outputs carry the method schema refs. */
    async query(request: Wire.ServiceQuery, context: CallContext): Promise<Outcome<Wire.QueryReply>> {
      const ref = Object.hasOwn(refs, request.method) ? refs[request.method] : undefined
      const handler = Object.hasOwn(queries, request.method) ? queries[request.method] : undefined
      if (!ref || !handler) return fail('operation_not_supported', 'not a projection query')
      if (request.input.kind !== 'inline' || !same(request.input.schema, ref.input))
        return fail('invalid_request', 'query input does not use the method schema')
      const result = await handler(request.input.value, context)
      if (!result.ok) return result
      const value = result.value as Wire.JsonValue
      return ok({ kind: 'value', output: inline(ref.output, value), snapshot: canonicalJsonDigest(value) })
    },
    /** Folds what the journal holds now; the reducer error that stops the fold, if any. */
    async refresh(): Promise<Wire.RuntimeError | null> {
      await catchUp()
      return fold.stalled
    },
    close() {
      closed = true
      windows.clear()
    },
  }
}

export type ProjectionProvider = ReturnType<typeof createProjectionProvider>
