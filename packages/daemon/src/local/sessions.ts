import { randomUUID } from 'node:crypto'
import { type Host, type HostSession, loadSessionTitle, type WorkspaceBinding } from '@agnes/host'
import { type EventEnvelope, rpcError } from '@agnes/protocol'
import type { PreviewSnapshotEntry, PreviewUpdate, Registry, SessionCloseConfirmation } from '../registry.js'
import type { JsonRpcId } from '../rpc.js'
import { assertWorkspaceBindingEnvelope, type WorkspaceBindingEnvelope } from '../storage/workspaces.js'
import type { SessionLister, SessionMetaRow } from './ports.js'
import { type Disposer, tailSession } from './tail.js'

export type SessionEntry = {
  key: string
  session: HostSession
  generation: number
  inflight: { promptId: JsonRpcId; abort: AbortController; settled?: Promise<void> } | null
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
  private readonly closing = new Map<string, Promise<void>>()
  /** Failed owners stay reachable only to close/retry, never to mutation/read handles. */
  private readonly sealed = new Map<string, SessionEntry>()
  private readonly retryableClose = new Set<string>()
  private readonly confirmations = new Map<string, Promise<SessionCloseConfirmation>>()
  private closingAll = false
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
      assertSessionAdmitted?: (sessionId: string) => void
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
    runtime?: string
    credential?: unknown
  }): Promise<SessionEntry> {
    if (this.closingAll) throw new Error('session registry is closing')
    const accepted = this.acceptBinding(o.binding, o.key)
    const request = {
      key: o.key ?? `agnes:local:default:daemon:dm:${randomUUID()}`,
      cwd: o.cwd,
      ...(o.preset ? { preset: o.preset } : {}),
      ...(o.runtime === undefined ? {} : { runtime: o.runtime }),
      ...(o.credential === undefined ? {} : { credential: o.credential }),
      ...(accepted ? { key: accepted.sessionKey, binding: accepted } : {}),
    }
    this.o.assertSessionAdmitted?.(request.key)
    if (request.key) {
      const closing = this.closing.get(request.key)
      if (closing) {
        await closing
        if (this.closing.get(request.key) !== closing) return this.open(o)
        if (!(await this.confirmations.get(request.key))?.exited)
          throw new Error(`session ${request.key} close is unconfirmed`)
        this.closing.delete(request.key)
        this.confirmations.delete(request.key)
      }
      if (this.closingAll) throw new Error('session registry is closing')
      this.o.assertSessionAdmitted?.(request.key)
      const existing = this.entries.get(request.key)
      if (existing) {
        if (
          existing.session.d.cwd !== request.cwd ||
          (request.runtime !== undefined && existing.session.runtimeIdentity.id !== request.runtime) ||
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
        const entry = await pending.promise
        this.o.assertSessionAdmitted?.(request.key)
        if (request.runtime !== undefined && entry.session.runtimeIdentity.id !== request.runtime)
          throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: request.key })
        return entry
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
    runtime?: string
    credential?: unknown
  }): Promise<SessionEntry> {
    if (o.key) this.o.assertSessionAdmitted?.(o.key)
    const session = await this.host.createSession(o)
    const entry = this.track(session, o.cwd, o.binding)
    await this.checkOpenedAdmission(entry)
    if (this.closingAll || this.closing.has(session.key))
      throw new Error(`session ${session.key} was closed while opening`)
    return entry
  }

  private async checkOpenedAdmission(entry: SessionEntry): Promise<void> {
    try {
      this.o.assertSessionAdmitted?.(entry.session.key)
    } catch (error) {
      // Start the same sealed close path, but do not await it here: close itself waits for this
      // opener to settle. Its confirmation retains both the exact owner and any drain failure.
      void this.close(entry.key).catch(() => undefined)
      throw error
    }
  }

  async fork(o: {
    parent: string
    at: number
    childKey?: string
    binding?: WorkspaceBindingEnvelope
    credential?: unknown
  }): Promise<SessionEntry> {
    this.o.assertSessionAdmitted?.(o.parent)
    const key = o.childKey ?? o.binding?.sessionKey ?? `agnes:fork:${randomUUID()}`
    this.o.assertSessionAdmitted?.(key)
    const closing = this.closing.get(key)
    if (closing) {
      await closing
      if (this.closing.get(key) !== closing) return this.fork(o)
      if (!(await this.confirmations.get(key))?.exited) throw new Error(`session ${key} close is unconfirmed`)
      this.closing.delete(key)
      this.confirmations.delete(key)
    }
    if (this.closingAll) throw new Error('session registry is closing')
    if (this.opening.has(key)) throw new Error(`session ${key} is opening`)
    const promise = this.forkFresh({ ...o, childKey: key })
    const record = {
      cwd: this.require(o.parent).session.d.cwd,
      preset: null,
      binding: this.acceptBinding(o.binding, key),
      promise,
    }
    this.opening.set(key, record)
    try {
      return await promise
    } finally {
      if (this.opening.get(key) === record) this.opening.delete(key)
    }
  }

  private async forkFresh(o: {
    parent: string
    at: number
    childKey: string
    binding?: WorkspaceBindingEnvelope
    credential?: unknown
  }): Promise<SessionEntry> {
    this.o.assertSessionAdmitted?.(o.parent)
    this.o.assertSessionAdmitted?.(o.childKey)
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
    this.o.assertSessionAdmitted?.(o.parent)
    this.o.assertSessionAdmitted?.(childKey)
    const session = await this.host.createSession({
      key: childKey,
      cwd: parent.session.d.cwd,
      ...(binding ? { binding } : {}),
      parent: { key: o.parent, boundarySeq: o.at },
      ...(o.credential === undefined ? {} : { credential: o.credential }),
    })
    const entry = this.track(session, parent.session.d.cwd, binding)
    await this.checkOpenedAdmission(entry)
    if (this.closingAll || this.closing.has(childKey))
      throw new Error(`session ${childKey} was closed while opening`)
    return entry
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
    return this.closing.has(key) ? undefined : this.entries.get(key)
  }

  require(key: string): SessionEntry {
    const e = this.get(key)
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
    return [...this.entries.keys()].filter((key) => !this.closing.has(key))
  }

  close(key: string): Promise<void> {
    const prior = this.closing.get(key)
    if (prior && !this.retryableClose.has(key)) return prior
    this.retryableClose.delete(key)
    const initial = this.sealed.get(key) ?? this.entries.get(key)
    this.entries.delete(key)
    let owner: Extract<SessionCloseConfirmation, { exited: true }>['owner'] | undefined
    const closing = (async () => {
      const closeEntry = async (e: SessionEntry | undefined): Promise<void> => {
        if (!e) return
        owner = {
          sessionKey: key,
          writerRunId: e.session.writerRunId,
          generation: e.generation,
          workerGeneration: null,
        }
        this.sealed.set(key, e)
        this.entries.delete(key)
        this.bindings.delete(key)
        this.previewSets.delete(key)
        e.inflight?.abort.abort()
        e.ac.abort()
        e.tail()
        await e.session.close()
        await e.inflight?.settled?.catch(() => undefined)
        if (!e.session.d.log.isClosed) throw new Error(`session ${key} writer drain is unconfirmed`)
        if (this.sealed.get(key) === e) this.sealed.delete(key)
      }
      let failure: unknown
      try {
        await closeEntry(initial)
      } catch (error) {
        failure = error
      }
      await this.opening.get(key)?.promise.catch(() => undefined)
      try {
        await closeEntry(this.entries.get(key))
      } catch (error) {
        failure ??= error
      }
      if (failure !== undefined) throw failure
    })().catch((error) => {
      if (this.sealed.has(key)) this.retryableClose.add(key)
      throw error
    })
    this.closing.set(key, closing)
    this.confirmations.set(
      key,
      closing.then(
        () => (owner ? { exited: true, owner } : { exited: false, reason: 'owner-unknown' }),
        () => ({ exited: false, reason: 'close-failed', ...(owner ? { owner } : {}) }),
      ),
    )
    return closing
  }

  closeAndConfirm(
    key: string,
    expected?: { expectedWriterRunId: string; expectedOwnerEpoch?: number },
  ): Promise<SessionCloseConfirmation> {
    const owner = (this.sealed.get(key) ?? this.entries.get(key))?.session
    if (
      expected &&
      (owner?.writerRunId !== expected.expectedWriterRunId ||
        (expected.expectedOwnerEpoch !== undefined &&
          owner?.d.log.ownerEpoch !== expected.expectedOwnerEpoch))
    )
      return Promise.resolve({ exited: false, reason: 'owner-unknown' })
    void this.close(key).catch(() => undefined)
    return this.confirmations.get(key) ?? Promise.resolve({ exited: false, reason: 'owner-unknown' })
  }

  async closeAll(): Promise<void> {
    this.closingAll = true
    const keys = new Set([
      ...this.entries.keys(),
      ...this.opening.keys(),
      ...this.closing.keys(),
      ...this.sealed.keys(),
    ])
    const results = await Promise.allSettled([...keys].map((key) => this.close(key)))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
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
          runtime: e.session.runtimeIdentity,
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
