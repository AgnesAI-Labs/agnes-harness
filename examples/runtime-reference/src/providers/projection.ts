import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
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
import {
  canonicalJsonDigest,
  RuntimeErrorDetails,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  validateDomainCommandSchemas,
  validateProjectionChanges,
  validateRuntime,
} from '@agnes/protocol/runtime'

export const PROJECTION_PROVIDER = { id: 'reference.projection', contract: 'agh.projection' } as const

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
  diagnosticId: 'reference-projection',
})

function stop(detail: Detail, message: string): never {
  throw new Refused(problem(detail, message))
}

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Refused(outcome.error)
  return outcome.value
}

function parse<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const checked = validateRuntime(name, value)
  return checked.ok ? checked.value : stop('invalid_request', `${name} is malformed`)
}

const dataRef = (
  schema: Wire.SchemaRef,
  value: Wire.JsonValue,
): Extract<Wire.DataRef, { kind: 'inline' }> => ({
  kind: 'inline',
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: Buffer.byteLength(jcs(value)),
})

const sameRef = (left: Wire.SchemaRef, right: Wire.SchemaRef) =>
  left.typeId === right.typeId && left.revision === right.revision && left.digest === right.digest

/** The registration a reference store serves; the same public shapes an author declares. */
export type ReferenceDomain = Readonly<{
  domainType: string
  stateSchema: Wire.SchemaRef
  readStateSchema: Wire.SchemaRef
  viewSchema: Wire.SchemaRef
  commandStateSchema: Wire.SchemaRef
  onCommittedTypes: readonly string[]
  readerPolicy: Readonly<{
    capability: string
    rules: readonly Readonly<{ pointer: string; resourcePointer: string; operation: string }>[]
  }>
  reducer: DomainReducer
  selector: DomainSelector
  checkReadState(value: Wire.JsonValue): boolean
  listQuery: Wire.DataRef
  commands: ReadonlyMap<
    string,
    Readonly<{
      inputSchema: Wire.SchemaRef
      resultSchema: Wire.SchemaRef
      completion: 'domain-commit' | 'runtime-accepted'
      handler: DomainCommandHandler
    }>
  >
}>

export type ReferenceProjectionOptions = Readonly<{
  binding: Wire.BindingRef
  authorityId: Wire.Id
  domain: ReferenceDomain
  access: Readonly<{
    grant(
      capability: string,
      scope: Wire.ScopeRef,
      context: CallContext,
    ): Promise<Outcome<{ readerId: string; role: string }>>
    allows(operation: string, resource: Wire.JsonValue, context: CallContext): Promise<boolean>
    canReadResource(resource: Wire.ArtifactViewRef, context: CallContext): Promise<boolean>
  }>
  native: Readonly<{
    head(sessionId: string): { generation: number; upto: number }
    page(
      sessionId: string,
      beforeIndex: number | null,
      limit: number,
      context: CallContext,
    ): Promise<Outcome<Wire.UIOpeningResult>>
  }>
  turnOf?(event: Wire.DomainEvent): string | null
  /** Folded events between two stored checkpoints. */
  checkpointEvery?: number
  clock?: Readonly<{ now(): Wire.Timestamp; newId(): Wire.Id }>
}>

/**
 * Every committed event, checkpoints of the folded state, the order a session first saw each event,
 * the command journal and the command state. Reads rebuild from the newest checkpoint and the tail.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (revision INTEGER PRIMARY KEY, seq INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS placements (
  event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL,
  anchor INTEGER NOT NULL, turn_id TEXT
);
CREATE TABLE IF NOT EXISTS commands (request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, handle TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS command_state (one INTEGER PRIMARY KEY CHECK (one = 1), revision INTEGER NOT NULL, value TEXT);
`

type Rebuilt = { revision: number; seq: number; state: Wire.DataRef | null }
type Token = Record<string, string | number | null>
type Placed = { position: number; anchor: number; turnId: string | null }
type Remembered = { grant: string; gone: number; seen: Set<string>; revision: number; cut: string }

const WIDEST_PAGE = 500

/** Splits a JSON pointer; `*` stands alone for each array element and nowhere else. */
function segmentsOf(pointer: string): string[] {
  if (pointer === '') return []
  if (pointer[0] !== '/') throw new Error(`not a JSON pointer: ${pointer}`)
  return pointer
    .slice(1)
    .split('/')
    .map((raw) => {
      const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
      if (segment !== '*' && segment.includes('*')) throw new Error(`unsupported wildcard in ${pointer}`)
      return segment
    })
}

/** Yields each concrete path a pattern reaches with the array indexes its `*` segments took. */
function* walk(
  node: unknown,
  pattern: readonly string[],
  path: (string | number)[] = [],
  taken: number[] = [],
): Generator<{ path: (string | number)[]; value: Wire.JsonValue; taken: number[] }> {
  if (path.length === pattern.length) {
    if (node !== undefined) yield { path, value: node as Wire.JsonValue, taken }
    return
  }
  const segment = pattern[path.length] as string
  if (segment === '*') {
    if (!Array.isArray(node)) return
    for (let index = 0; index < node.length; index++)
      yield* walk(node[index], pattern, [...path, index], [...taken, index])
    return
  }
  if (Array.isArray(node)) {
    if (/^\d+$/.test(segment) && Number(segment) < node.length)
      yield* walk(node[Number(segment)], pattern, [...path, Number(segment)], taken)
  } else if (typeof node === 'object' && node !== null && Object.hasOwn(node, segment)) {
    yield* walk((node as Record<string, unknown>)[segment], pattern, [...path, segment], taken)
  }
}

/** Builds a value from the leaves rules allowed; numeric keys become a dense array in index order. */
function assemble(leaves: readonly { path: (string | number)[]; value: Wire.JsonValue }[]): Wire.JsonValue {
  const whole = leaves.find((leaf) => leaf.path.length === 0)
  if (whole) return whole.value
  const groups = new Map<string | number, { path: (string | number)[]; value: Wire.JsonValue }[]>()
  for (const leaf of leaves) {
    const [head, ...rest] = leaf.path
    if (head === undefined) continue
    groups.set(head, [...(groups.get(head) ?? []), { path: rest, value: leaf.value }])
  }
  const keys = [...groups.keys()]
  if (keys.length > 0 && keys.every((key) => typeof key === 'number'))
    return (keys as number[]).sort((a, b) => a - b).map((key) => assemble(groups.get(key) ?? []))
  return Object.fromEntries(keys.map((key) => [String(key), assemble(groups.get(key) ?? [])]))
}

/**
 * The reference agh.projection provider: a SQLite journal of committed events with folded-state
 * checkpoints. Every read rebuilds the cut it needs from the nearest checkpoint plus the journal
 * after it; cursors are HMAC tokens under a key that never leaves the process.
 */
export function openProjectionStore(path: string, options: ReferenceProjectionOptions) {
  const { domain, access, native, binding } = options
  const every = options.checkpointEvery ?? 32
  const clock = options.clock ?? {
    now: () => new Date().toISOString(),
    newId: () => randomBytes(12).toString('hex'),
  }
  const policy = domain.readerPolicy.rules.map((rule) => ({
    at: segmentsOf(rule.pointer),
    resource: segmentsOf(rule.resourcePointer),
    operation: rule.operation,
  }))
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(TABLES)
  const macKey = randomBytes(32)
  const salt = randomBytes(16).toString('hex')
  const memory = new Map<string, Remembered>()
  let open = true

  const seal = (token: Token) => {
    const payload = Buffer.from(JSON.stringify(token)).toString('base64url')
    return `${payload}.${createHmac('sha256', macKey).update(payload).digest('base64url')}`
  }
  const unseal = (text: string): Token => {
    const [payload = '', mac = ''] = text.split('.')
    const expected = Buffer.from(createHmac('sha256', macKey).update(payload).digest('base64url'))
    const given = Buffer.from(mac)
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      stop('resync_required', 'token was not issued by this projection process')
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Token
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

  /** The cut at `target` folded events, or the newest one; a refused event ends the replay. */
  function rebuild(target = Number.POSITIVE_INFINITY): Rebuilt {
    const base = db
      .prepare(
        'SELECT revision, seq, state FROM checkpoints WHERE revision <= ? ORDER BY revision DESC LIMIT 1',
      )
      .get(Number.isFinite(target) ? target : Number.MAX_SAFE_INTEGER) as
      | { revision: number; seq: number; state: string }
      | undefined
    const cut: Rebuilt = base
      ? { revision: base.revision, seq: base.seq, state: JSON.parse(base.state) as Wire.DataRef | null }
      : { revision: 0, seq: 0, state: null }
    const tail = db.prepare('SELECT seq, record FROM journal WHERE seq > ? ORDER BY seq').iterate(cut.seq)
    for (const row of tail as Iterable<{ seq: number; record: string }>) {
      if (cut.revision >= target) break
      const { event } = JSON.parse(row.record) as Wire.DomainEventRecord
      if (domain.onCommittedTypes.includes(event.typeId)) {
        let next: Outcome<Wire.DataRef>
        try {
          next = domain.reducer.reduce({ state: cut.state, event })
        } catch {
          break
        }
        if (!next.ok || !sameRef(next.value.schema, domain.stateSchema)) break
        cut.state = next.value
        cut.revision++
      }
      cut.seq = row.seq
    }
    return cut
  }

  function checkpoint() {
    const cut = rebuild()
    const last = db.prepare('SELECT MAX(revision) AS revision FROM checkpoints').get() as {
      revision: number | null
    }
    if (cut.revision - (last.revision ?? 0) >= every)
      db.prepare('INSERT OR IGNORE INTO checkpoints (revision, seq, state) VALUES (?, ?, ?)').run(
        cut.revision,
        cut.seq,
        JSON.stringify(cut.state),
      )
  }

  /** Writes records in the caller's transaction and fixes where a session first shows each one. */
  function record(events: readonly Wire.DomainEvent[]) {
    const top = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM journal').get() as { seq: number }
    events.forEach((event, offset) => {
      const seq = top.seq + offset + 1
      const entry: Wire.DomainEventRecord = {
        event,
        authorityId: options.authorityId,
        sequence: seq,
        aggregate: {
          authorityId: options.authorityId,
          typeId: domain.domainType,
          id: 'journal',
          revision: seq,
        },
        fingerprint: canonicalJsonDigest({ eventId: event.eventId, payload: event.payload }),
      }
      db.prepare('INSERT INTO journal (seq, event_id, record) VALUES (?, ?, ?)').run(
        seq,
        event.eventId,
        JSON.stringify(entry),
      )
      if (event.scope.kind !== 'session' || !domain.onCommittedTypes.includes(event.typeId)) return
      const sessionId = event.scope.sessionId
      const after = db
        .prepare('SELECT COALESCE(MAX(position), 0) AS position FROM placements WHERE session_id = ?')
        .get(sessionId) as { position: number }
      db.prepare(
        'INSERT OR IGNORE INTO placements (event_id, session_id, position, anchor, turn_id) VALUES (?, ?, ?, ?, ?)',
      ).run(
        event.eventId,
        sessionId,
        after.position + 1,
        native.head(sessionId).upto,
        options.turnOf?.(event) ?? null,
      )
    })
  }

  const readContext = (call: CallContext, revision: number): ProjectionReadContext => ({
    call,
    snapshot: `${domain.domainType}#${revision}`,
    query: async () => ({ ok: false, error: problem('unsupported', 'no selector queries in the reference') }),
    resolveData: async () => ({ ok: false, error: problem('unsupported', 'no data reads in the reference') }),
  })

  async function readable(state: Wire.DataRef | null, context: CallContext): Promise<Wire.JsonValue> {
    const source = state?.kind === 'inline' ? state.value : null
    const answers = new Map<string, boolean>()
    const leaves: { path: (string | number)[]; value: Wire.JsonValue }[] = []
    for (const rule of policy) {
      for (const hit of walk(source, rule.at)) {
        const picks = [...hit.taken]
        const located = [
          ...walk(
            source,
            rule.resource.map((part) => (part === '*' ? String(picks.shift()) : part)),
          ),
        ]
        const resource = located[0]
        if (!resource) continue
        const question = JSON.stringify([rule.operation, resource.value])
        if (!answers.has(question))
          answers.set(question, await access.allows(rule.operation, resource.value, context))
        if (answers.get(question)) leaves.push({ path: hit.path, value: hit.value })
      }
    }
    return leaves.length === 0 ? {} : assemble(leaves)
  }

  /** The reader's views at a cut: policy, read schema, selector, then schema, scope and resource checks. */
  async function viewsAt(cut: Rebuilt, query: Wire.DomainQuery, context: CallContext) {
    const value = await readable(cut.state, context)
    if (!domain.checkReadState(value)) stop('integrity', 'read state does not satisfy its schema')
    let reply: Outcome<Wire.DomainSelectorSelectAuthorizedResult>
    try {
      reply = await domain.selector.selectAuthorized(
        {
          state: dataRef(domain.readStateSchema, value),
          query: { ...query, cursor: null },
          projectionRevision: cut.revision,
        },
        readContext(context, cut.revision),
      )
    } catch {
      return stop('integrity', 'selector failed')
    }
    const selected = parse('DomainSelectorSelectAuthorizedResult', must(reply))
    const shown: Wire.DomainView[] = []
    for (const view of selected.items) {
      if (view.domainType !== domain.domainType || !sameRef(view.viewSchema, domain.viewSchema))
        stop('integrity', 'selector returned a foreign view')
      const outside = Object.entries(query.scope).some(
        ([field, wanted]) => field !== 'kind' && (view.scope as Record<string, unknown>)[field] !== wanted,
      )
      if (outside) continue
      let allowed = true
      for (const resource of view.resources) allowed &&= await access.canReadResource(resource, context)
      if (allowed) shown.push(view)
    }
    return { shown, complete: selected.complete }
  }

  const grantOf = async (scope: Wire.ScopeRef, context: CallContext) =>
    must(await access.grant(domain.readerPolicy.capability, scope, context))
  const viewKey = `${domain.viewSchema.typeId}#${domain.viewSchema.revision}#${domain.viewSchema.digest}`
  const queryKey = (query: Wire.DomainQuery) =>
    canonicalJsonDigest({ domainType: query.domainType, query: query.query, scope: query.scope })
  const mint = (
    kind: string,
    grant: { readerId: string; role: string },
    query: Wire.DomainQuery,
    revision: number,
    at = 0,
  ) =>
    seal({
      kind,
      who: grant.readerId,
      as: grant.role,
      view: viewKey,
      q: queryKey(query),
      n: query.limit,
      r: revision,
      at,
    })

  /** Opens a projection token: reader drift asks for a resync, a mismatched query is the caller's error. */
  function check(
    text: string,
    kind: string,
    grant: { readerId: string; role: string },
    query: Wire.DomainQuery,
  ) {
    const token = unseal(text)
    if (token.kind !== kind) stop('invalid_request', `expected a ${kind} cursor`)
    if (token.who !== grant.readerId || token.as !== grant.role || token.view !== viewKey)
      stop('resync_required', 'reader access or view schema changed')
    if (token.q !== queryKey(query) || token.n !== query.limit)
      stop('invalid_request', 'cursor is bound to another query')
    return token
  }

  async function firstPage(
    query: Wire.DomainQuery,
    grant: { readerId: string; role: string },
    cut: Rebuilt,
    from: number,
    context: CallContext,
  ) {
    const { shown, complete } = await viewsAt(cut, query, context)
    const end = from + query.limit
    const snapshot: Wire.ProjectionSnapshot = {
      items: shown.slice(from, end),
      cursor: mint('delta', grant, query, cut.revision),
      projectionRevision: cut.revision,
      nextPageCursor: end < shown.length ? mint('page', grant, query, cut.revision, end) : null,
      complete: end >= shown.length && complete,
    }
    return parse('ProjectionSnapshot', snapshot)
  }

  async function snapshot(input: unknown, context: CallContext) {
    const query = parse('DomainQuery', input)
    if (query.domainType !== domain.domainType) stop('invalid_request', 'query names another domain')
    const grant = await grantOf(query.scope, context)
    const cut = rebuild()
    let from = 0
    if (query.cursor !== null) {
      const token = check(query.cursor, 'page', grant, query)
      if (token.r !== cut.revision) stop('resync_required', 'projection moved between pages')
      from = Number(token.at)
    }
    return firstPage(query, grant, cut, from, context)
  }

  async function changes(input: unknown, context: CallContext): Promise<Wire.ProjectionChanges> {
    const { query, afterCursor, limit } = parse('ProjectionChangesRequest', input)
    if (query.cursor !== null || query.limit !== limit || query.domainType !== domain.domainType)
      stop('invalid_request', 'changes takes a cursorless query of the delta page size')
    const granted = await access.grant(domain.readerPolicy.capability, query.scope, context)
    if (!granted.ok) stop('resync_required', 'reader access was revoked')
    const token = check(afterCursor, 'delta', granted.value, query)
    const now = rebuild()
    const since = Number(token.r)
    if (now.revision < since) stop('resync_required', 'projection is behind this cursor')
    if (now.revision === since) return { changes: [], cursor: afterCursor, hasMore: false }
    const then = rebuild(since)
    if (then.revision !== since) stop('resync_required', 'that revision cannot be rebuilt')
    const before = new Map((await viewsAt(then, query, context)).shown.map((view) => [view.viewId, view]))
    const after = (await viewsAt(now, query, context)).shown
    const delta: Wire.DomainViewChange[] = []
    for (const view of after) {
      if (before.get(view.viewId)?.revision !== view.revision) delta.push({ kind: 'upsert', view })
      before.delete(view.viewId)
    }
    for (const gone of before.values())
      delta.push({ kind: 'remove', viewId: gone.viewId, revision: gone.revision, reason: 'removed' })
    let result: Wire.ProjectionChanges
    if (delta.length > limit) {
      const fresh = await firstPage(query, granted.value, now, 0, context)
      result = { changes: [{ kind: 'reset', snapshot: fresh }], cursor: fresh.cursor, hasMore: false }
    } else {
      result = { changes: delta, cursor: mint('delta', granted.value, query, now.revision), hasMore: false }
    }
    const valid = validateProjectionChanges(result)
    return valid.ok ? valid.value : stop('integrity', 'changes failed their own schema')
  }

  const journalOf = (key: string) =>
    db.prepare('SELECT fingerprint, handle FROM commands WHERE request_key = ?').get(key) as
      | { fingerprint: string; handle: string }
      | undefined
  const commandState = () =>
    (db.prepare('SELECT revision, value FROM command_state WHERE one = 1').get() as
      | { revision: number; value: string | null }
      | undefined) ?? { revision: 0, value: null }
  const requestKey = (context: CallContext, requestId: string) =>
    canonicalJsonDigest({
      principal: context.principalRef,
      scope: context.scope,
      owner: domain.domainType,
      requestId,
    })
  const mayRead = async (context: CallContext) => {
    const granted = await access.grant(domain.readerPolicy.capability, context.scope, context)
    if (!granted.ok) stop('permission_denied', 'caller may not read this domain')
  }

  async function command(input: unknown, context: CallContext): Promise<Wire.CommandHandle> {
    const request = parse('DomainCommandRequest', input)
    const { action, requestId, expectedRevision, commandSchema } = request
    const key = requestKey(context, requestId)
    const fingerprint = canonicalJsonDigest({
      action,
      commandSchema,
      input: canonicalJsonDigest(request.input),
      expectedRevision,
    })
    await mayRead(context)
    const known = journalOf(key)
    if (known) {
      if (known.fingerprint !== fingerprint) stop('idempotency_conflict', 'request id names another command')
      return JSON.parse(known.handle) as Wire.CommandHandle
    }
    const listing = await viewsAt(rebuild(), listingQuery(context.scope), context)
    const target = listing.shown.find((view) => view.viewId === action.viewId)
    const offered = target?.actions.find((candidate) => candidate.actionKey === action.actionKey)
    if (!target || !offered) stop('not_found', 'no such action in the authorized projection')
    if (target.revision !== action.viewRevision) stop('revision_conflict', 'view moved past that revision')
    if (offered.kind !== 'command') stop('invalid_request', 'action is not a command')
    if (offered.availability !== 'enabled') stop('blocked', offered.disabledReason ?? 'action is disabled')
    if (offered.requiredFeatures.length > 0) stop('unsupported', 'the reference negotiates no features')
    const registered = domain.commands.get(offered.command) ?? stop('not_found', 'command is not registered')
    const business = { action, input: request.input, requestId, expectedRevision, commandSchema }
    if (!validateDomainCommandSchemas(business, offered.inputSchema, registered.inputSchema).ok)
      stop('invalid_request', 'command schemas disagree')
    // ponytail: no dispatch outbox here, so only domain-commit commands; the default owns runtime acceptance.
    if (registered.completion !== 'domain-commit')
      stop('unsupported', 'the reference commits domain commands only')
    const state = commandState()
    if (state.revision !== expectedRevision) stop('revision_conflict', 'command state moved')
    const commandId = clock.newId()
    const prepared = await registered.handler.prepare(
      {
        commandId,
        requestId,
        name: offered.command,
        commandSchema,
        input: request.input,
        state: state.value === null ? null : (JSON.parse(state.value) as Wire.DataRef),
        stateRevision: state.revision,
        expectedRevision,
        sourceView: action,
        observedAt: clock.now(),
        context: {
          principalRef: context.principalRef,
          scope: context.scope,
          bindingId: context.bindingId,
          invocationId: context.invocationId,
          deadline: context.deadline,
          traceRef: context.traceRef,
          authorizationRef: context.authorizationRef,
        },
      },
      readContext(context, state.revision),
    )
    const plan = parse('DomainCommandPlan', must(prepared))
    if (plan.expectedRevision !== state.revision)
      stop('revision_conflict', 'plan was made for another revision')
    if (
      !sameRef(plan.state.schema, domain.commandStateSchema) ||
      !sameRef(plan.result.schema, registered.resultSchema)
    )
      stop('invalid_request', 'plan state or result uses another schema')
    if (plan.dispatches.length > 0) stop('unsupported', 'the reference has no dispatch outbox')
    const now = clock.now()
    const events = plan.events.map((intent) => {
      if (intent.typeId !== intent.schema.typeId || !sameRef(intent.schema, intent.payload.schema))
        stop('invalid_request', 'event type and schema disagree')
      return parse('DomainEvent', {
        eventId: clock.newId(),
        typeId: intent.typeId,
        schema: intent.schema,
        source: binding,
        scope: context.scope,
        occurredAt: now,
        payload: intent.payload,
        idempotencyKey: intent.idempotencyKey,
        causation: { commandId },
        principalRef: context.principalRef,
        correlationId: context.traceRef,
        provenance: { sourceRefs: [], producer: binding, trustLabels: [] },
      })
    })
    const handle = parse('CommandHandle', {
      commandId,
      requestId,
      revision: 1,
      completion: 'domain-commit',
      status: 'succeeded',
      result: plan.result,
      error: null,
    })
    const stored = transact(() => {
      const raced = journalOf(key)
      if (raced) return raced
      if (commandState().revision !== expectedRevision)
        stop('revision_conflict', 'command state moved during prepare')
      db.prepare(
        'INSERT INTO command_state (one, revision, value) VALUES (1, ?, ?) ON CONFLICT(one) DO UPDATE SET revision = excluded.revision, value = excluded.value',
      ).run(expectedRevision + 1, JSON.stringify(plan.state))
      record(events)
      db.prepare('INSERT INTO commands (request_key, fingerprint, handle) VALUES (?, ?, ?)').run(
        key,
        fingerprint,
        JSON.stringify(handle),
      )
      return undefined
    })
    if (stored) {
      if (stored.fingerprint !== fingerprint) stop('idempotency_conflict', 'request id names another command')
      return JSON.parse(stored.handle) as Wire.CommandHandle
    }
    checkpoint()
    return handle
  }

  function listingQuery(scope: Wire.ScopeRef): Wire.DomainQuery {
    return { domainType: domain.domainType, query: domain.listQuery, scope, cursor: null, limit: WIDEST_PAGE }
  }

  async function commandStatus(input: unknown, context: CallContext): Promise<Wire.CommandHandle> {
    const requestId = parse('DomainCommandClientCommandStatusRequest', input)
    await mayRead(context)
    const known = journalOf(requestKey(context, requestId))
    if (known) return JSON.parse(known.handle) as Wire.CommandHandle
    return {
      requestId,
      status: 'not-accepted',
      commandId: null,
      revision: null,
      completion: null,
      result: null,
      error: null,
    }
  }

  /** A conversation window page; `page` is the opened history token, or null for the newest page. */
  async function conversation(sessionId: string, limit: number, page: Token | null, context: CallContext) {
    if (!Number.isInteger(limit) || limit < 1 || limit > WIDEST_PAGE)
      stop('invalid_request', 'window limit is out of range')
    const outer = context.scope
    let scope: Wire.ScopeRef
    if (outer.kind === 'workspace') scope = { ...outer, kind: 'session', sessionId }
    else if (outer.kind === 'session' && outer.sessionId === sessionId) scope = outer
    else return stop('permission_denied', 'that session is outside the caller scope')
    const granted = await access.grant(domain.readerPolicy.capability, scope, context)
    if (!granted.ok) {
      for (const key of memory.keys()) if (key.startsWith(`${context.principalRef}\n`)) memory.delete(key)
      throw new Refused(granted.error)
    }
    const grant = granted.value
    if (page && (page.who !== grant.readerId || page.as !== grant.role))
      stop('resync_required', 'reader access changed')
    const placedRows = db
      .prepare('SELECT event_id, position, anchor, turn_id FROM placements WHERE session_id = ?')
      .all(sessionId) as { event_id: string; position: number; anchor: number; turn_id: string | null }[]
    const placed = new Map<string, Placed>(
      placedRows.map((row) => [
        row.event_id,
        { position: row.position, anchor: row.anchor, turnId: row.turn_id },
      ]),
    )
    const listed = await viewsAt(rebuild(), listingQuery(scope), context)
    const entries = listed.shown
      .map((view) => {
        const first = view.source.eventIds
          .map((eventId) => placed.get(eventId))
          .reduce<Placed | undefined>(
            (best, next) => (next && (!best || next.position < best.position) ? next : best),
            undefined,
          )
        const id = `domain:${canonicalJsonDigest({ domainType: view.domainType, scope: view.scope, viewId: view.viewId })}`
        return first ? { ...first, id, view } : undefined
      })
      .filter((entry) => entry !== undefined)
      .sort((left, right) => left.position - right.position)
    const head = native.head(sessionId)
    const slot = `${context.principalRef}\n${sessionId}`
    const grantText = JSON.stringify([grant.readerId, grant.role])
    let mind = memory.get(slot)
    if (!mind || mind.grant !== grantText) {
      mind = { grant: grantText, gone: 0, seen: new Set(), revision: 0, cut: '' }
      memory.set(slot, mind)
    }
    const present = new Set(entries.map((entry) => entry.id))
    for (const id of mind.seen) if (!present.has(id)) mind.gone++
    mind.seen = present
    const cut = JSON.stringify([
      head.generation,
      head.upto,
      entries.map((entry) => `${entry.id}@${entry.view.revision}`),
    ])
    if (cut !== mind.cut) {
      mind.cut = cut
      mind.revision++
    }
    const epoch = canonicalJsonDigest({
      salt,
      sessionId,
      grant: grantText,
      generation: head.generation,
      gone: mind.gone,
    })
    if (page && page.epoch !== epoch) stop('resync_required', 'this window epoch has ended')

    const nativeBefore = page ? (page.nb as number | null) : null
    const domainBefore = page ? (page.db as number | null) : null
    const pending = entries.filter((entry) => domainBefore === null || entry.position < domainBefore)
    const fetched = must(await native.page(sessionId, nativeBefore, limit, context))
    if (fetched.timeline.generation !== head.generation)
      stop('resync_required', 'native history was regenerated')
    // Walk back from the newest item: a domain entry goes after every native node at or before its anchor.
    const nodes = fetched.timeline.nodes
    const seqOf = (index: number): number => {
      for (let at = index; at >= 0; at--) {
        const node = nodes[at]
        if (node && 'seq' in node) return node.seq
      }
      return 0
    }
    let nodeAt = nodes.length - 1
    let entryAt = pending.length - 1
    const picked: ({ kind: 'native'; id: string } | { kind: 'domain'; id: string; position: number })[] = []
    while (picked.length < limit && (nodeAt >= 0 || entryAt >= 0)) {
      const entry = pending[entryAt]
      const node = nodes[nodeAt]
      if (entry && (!node || entry.anchor >= seqOf(nodeAt))) {
        picked.unshift({ kind: 'domain', id: entry.id, position: entry.position })
        entryAt--
      } else if (node) {
        picked.unshift({ kind: 'native', id: node.id })
        nodeAt--
      }
    }
    const nativeTaken = picked.filter((item) => item.kind === 'native').length
    const shown =
      nativeTaken === nodes.length
        ? fetched
        : must(await native.page(sessionId, nativeBefore, nativeTaken, context))
    const domainPicked = picked.flatMap((item) => (item.kind === 'domain' ? [item.position] : []))
    const oldest = domainPicked[0] ?? domainBefore
    const domainLeft = entries.some((entry) => oldest === null || entry.position < oldest)
    const more = shown.history.hasEarlier || domainLeft
    const pickedIds = new Set(picked.map((item) => item.id))
    const window = {
      sessionId,
      epoch,
      revision: mind.revision,
      native: shown,
      domains: entries
        .filter((entry) => pickedIds.has(entry.id))
        .map((entry) => ({ kind: 'domain' as const, id: entry.id, view: entry.view, turnId: entry.turnId })),
      order: picked.map((item) => ({ kind: item.kind, id: item.id })),
      orderCursor: seal({
        kind: 'order',
        who: grant.readerId,
        as: grant.role,
        s: sessionId,
        epoch,
        r: mind.revision,
      }),
      nextPageCursor: more
        ? seal({
            kind: 'window',
            who: grant.readerId,
            as: grant.role,
            s: sessionId,
            epoch,
            nb: shown.history.startIndex,
            db: oldest,
          })
        : null,
      complete: !more,
    }
    return parse('RuntimeConversationWindow', window)
  }

  const entry =
    <T>(work: (input: unknown, context: CallContext) => T | Promise<T>) =>
    async (input: unknown, context: CallContext): Promise<Outcome<T>> => {
      if (!open) return { ok: false, error: problem('backend_unavailable', 'projection store is closed') }
      if (context.signal.aborted) return { ok: false, error: problem('cancelled', 'call was cancelled') }
      try {
        return { ok: true, value: await work(input, context) }
      } catch (caught) {
        return {
          ok: false,
          error: caught instanceof Refused ? caught.error : problem('internal_error', 'projection failed'),
        }
      }
    }

  const methods = {
    snapshot: entry(snapshot),
    changes: entry(changes),
    command: entry(command),
    acceptCommand: entry(command),
    commandStatus: entry(commandStatus),
    openConversation: entry((input, context) => {
      const request = parse('ShellConversationClientOpenRequest', input)
      return conversation(request.sessionId, request.limit, null, context)
    }),
    conversationHistory: entry((input, context) => {
      const request = parse('ShellConversationClientHistoryRequest', input)
      const token = unseal(request.cursor)
      if (token.kind !== 'window') stop('invalid_request', 'history takes a window page token')
      if (token.s !== request.sessionId) stop('invalid_request', 'token belongs to another session')
      return conversation(request.sessionId, request.limit, token, context)
    }),
    listConversations: entry(
      (): Wire.PageConversationSummary => stop('unsupported', 'the reference lists no conversations'),
    ),
  }
  const reads = [
    'snapshot',
    'changes',
    'commandStatus',
    'openConversation',
    'conversationHistory',
    'listConversations',
  ] as const

  return {
    binding,
    ...methods,
    async query(request: Wire.ServiceQuery, context: CallContext): Promise<Outcome<Wire.QueryReply>> {
      const name = reads.find((candidate) => candidate === request.method)
      if (!name)
        return { ok: false, error: problem('operation_not_supported', `${request.method} is not a query`) }
      const refs = RuntimeMethodSchemaRefs['agh.projection'][name]
      if (request.input.kind !== 'inline' || !sameRef(request.input.schema, refs.input))
        return { ok: false, error: problem('invalid_request', 'input does not carry the method schema') }
      const answered = await (
        methods[name] as (input: unknown, context: CallContext) => Promise<Outcome<unknown>>
      )(request.input.value, context)
      if (!answered.ok) return answered
      const output = dataRef(refs.output, answered.value as Wire.JsonValue)
      return { ok: true, value: { kind: 'value', output, snapshot: output.digest } }
    },
    /** The reference's own write entry: commits events to the journal and folds a checkpoint when due. */
    append(events: readonly Wire.DomainEvent[]) {
      if (!open) stop('backend_unavailable', 'projection store is closed')
      transact(() => record(events))
      checkpoint()
    },
    /** Stored checkpoints, oldest first; a test reads them to see the rebuild base. */
    checkpoints: () =>
      db.prepare('SELECT revision, seq FROM checkpoints ORDER BY revision').all() as {
        revision: number
        seq: number
      }[],
    close() {
      if (!open) return
      open = false
      memory.clear()
      db.close()
    },
  }
}

export type ProjectionStore = ReturnType<typeof openProjectionStore>
