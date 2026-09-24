import { randomUUID } from 'node:crypto'
import { type Host, type HostSession, loadSessionTitle, type WorkspaceBinding } from '@agnes/host'
import { type EventEnvelope, rpcError } from '@agnes/protocol'
import type { PreviewSnapshotEntry, PreviewUpdate, Registry } from '../registry.js'
import type { JsonRpcId } from '../rpc.js'
import { assertWorkspaceBindingEnvelope, type WorkspaceBindingEnvelope } from '../storage/workspaces.js'
import type { SessionLister, SessionMetaRow } from './ports.js'
import { type Disposer, tailSession } from './tail.js'

export type SessionEntry = {
  key: string
  session: HostSession
  generation: number
  inflight: { promptId: JsonRpcId; abort: AbortController } | null
  tail: Disposer
  listeners: Set<(e: EventEnvelope) => void>
  backlog: EventEnvelope[]
  backlogTruncated: boolean
  tailError: unknown
  /** What listeners threw, oldest first and bounded. Nothing acts on these in I1; they exist so a
   *  contained failure is recorded somewhere rather than only not crashing. */
  listenerErrors: unknown[]
  ac: AbortController
  /** Set when lookups hand out a new object per call: whether `other` wraps the same entry. */
  sameEntry?(other: SessionEntry): boolean
}

// Rows that arrive before anyone has subscribed are held here rather than dropped. open() starts the
// tail at once, so the first poll normally reads session/start before a handler has had a chance to
// subscribe, and `last` then advances past it: without the hold, the first subscriber's stream would
// silently begin partway through. Bounded, because a session nobody ever subscribes to must not grow
// without limit; on overflow the flag tells session.attach to replay from the ledger instead.
const BACKLOG_MAX = 2000
// Bounded for the same reason the backlog is: a listener that throws on every row must not turn one
// broken consumer into unbounded memory.
const LISTENER_ERRORS_MAX = 100

function sameBinding(a: WorkspaceBinding | undefined, b: WorkspaceBinding | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.sessionKey === b.sessionKey &&
    a.workspaceId === b.workspaceId &&
    a.authorityRevision === b.authorityRevision &&
    a.canonicalRoot === b.canonicalRoot
  )
}

export class SessionRegistry implements Registry<SessionEntry> {
  private readonly entries = new Map<string, SessionEntry>()
  private readonly bindings = new Map<string, WorkspaceBinding>()
  private readonly previewSets = new Map<string, Set<(p: PreviewUpdate) => void>>()
  private readonly opening = new Map<
    string,
    {
      cwd: string
      preset: string | null
      binding: WorkspaceBinding | undefined
      promise: Promise<SessionEntry>
    }
  >()
  constructor(
    private readonly host: Host,
    private readonly o: {
      clock: () => number
      pollMs?: number
      observe?: (sessionKey: string, event: EventEnvelope, cwd: string) => void
    },
  ) {}

  // `generation` is 1 in the local form: there is no lease handover here, so nothing can advance it.
  // The daemon form reads it from `writer_claims` instead. The consequence worth writing down is
  // that GENERATION_STALE is today reachable only from a client that sends a number other than 1 -
  // never from a real handover - so the attach test proves the check and not the scenario. The
  // daemon form is where it first means something.
  async open(o: {
    key?: string
    cwd: string
    binding?: WorkspaceBindingEnvelope
    preset?: string
    credential?: unknown
  }): Promise<SessionEntry> {
    const accepted = this.acceptBinding(o.binding, o.key)
    const request = {
      ...(o.key ? { key: o.key } : {}),
      cwd: o.cwd,
      ...(o.preset ? { preset: o.preset } : {}),
      ...(o.credential === undefined ? {} : { credential: o.credential }),
      ...(accepted ? { key: accepted.sessionKey, binding: accepted } : {}),
    }
    if (request.key) {
      const existing = this.entries.get(request.key)
      if (existing) {
        if (
          existing.session.d.cwd !== request.cwd ||
          (request.preset !== undefined && existing.session.preset.name !== request.preset) ||
          !sameBinding(this.bindings.get(request.key), request.binding)
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: request.key })
        return existing
      }
      const pending = this.opening.get(request.key)
      if (pending) {
        if (
          pending.cwd !== request.cwd ||
          pending.preset !== (request.preset ?? null) ||
          !sameBinding(pending.binding, request.binding)
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: request.key })
        return pending.promise
      }
      const promise = this.openFresh(request)
      this.opening.set(request.key, {
        cwd: request.cwd,
        preset: request.preset ?? null,
        binding: request.binding,
        promise,
      })
      try {
        return await promise
      } finally {
        if (this.opening.get(request.key)?.promise === promise) this.opening.delete(request.key)
      }
    }
    return this.openFresh(request)
  }

  private async openFresh(o: {
    key?: string
    cwd: string
    binding?: WorkspaceBinding
    preset?: string
    credential?: unknown
  }): Promise<SessionEntry> {
    const session = await this.host.createSession(o)
    return this.track(session, o.cwd, o.binding)
  }

  async fork(o: {
    parent: string
    at: number
    childKey?: string
    binding?: WorkspaceBindingEnvelope
    credential?: unknown
  }): Promise<SessionEntry> {
    const parent = this.require(o.parent)
    const childKey = o.childKey ?? o.binding?.sessionKey ?? `agnes:fork:${randomUUID()}`
    const binding = this.acceptBinding(o.binding, childKey)
    const existing = this.entries.get(childKey)
    if (existing) {
      const ancestry = existing.session.d.log.parent
      if (
        ancestry?.key === o.parent &&
        ancestry.boundarySeq === o.at &&
        sameBinding(this.bindings.get(childKey), binding)
      )
        return existing
      throw rpcError('SEMANTIC_REJECTED', { reason: 'child key already names another session' })
    }
    const timeline = await parent.session.projectUI()
    if (timeline.opState !== null)
      throw rpcError('SESSION_BUSY', { sessionId: o.parent, reason: 'fork requires an idle parent' })
    const [boundary] = await parent.session.scan({ fromSeq: o.at, toSeq: o.at, limit: 1 })
    const end = boundary?.data as { reason?: unknown } | undefined
    if (boundary?.type !== 'turn/end' || end?.reason !== 'completed')
      throw rpcError('SEMANTIC_REJECTED', { reason: 'fork boundary must be a completed turn/end' })
    const session = await this.host.createSession({
      key: childKey,
      cwd: parent.session.d.cwd,
      ...(binding ? { binding } : {}),
      parent: { key: o.parent, boundarySeq: o.at },
      ...(o.credential === undefined ? {} : { credential: o.credential }),
    })
    return this.track(session, parent.session.d.cwd, binding)
  }

  private acceptBinding(
    envelope: WorkspaceBindingEnvelope | undefined,
    requestedKey: string | undefined,
  ): WorkspaceBinding | undefined {
    if (!envelope) return undefined
    assertWorkspaceBindingEnvelope(envelope)
    return this.host.acceptWorkspaceBinding(envelope, requestedKey ?? envelope.sessionKey)
  }

  private track(session: HostSession, cwd: string, binding?: WorkspaceBinding): SessionEntry {
    const ac = new AbortController()
    const entry: SessionEntry = {
      key: session.key,
      session,
      generation: 1,
      inflight: null,
      tail: () => undefined,
      listeners: new Set(),
      backlog: [],
      backlogTruncated: false,
      tailError: null,
      listenerErrors: [],
      ac,
    }
    if (binding) this.bindings.set(session.key, binding)
    // Live streamed text. Unlike events there is no backlog: a preview nobody hears is simply gone.
    const previewListeners = new Set<(p: PreviewUpdate) => void>()
    this.previewSets.set(session.key, previewListeners)
    const offPreview = session.onPreview((p) => {
      for (const l of previewListeners) {
        try {
          l(p)
        } catch {
          // One viewer failing must not starve the others of the stream.
        }
      }
    })
    ac.signal.addEventListener('abort', offPreview, { once: true })
    entry.tail = tailSession(session, {
      fromSeq: 1,
      pollMs: this.o.pollMs ?? 50,
      signal: ac.signal,
      onError: (e) => {
        entry.tailError = e
      },
      onEvents: (evs) => {
        for (const e of evs) {
          // Package-internal observers see every row without becoming a client subscription. Using
          // `subscribe()` here would drain the first subscriber's backlog and make session/start or
          // early prompt rows disappear from the actual ACP feed.
          this.o.observe?.(entry.key, e, cwd)
          if (entry.listeners.size === 0) {
            entry.backlog.push(e)
            if (entry.backlog.length > BACKLOG_MAX) {
              entry.backlog.shift()
              entry.backlogTruncated = true
            }
            continue
          }
          // Each listener in its own try: one listener is one connection's whole subscription, and
          // letting its failure out of this loop skipped every listener after it and then killed the
          // tail that called us.
          //
          // Ruling: a listener that throws is NOT detached. The cut this package already has - the
          // overload path - tells the client it happened, and a client that is told can re-attach
          // with a cursor. Nothing tells a client it was dropped for throwing, so detaching would
          // leave a connection silently subscribed to nothing. The cost is that a permanently broken
          // listener goes on being called once per event and its stream keeps holes it is never told
          // about; the failures are recorded on the entry, and acting on them is I1 debt.
          for (const l of entry.listeners) {
            try {
              l(e)
            } catch (err) {
              if (entry.listenerErrors.length < LISTENER_ERRORS_MAX) entry.listenerErrors.push(err)
            }
          }
        }
      },
    })
    this.entries.set(session.key, entry)
    return entry
  }

  get(key: string): SessionEntry | undefined {
    return this.entries.get(key)
  }

  require(key: string): SessionEntry {
    const e = this.entries.get(key)
    if (!e) throw rpcError('SESSION_NOT_FOUND', { sessionId: key })
    return e
  }

  subscribe(key: string, fn: (e: EventEnvelope) => void): Disposer {
    const e = this.require(key)
    const first = e.listeners.size === 0
    e.listeners.add(fn)
    if (first) for (const held of e.backlog.splice(0)) fn(held)
    return () => {
      e.listeners.delete(fn)
    }
  }

  // A local session's previews reach every subscriber directly, so there is never a gap to report.
  subscribePreview(key: string, fn: (p: PreviewUpdate) => void, _gap?: () => void): Disposer {
    this.require(key)
    const set = this.previewSets.get(key)
    set?.add(fn)
    return () => {
      set?.delete(fn)
    }
  }

  async previewSnapshot(key: string): Promise<PreviewSnapshotEntry[]> {
    return this.require(key).session.previewSnapshot()
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  async close(key: string): Promise<void> {
    const e = this.entries.get(key)
    if (!e) return
    // Forgotten first: an await between "stop the tail" and "forget the key" is a window in which a
    // handler can still resolve this key and subscribe to a session that is closing.
    this.entries.delete(key)
    this.bindings.delete(key)
    this.previewSets.delete(key)
    // A transport close must stop the turn before Host waits for the session's workspace
    // invocation to drain. Otherwise a parked approval callback can keep endpoint shutdown open
    // forever even though its client has already disconnected.
    e.inflight?.abort.abort()
    e.ac.abort()
    e.tail()
    await e.session.close()
  }

  async closeAll(): Promise<void> {
    for (const k of this.keys()) await this.close(k)
  }
}

/**
 * The in-process `SessionLister`: every session this registry currently holds open, no storage scan
 * involved. The plan this was drafted from read `e.session.latest('session/start')` for the preset
 * name - `session/start` is not one of core's six registers (it is folded straight into
 * `LedgerState.session`, never into `registersCache`), so `latest()` would always answer `undefined`
 * and every row would report `preset: null`. `SessionImpl.preset` is a public field that is live and
 * current - it is exactly what `setPreset`/`setModel` mutate - so it is read directly instead.
 *
 * Wired to the `_agnes/v1/session.list` RPC handler in `methods/agnes.ts` as the default `cx.lister`
 * (`index.ts`). Its own query/page shape (`{ q?: string; cwd?: string; cursor?: string; limit?: number }` in,
 * `{ items, cursor? }` out) is this class's own, not the wire's - `SessionListParams.q` is a
 * three-field filter object and `PageSessionMeta`'s continuation field is `next`, not `cursor`; the
 * RPC handler is where that translation happens. cwd is the one wire filter retained separately,
 * because a live Host session records it and silently ignoring an exact workspace query would mix
 * unrelated task trees.
 */
export class RegistryLister implements SessionLister {
  constructor(private readonly reg: SessionRegistry) {}
  async list(q: {
    q?: string
    cwd?: string
    cursor?: string
    limit?: number
    sessionIds?: readonly string[]
  }): Promise<{
    items: SessionMetaRow[]
    cursor?: string
  }> {
    const scope = q.sessionIds ? new Set(q.sessionIds) : undefined
    const items: SessionMetaRow[] = this.reg
      .keys()
      .filter((k) => !scope || scope.has(k))
      .filter((k) => !q.q || k.includes(q.q))
      .filter((k) => q.cwd === undefined || this.reg.get(k)?.session.d.cwd === q.cwd)
      .map((k) => {
        const e = this.reg.get(k) as SessionEntry
        return {
          sessionId: k,
          createdAt: '',
          lastSeq: e.session.lastSeq,
          generation: e.generation,
          preset: e.session.preset.name,
          cwd: e.session.d.cwd,
        }
      })
    const offset = q.cursor ? Number(q.cursor) : 0
    const limit = q.limit ?? 50
    const page = items.slice(offset, offset + limit)
    await Promise.all(
      page.map(async (row) => {
        const session = this.reg.get(row.sessionId)?.session
        if (!session) return
        const start = (await session.scan({ type: 'session/start', order: 'desc', limit: 1 }))[0]
        const title = await loadSessionTitle(session, start?.seq ?? 1)
        if (title?.status === 'generated') row.title = title.title
      }),
    )
    return { items: page, ...(offset + limit < items.length ? { cursor: String(offset + limit) } : {}) }
  }
}
