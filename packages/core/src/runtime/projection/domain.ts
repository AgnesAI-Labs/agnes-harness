import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateProjectionChanges, validateRuntime } from '@agnes/protocol/runtime'
import { fail } from './commands.js'

/** What the reader policy granted: the authorized domain and the role reading it. */
export type ReaderGrant = Readonly<{ readerId: string; role: string }>

export type ProjectionState = Readonly<{ state: Wire.DataRef; projectionRevision: number }>

/** Changes after a revision, or a request to rebuild the reader from a fresh snapshot. */
export type ProjectionDelta =
  | Readonly<{
      kind: 'changes'
      changes: readonly Wire.DomainViewChange[]
      projectionRevision: number
      hasMore: boolean
    }>
  | Readonly<{ kind: 'reset' }>

export type DomainProjectionPorts = Readonly<{
  domainType: string
  readStateSchema: Wire.SchemaRef
  viewSchema: Wire.SchemaRef
  /** The reader policy, consulted first on every call. */
  authorize(query: Wire.DomainQuery, context: CallContext): Promise<Outcome<ReaderGrant>>
  readState(query: Wire.DomainQuery, context: CallContext): Promise<Outcome<ProjectionState>>
  select(
    request: Wire.DomainSelectorSelectAuthorizedRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.DomainSelectorSelectAuthorizedResult>>
  /** A gap or a revision no longer retained is a conflict/resync_required refusal. */
  changes(
    query: Wire.DomainQuery,
    afterRevision: number,
    limit: number,
    context: CallContext,
  ): Promise<Outcome<ProjectionDelta>>
  canReadResource(resource: Wire.ArtifactViewRef, context: CallContext): Promise<boolean>
}>

type CursorKind = 'page' | 'delta'
type CursorBody = Readonly<{
  kind: CursorKind
  reader: string
  role: string
  schema: Wire.SchemaRef
  query: Wire.Digest
  limit: number
  revision: number
  offset: number
}>

const resync = (message: string) => fail('resync_required', message)

/**
 * Authorized projection rules. Cursors are issued and signed here with a key that lives only in this
 * process, so a cursor from before a restart always asks the reader to resynchronize.
 */
export function createDomainProjection(ports: DomainProjectionPorts) {
  const secret = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  // The secret sorts after the body, so this is a keyed digest rather than a length-extendable prefix.
  const sign = (body: string) => canonicalJsonDigest({ body, secret })
  // Cursor and limit stay out; reader, role and schema are bound beside it in every cursor.
  const queryDigest = (query: Wire.DomainQuery) =>
    canonicalJsonDigest({ domainType: query.domainType, query: query.query, scope: query.scope })

  function issue(
    kind: CursorKind,
    grant: ReaderGrant,
    query: Wire.DomainQuery,
    revision: number,
    offset = 0,
  ) {
    const body: CursorBody = {
      kind,
      reader: grant.readerId,
      role: grant.role,
      schema: ports.viewSchema,
      query: queryDigest(query),
      limit: query.limit,
      revision,
      offset,
    }
    const json = jcs(body)
    return `${sign(json)}.${json}`
  }

  function open(cursor: string, kind: CursorKind, grant: ReaderGrant, query: Wire.DomainQuery) {
    const dot = cursor.indexOf('.')
    const json = cursor.slice(dot + 1)
    if (dot < 0 || cursor.slice(0, dot) !== sign(json))
      return resync('cursor was not issued by this projection')
    const body = JSON.parse(json) as CursorBody
    if (body.kind !== kind) return fail('invalid_request', 'page and delta cursors are not interchangeable')
    if (
      body.reader !== grant.readerId ||
      body.role !== grant.role ||
      jcs(body.schema) !== jcs(ports.viewSchema)
    )
      return resync('reader access or view schema changed since this cursor')
    if (body.query !== queryDigest(query) || body.limit !== query.limit)
      return fail('invalid_request', 'cursor belongs to another query or page size')
    return { ok: true as const, value: body }
  }

  async function read(query: Wire.DomainQuery, context: CallContext): Promise<Outcome<ProjectionState>> {
    const state = await ports.readState(query, context)
    if (!state.ok) return state
    return jcs(state.value.state.schema) === jcs(ports.readStateSchema)
      ? state
      : fail('integrity', 'projection state does not use the read state schema')
  }

  const inside = (view: Wire.DomainView, scope: Wire.ScopeRef) =>
    Object.entries(scope).every(
      ([field, value]) => field === 'kind' || (view.scope as Record<string, unknown>)[field] === value,
    )

  /** Rechecks views after the selector; a hidden view is dropped whole, fallback text included. */
  async function visible(views: readonly Wire.DomainView[], query: Wire.DomainQuery, context: CallContext) {
    const shown: Wire.DomainView[] = []
    const hidden: Wire.DomainView[] = []
    for (const view of views) {
      if (view.domainType !== ports.domainType || jcs(view.viewSchema) !== jcs(ports.viewSchema))
        return fail('integrity', 'selector produced a view outside this domain schema')
      let readable = inside(view, query.scope)
      for (const resource of view.resources)
        readable = readable && (await ports.canReadResource(resource, context))
      ;(readable ? shown : hidden).push(view)
    }
    return { ok: true as const, value: { shown, hidden } }
  }

  async function page(
    query: Wire.DomainQuery,
    grant: ReaderGrant,
    state: ProjectionState,
    offset: number,
    context: CallContext,
  ): Promise<Outcome<Wire.ProjectionSnapshot>> {
    const selected = await ports.select(
      { state: state.state, query: { ...query, cursor: null }, projectionRevision: state.projectionRevision },
      context,
    )
    if (!selected.ok) return selected
    const result = validateRuntime('DomainSelectorSelectAuthorizedResult', selected.value)
    if (!result.ok) return fail('integrity', 'selector result does not match its schema')
    const checked = await visible(result.value.items, query, context)
    if (!checked.ok) return checked
    const end = offset + query.limit
    const more = end < checked.value.shown.length
    const snapshot = validateRuntime('ProjectionSnapshot', {
      items: checked.value.shown.slice(offset, end),
      cursor: issue('delta', grant, query, state.projectionRevision),
      projectionRevision: state.projectionRevision,
      nextPageCursor: more ? issue('page', grant, query, state.projectionRevision, end) : null,
      complete: !more && result.value.complete,
    })
    return snapshot.ok ? snapshot : fail('internal_error', 'projection snapshot failed its own schema')
  }

  return {
    async snapshot(request: unknown, context: CallContext): Promise<Outcome<Wire.ProjectionSnapshot>> {
      const parsed = validateRuntime('DomainQuery', request)
      if (!parsed.ok) return fail('invalid_request', 'query does not match its schema')
      const query = parsed.value
      if (query.domainType !== ports.domainType) return fail('invalid_request', 'query names another domain')
      const grant = await ports.authorize(query, context)
      if (!grant.ok) return grant
      const state = await read(query, context)
      if (!state.ok) return state
      let offset = 0
      if (query.cursor !== null) {
        const cursor = open(query.cursor, 'page', grant.value, query)
        if (!cursor.ok) return cursor
        if (cursor.value.revision !== state.value.projectionRevision)
          return resync('projection moved since the first snapshot page')
        offset = cursor.value.offset
      }
      return page(query, grant.value, state.value, offset, context)
    },

    async changes(request: unknown, context: CallContext): Promise<Outcome<Wire.ProjectionChanges>> {
      const parsed = validateRuntime('ProjectionChangesRequest', request)
      if (!parsed.ok) return fail('invalid_request', 'changes request does not match its schema')
      const { query, afterCursor, limit } = parsed.value
      if (query.cursor !== null)
        return fail('invalid_request', 'changes reads deltas; query.cursor must be null')
      if (query.limit !== limit) return fail('invalid_request', 'query.limit must equal the delta page size')
      if (query.domainType !== ports.domainType) return fail('invalid_request', 'query names another domain')
      const grant = await ports.authorize(query, context)
      if (!grant.ok) return resync('reader access was revoked')
      const after = open(afterCursor, 'delta', grant.value, query)
      if (!after.ok) return after
      const state = await read(query, context)
      if (!state.ok) return state
      const from = after.value.revision
      if (state.value.projectionRevision < from) return resync('projection is behind this cursor')
      if (state.value.projectionRevision === from)
        return { ok: true, value: { changes: [], cursor: afterCursor, hasMore: false } }
      const delta = await ports.changes(query, from, limit, context)
      if (!delta.ok) return delta
      let output: Wire.ProjectionChanges
      if (delta.value.kind === 'reset') {
        const snapshot = await page({ ...query, cursor: null }, grant.value, state.value, 0, context)
        if (!snapshot.ok) return snapshot
        output = {
          changes: [{ kind: 'reset', snapshot: snapshot.value }],
          cursor: snapshot.value.cursor,
          hasMore: false,
        }
      } else {
        const { changes, projectionRevision, hasMore } = delta.value
        const upserts = changes.flatMap((change) => (change.kind === 'upsert' ? [change.view] : []))
        const checked = await visible(upserts, query, context)
        if (!checked.ok) return checked
        const hidden = new Set(checked.value.hidden)
        output = {
          // A view the reader may no longer see leaves the reader's set instead of keeping stale content.
          changes: changes.map((change) =>
            change.kind === 'upsert' && hidden.has(change.view)
              ? {
                  kind: 'remove',
                  viewId: change.view.viewId,
                  revision: change.view.revision,
                  reason: 'hidden',
                }
              : change,
          ),
          cursor: issue('delta', grant.value, query, projectionRevision),
          hasMore,
        }
      }
      const valid = validateProjectionChanges(output)
      return valid.ok
        ? valid
        : fail('integrity', valid.errors[0]?.message ?? 'projection changes are inconsistent')
    },
  }
}

export type DomainProjection = ReturnType<typeof createDomainProjection>
