import { randomUUID } from 'node:crypto'
import type { Disposer } from '@agnes/daemon-foundation/local/tail'
import type { PreviewSnapshotEntry, PreviewUpdate, Registry } from '@agnes/daemon-foundation/registry'
import type { SessionWorkspacePort } from '@agnes/daemon-foundation/storage/lister'
import type { SessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import {
  assertWorkspaceBindingEnvelope,
  type WorkspaceBindingEnvelope,
} from '@agnes/daemon-foundation/storage/workspaces'
import type { LoopSelection } from '@agnes/protocol'
import { type EventEnvelope, rpcError, SESSION_ARTIFACT_ROOT_EVENT_TYPES } from '@agnes/protocol'
import { type HistoryConsumer, historyIndex, readRange } from './open-history.js'
import { RemoteSession } from './remote-session.js'
import type { WorkerPool } from './worker-pool.js'

type ReplayFrame = { event: EventEnvelope; beforePublish?: () => void; onWire?: () => void }

export type RegistryOptions = Readonly<{
  /** Caught up on a session's sidebar row when it opens; the row may lag its ledger. */
  workspaces?: Pick<SessionWorkspacePort, 'refresh'>
  /** Consumers of ledger rows; an open feeds each the history rows of the types it lists. */
  history?: readonly HistoryConsumer[]
}>

export type ArtifactAuthorityLifecycle = Readonly<{
  observe(sessionId: string, event: unknown, signal: AbortSignal): Promise<void>
  resetSession(sessionId: string): void
}>

type RemoteOpen = Readonly<{
  cwd: string
  binding: WorkspaceBindingEnvelope
  preset?: string
  permission?: string
  agent?: string
  agentDigest?: string
  bundles?: readonly string[]
  systemPromptAppend?: string
  loop?: LoopSelection
  credential?: unknown
  parent?: string
  forkAt?: number
  resume?: boolean
  historySignal?: AbortSignal
  onHistoryProgress?: (progress: { verifiedSeq: number; lastSeq: number }) => void
}>

function withoutOpeningObservers(open: RemoteOpen): RemoteOpen {
  const { onHistoryProgress: _progress, historySignal: _signal, ...rest } = open
  return rest
}

export type RemoteEntry = {
  key: string
  session: RemoteSession
  generation: number
  inflight: { promptId: unknown; abort: AbortController } | null
  listeners: Set<(e: EventEnvelope) => void>
  tail: Disposer
  ac: AbortController
  recover: boolean
  reopen: RemoteOpen
}

type PreviewSubscriber = { preview: (p: PreviewUpdate) => void; gap: (() => void) | undefined }
/**
 * The worker-backed analogue of `local/sessions.ts`'s `SessionRegistry`: same method shape
 * (open / get / require / subscribe / keys / close / closeAll), but a session it holds is a
 * `RemoteSession` proxy over a `WorkerPool`-acquired link instead of an in-process `HostSession`.
 * Both classes now formally `implements Registry<...>` against the shared interface in
 * `../registry.js` - see that file's doc comment for why `open`'s parameter type there is the
 * narrower of the two classes' real parameter types (this class accepts three more optional fields
 * that `SessionRegistry` does not).
 * `SupervisorRegistry` presents these entries to the shared ACP/Agnes RPC layer, while this class
 * retains the worker-specific lifecycle and generation fields.
 */
export class WorkerRegistry implements Registry<RemoteEntry> {
  private readonly entries = new Map<string, RemoteEntry>()
  // `session/load` from two clients can race on a cold key. Keep one acquisition and one entry
  // identity for that key so both callers share the same worker link and inflight state.
  private readonly opening = new Map<string, { epoch: number; promise: Promise<RemoteEntry> }>()
  private readonly recovering = new Map<string, Promise<void>>()
  /** Explicit close advances this fence so an already-started recovery cannot publish later. */
  private readonly sessionEpochs = new Map<string, number>()
  private closingAll = false
  /** Stable listener identity survives a worker generation replacement for the same session. */
  private readonly listenerSets = new Map<string, Set<(e: EventEnvelope) => void>>()
  /** Preview listeners outlive a worker generation the same way event listeners do. */
  private readonly previewSets = new Map<string, Set<PreviewSubscriber>>()
  private readonly openListeners: Array<(key: string) => void> = []
  /** Specific old session generations awaiting replacement after a resource snapshot changed, each
   *  tagged with the reason its retirement was requested (threaded through to `WorkerPool.retire()`
   *  so ops logs can tell a full-snapshot retire apart from a narrow notify-failure retire -- see
   *  `retireForResourceSnapshot` vs `retireSessions`). */
  private readonly resourceRetirements = new Map<string, { entry: RemoteEntry; reason: string }>()
  /** Replay and live projection share one ordered chain per session. */
  private readonly artifactQueues = new Map<string, Promise<void>>()
  /** Highest contiguous ledger sequence already applied to artifact authority for each live
   * session. A same-turn media read commonly arrives after its tool/result was delivered and
   * projected; remembering that fact avoids asking the same worker to scan while it is blocked
   * waiting for the media-read reply. */
  private readonly artifactProjectedThrough = new Map<string, number>()
  /** Media reads can overtake the ledger tail frame that grants their authority. Wait for that
   * already-committed frame instead of scanning the same worker: the worker is blocked awaiting the
   * media reply, and a scan command may need the session lock held by that run. */
  private readonly artifactProjectionWaiters = new Map<
    string,
    Set<{ through: number; resolve(): void; reject(error: Error): void }>
  >()
  /**
   * A worker starts its ledger tail as soon as the start gate opens, so live frames can arrive while
   * `openFresh()` is still reading the session's history. Awaiting such a frame on `artifactQueues`
   * would put the scan reply behind a promise which itself waits for that reply. Hold the frames as
   * plain data until the history has been handled, then project and publish them in wire order
   * before exposing the opened session.
   */
  private readonly artifactReplayBuffers = new Map<string, ReplayFrame[]>()
  /** The highest seq offered to a session's listeners; they outlive the entries that fed them. */
  private readonly publishedThrough = new Map<string, number>()
  private readonly history: ReturnType<typeof historyIndex>
  private readonly authorityTypes: ReadonlySet<string>
  /** Fences a worker that began opening against a snapshot that has since been superseded. */
  private resourceEpoch = 0
  private readonly generationMigrations = new Set<string>()

  /** Refuse live/opening sessions and fence all admissions for this key until pin migration settles. */
  async migrateGeneration<T>(
    key: string,
    principalId: string,
    ownership: Pick<SessionPrincipalOwnership, 'resolve'>,
    migrate: () => Promise<T>,
  ): Promise<T> {
    let owner: ReturnType<SessionPrincipalOwnership['resolve']>
    try {
      owner = ownership.resolve(key)
    } catch {
      /* fail closed below */
    }
    if (owner?.principalId !== principalId)
      throw rpcError('CAPABILITY_DENIED', { reason: 'session owner unavailable' })
    if (
      this.closingAll ||
      this.entries.has(key) ||
      this.opening.has(key) ||
      this.generationMigrations.has(key)
    )
      throw new Error('E_GENERATION_SESSION_OPEN: close the session before migration')
    this.generationMigrations.add(key)
    try {
      return await migrate()
    } finally {
      this.generationMigrations.delete(key)
    }
  }

  constructor(
    private readonly pool: WorkerPool,
    private readonly artifactAuthority?: ArtifactAuthorityLifecycle,
    private readonly options: RegistryOptions = {},
  ) {
    this.authorityTypes = new Set(artifactAuthority ? SESSION_ARTIFACT_ROOT_EVENT_TYPES : [])
    this.history = historyIndex(options.history ?? [], [...this.authorityTypes])
  }

  /** Wired to `WorkerPool`'s `onEvent` option: one worker event, routed to its session's listeners
   *  and folded into that session's `lastSeq` / register cache. */
  deliver(
    sessionKey: string,
    e: EventEnvelope,
    beforePublish?: () => void,
    onWire?: () => void,
  ): void | Promise<void> {
    const replayBuffer = this.artifactReplayBuffers.get(sessionKey)
    if (replayBuffer) {
      // `onWire` waits with its row: its consumers have just been fed the history in ledger order.
      replayBuffer.push({
        event: e,
        ...(beforePublish ? { beforePublish } : {}),
        ...(onWire ? { onWire } : {}),
      })
      return
    }
    onWire?.()
    if (this.artifactAuthority) {
      const queued = (this.artifactQueues.get(sessionKey) ?? Promise.resolve()).then(async () => {
        const entry = this.entries.get(sessionKey)
        if (!entry || entry.ac.signal.aborted) throw new Error('artifact authority session is unavailable')
        await this.artifactAuthority?.observe(sessionKey, e, entry.ac.signal)
        if (entry.ac.signal.aborted || this.entries.get(sessionKey) !== entry)
          throw new Error('artifact authority session is unavailable')
        this.artifactProjectedThrough.set(
          sessionKey,
          Math.max(this.artifactProjectedThrough.get(sessionKey) ?? 0, e.seq),
        )
        this.resolveArtifactProjectionWaiters(sessionKey)
        beforePublish?.()
        this.publish(sessionKey, e)
      })
      this.artifactQueues.set(sessionKey, queued)
      return queued
    }
    beforePublish?.()
    this.publish(sessionKey, e)
  }

  /** Wait until the ordered worker tail has projected the exact row used for request media. */
  async ensureArtifactAuthority(sessionKey: string, eventSeq: number): Promise<void> {
    if (!this.artifactAuthority || !Number.isSafeInteger(eventSeq) || eventSeq < 1)
      throw new Error('artifact authority event is unavailable')
    const entry = this.entries.get(sessionKey)
    if (!entry || entry.ac.signal.aborted) throw new Error('artifact authority session is unavailable')
    // Drain only work that was already queued when the request arrived. Do not put this wait on the
    // projection queue itself, or the incoming tool/result that satisfies it would sit behind it.
    await (this.artifactQueues.get(sessionKey) ?? Promise.resolve())
    if (entry.ac.signal.aborted || this.entries.get(sessionKey) !== entry)
      throw new Error('artifact authority session is unavailable')
    if ((this.artifactProjectedThrough.get(sessionKey) ?? 0) >= eventSeq) return

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const waiters = this.artifactProjectionWaiters.get(sessionKey) ?? new Set()
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.ac.signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.artifactProjectionWaiters.delete(sessionKey)
        if (error) reject(error)
        else resolve()
      }
      const waiter = {
        through: eventSeq,
        resolve: () => finish(),
        reject: (error: Error) => finish(error),
      }
      const onAbort = () => finish(new Error('artifact authority session is unavailable'))
      const timer = setTimeout(() => finish(new Error('artifact authority event is unavailable')), 2_000)
      timer.unref()
      waiters.add(waiter)
      this.artifactProjectionWaiters.set(sessionKey, waiters)
      entry.ac.signal.addEventListener('abort', onAbort, { once: true })
      // No await occurs between the prior high-water check and registration, but keep this second
      // check so future synchronous projection hooks cannot introduce a lost wake-up.
      this.resolveArtifactProjectionWaiters(sessionKey)
    })
  }

  private resolveArtifactProjectionWaiters(sessionKey: string): void {
    const waiters = this.artifactProjectionWaiters.get(sessionKey)
    if (!waiters) return
    const through = this.artifactProjectedThrough.get(sessionKey) ?? 0
    for (const waiter of [...waiters]) if (through >= waiter.through) waiter.resolve()
  }

  private rejectArtifactProjectionWaiters(sessionKey: string): void {
    const waiters = this.artifactProjectionWaiters.get(sessionKey)
    if (!waiters) return
    for (const waiter of [...waiters]) waiter.reject(new Error('artifact authority session is unavailable'))
  }

  /**
   * Wired to `WorkerPool`'s `onPreview`: live streamed text for a session. It rides behind any
   * event still being projected for artifact authority so it cannot overtake the row that opened
   * its stream; while authority replay is holding events back, the preview is dropped instead, and
   * subscribers catch up from a snapshot once the open completes.
   */
  deliverPreview(sessionKey: string, p: PreviewUpdate): void {
    const listeners = this.previewSets.get(sessionKey)
    if (!listeners || listeners.size === 0) return
    if (this.artifactReplayBuffers.has(sessionKey)) return
    const fire = (): void => {
      for (const l of listeners) {
        try {
          l.preview(p)
        } catch {
          // One viewer failing must not starve the others of the stream.
        }
      }
    }
    const queued = this.artifactQueues.get(sessionKey)
    if (queued) void queued.then(fire, () => undefined)
    else fire()
  }

  subscribePreview(key: string, fn: (p: PreviewUpdate) => void, gap?: () => void): Disposer {
    this.require(key)
    const set = this.previewSets.get(key) ?? new Set<PreviewSubscriber>()
    this.previewSets.set(key, set)
    const subscriber = { preview: fn, gap }
    set.add(subscriber)
    return () => {
      set.delete(subscriber)
      if (set.size === 0 && this.previewSets.get(key) === set) this.previewSets.delete(key)
    }
  }

  previewSnapshot(key: string): Promise<PreviewSnapshotEntry[]> {
    return this.require(key).session.previewSnapshot()
  }

  private publish(sessionKey: string, e: EventEnvelope): void {
    const en = this.entries.get(sessionKey)
    if (!en) return
    en.session.observe(e)
    en.session.observeRegister(e)
    this.publishedThrough.set(sessionKey, Math.max(this.publishedThrough.get(sessionKey) ?? 0, e.seq))
    for (const l of en.listeners) l(e)
  }

  async open(o: {
    key?: string
    cwd: string
    binding?: WorkspaceBindingEnvelope
    preset?: string
    permission?: string
    agent?: string
    agentDigest?: string
    bundles?: readonly string[]
    systemPromptAppend?: string
    loop?: LoopSelection
    credential?: unknown
    historySignal?: AbortSignal
    onHistoryProgress?: (progress: { verifiedSeq: number; lastSeq: number }) => void
    parent?: string
    forkAt?: number
    resume?: boolean
  }): Promise<RemoteEntry> {
    if (o.agent === undefined) o = { ...o, permission: o.permission ?? 'default' }
    if (this.closingAll) throw new Error('worker registry is shutting down')
    if (o.key && this.generationMigrations.has(o.key))
      throw new Error('E_GENERATION_SESSION_OPEN: session migration is in progress')
    assertWorkspaceBindingEnvelope(o.binding)
    const authorized: RemoteOpen = { ...o, binding: o.binding }
    const key = o.key ?? `agnes:local:default:daemon:dm:${Math.random().toString(36).slice(2)}`
    const epoch = this.sessionEpochs.get(key) ?? 0
    const existing = this.entries.get(key)
    if (existing) {
      if (
        o.agent !== undefined &&
        (o.agent !== existing.reopen.agent || o.agentDigest !== existing.reopen.agentDigest)
      )
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: key })
      if (o.bundles !== undefined && JSON.stringify(o.bundles) !== JSON.stringify(existing.reopen.bundles))
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: key })
      if (o.systemPromptAppend !== undefined && o.systemPromptAppend !== existing.reopen.systemPromptAppend)
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: key })
      return existing
    }
    const pending = this.opening.get(key)
    if (pending?.epoch === epoch) {
      const entry = await pending.promise
      if (
        o.agent !== undefined &&
        (o.agent !== entry.reopen.agent || o.agentDigest !== entry.reopen.agentDigest)
      )
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: key })
      if (o.systemPromptAppend !== undefined && o.systemPromptAppend !== entry.reopen.systemPromptAppend)
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: key })
      return entry
    }
    const opening = this.openFresh(key, authorized, epoch)
    const record = { epoch, promise: opening }
    this.opening.set(key, record)
    try {
      return await opening
    } finally {
      if (this.opening.get(key) === record) this.opening.delete(key)
    }
  }

  /**
   * Brings the daemon's view of a session that has just opened up to its ledger head. The worker only
   * pushes rows after `head`; the history before it is read once, by the types its consumers react
   * to, so the cost follows those rows rather than the length of the ledger. Rows that arrived on the
   * wire meanwhile wait in `replayBuffer` and are handled afterwards, in wire order.
   */
  private async catchUpHistory(o: {
    key: string
    entry: RemoteEntry
    session: RemoteSession
    head: number
    generation: number
    replayBuffer: ReplayFrame[]
  }): Promise<void> {
    const { key, entry, session, head, replayBuffer } = o
    const current = (): void => {
      if (this.entries.get(key) !== entry || entry.ac.signal.aborted)
        throw new Error('artifact authority session is unavailable')
    }
    const scan = (q: Record<string, unknown>) => session.scan(q)
    const project = (seq: number): void => {
      this.artifactProjectedThrough.set(key, Math.max(this.artifactProjectedThrough.get(key) ?? 0, seq))
      this.resolveArtifactProjectionWaiters(key)
    }
    if (this.history.types.length > 0)
      await readRange(scan, { fromSeq: 1, toSeq: head, types: this.history.types }, async (event) => {
        current()
        if (this.artifactAuthority && this.authorityTypes.has(event.type)) {
          await this.artifactAuthority.observe(key, event, entry.ac.signal)
          project(event.seq)
        }
        for (const consumer of this.history.byType.get(event.type) ?? [])
          consumer.observe(key, event, o.generation)
      })
    // Only rows that can create authority were read, and every one up to `head` has been handled.
    if (this.artifactAuthority) project(head)
    // Listeners outlive the worker generation that fed them: offer them the rows they have not seen.
    const published = this.publishedThrough.get(key)
    if (published !== undefined && published < head && entry.listeners.size > 0)
      await readRange(scan, { fromSeq: published + 1, toSeq: head }, (event) => {
        current()
        this.publish(key, event)
      })
    this.publishedThrough.set(key, Math.max(published ?? 0, head))
    await session.primeRegisters(head)
    // The sidebar row may lag the ledger (history written while it was not being indexed).
    await this.options.workspaces?.refresh(key, session, o.generation).catch(() => undefined)
    // Draining may yield while projecting. Any frame that arrives during that await is appended to
    // the same array and is picked up by this loop before the replay buffer is removed. Walk it by
    // index: shifting a long buffer re-copies the array once per frame.
    for (let index = 0; index < replayBuffer.length; index++) {
      const buffered = replayBuffer[index] as ReplayFrame
      current()
      buffered.onWire?.()
      // A frame the worker repeats from before `head` was projected by the read above.
      if (this.artifactAuthority && buffered.event.seq > head) {
        await this.artifactAuthority.observe(key, buffered.event, entry.ac.signal)
        project(buffered.event.seq)
      }
      current()
      buffered.beforePublish?.()
      this.publish(key, buffered.event)
    }
  }

  private async openFresh(key: string, o: RemoteOpen, sessionEpoch: number): Promise<RemoteEntry> {
    const isCurrent = (): boolean => !this.closingAll && (this.sessionEpochs.get(key) ?? 0) === sessionEpoch
    if (!isCurrent()) throw new Error(`session ${key} was closed while opening`)
    const existing = this.entries.get(key)
    if (existing) return existing
    const resourceEpoch = this.resourceEpoch
    // Detach stale in-memory scope before replay. resetSession bumps the projection epoch before
    // touching durable rows, so an old asynchronous observe cannot resurrect authority.
    this.artifactAuthority?.resetSession(key)
    this.rejectArtifactProjectionWaiters(key)
    this.artifactProjectedThrough.delete(key)
    const link = await this.pool.acquire(key, {
      resume: o.resume ?? false,
      ...(o.historySignal ? { historySignal: o.historySignal } : {}),
      ...(o.onHistoryProgress ? { onHistoryProgress: o.onHistoryProgress } : {}),
      cwd: o.cwd,
      binding: o.binding,
      ...(o.preset ? { preset: o.preset } : {}),
      ...(o.permission ? { permission: o.permission } : {}),
      ...(o.agent !== undefined ? { agent: o.agent } : {}),
      ...(o.agentDigest !== undefined ? { agentDigest: o.agentDigest } : {}),
      ...(o.bundles !== undefined ? { bundles: o.bundles } : {}),
      ...(o.systemPromptAppend !== undefined ? { systemPromptAppend: o.systemPromptAppend } : {}),
      ...(o.loop ? { loop: o.loop } : {}),
      ...(o.parent && o.forkAt !== undefined ? { parent: { key: o.parent, boundarySeq: o.forkAt } } : {}),
    })
    if (!isCurrent()) {
      await link.closeSession('session closed while opening').catch(() => undefined)
      throw new Error(`session ${key} was closed while opening`)
    }
    const hello = await link.hello
    if (!isCurrent()) {
      await link.closeSession('session closed while opening').catch(() => undefined)
      throw new Error(`session ${key} was closed while opening`)
    }
    // The history up to the head is read by type once the session is open; the worker pushes what follows.
    const head = hello.lastSeq
    if (!Number.isSafeInteger(head) || head < 0) {
      await link.closeSession('worker reported no ledger head').catch(() => undefined)
      throw new Error(`worker reported no ledger head for session ${key}`)
    }
    let entry: RemoteEntry | undefined
    const session = new RemoteSession(key, hello.writerRunId, hello.generation, link, o.cwd, () => {
      if (entry) this.retireAtTurnBoundary(key, entry)
    })
    session.lastSeq = head
    const registry = this
    let inflight: RemoteEntry['inflight'] = null
    const listeners = this.listenerSets.get(key) ?? new Set<(e: EventEnvelope) => void>()
    this.listenerSets.set(key, listeners)
    entry = {
      key,
      session,
      generation: hello.generation,
      get inflight() {
        return inflight
      },
      set inflight(value) {
        inflight = value
        if (value === null) registry.retireAtTurnBoundary(key)
      },
      listeners,
      tail: () => undefined,
      ac: new AbortController(),
      recover: true,
      reopen: withoutOpeningObservers(o),
    }
    this.entries.set(key, entry)
    link.onExit(() =>
      this.interruptEntry(
        key,
        entry as RemoteEntry,
        withoutOpeningObservers(o),
        new Error('worker link closed'),
      ),
    )
    // The shared worker may emit events while tail() is still acknowledging its subscription.
    this.artifactReplayBuffers.set(key, [])
    try {
      if (!link.alive) throw new Error(`worker link closed while opening session ${key}`)
      const tail = (link as unknown as { tail?: (fromSeq: number) => Promise<void> }).tail
      // The history up to `head` is read by type below; the worker pushes what comes after it.
      if (tail) await tail.call(link, head + 1)
      if (!isCurrent()) throw new Error(`session ${key} was closed while opening`)
      // This worker read its resources before hello. If a control operation committed while it was
      // opening, never publish that old-snapshot generation to a caller; let WorkerPool wait for its
      // close and acquire a replacement from the new durable snapshot.
      if (resourceEpoch !== this.resourceEpoch) {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        entry.ac.abort(new Error('resource snapshot retired while opening'))
        try {
          this.artifactAuthority?.resetSession(key)
        } catch {
          // Scope detachment is best-effort here; the worker is still retired below and the next
          // open resets before replay, so a failed durable cleanup cannot publish stale authority.
        }
        this.artifactQueues.delete(key)
        this.rejectArtifactProjectionWaiters(key)
        this.artifactProjectedThrough.delete(key)
        // Frames this generation already sent for the key (its tail replay, typically) are still
        // queued on the link. Wait for the close to drain them before reopening, with the replay
        // buffer still absorbing them: projected after the entry is gone they would fail the key,
        // and that failure would retire the replacement channel opened next.
        await link.closeSession('resource-snapshot-reload').catch(() => undefined)
        this.artifactReplayBuffers.delete(key)
        return this.openFresh(key, o, sessionEpoch)
      }
      const replayBuffer = this.artifactReplayBuffers.get(key)
      if (!replayBuffer) throw new Error('session history replay is unavailable')
      try {
        await this.catchUpHistory({ key, entry, session, head, generation: hello.generation, replayBuffer })
        this.artifactReplayBuffers.delete(key)
      } catch (error) {
        this.artifactReplayBuffers.delete(key)
        if (this.entries.get(key) === entry) this.entries.delete(key)
        entry.ac.abort(error)
        try {
          this.artifactAuthority?.resetSession(key)
        } catch {
          // The original replay failure is the public startup result; scope is already detached.
        }
        this.pool.retire([key], 'artifact-authority-replay-failed')
        this.rejectArtifactProjectionWaiters(key)
        this.artifactProjectedThrough.delete(key)
        throw error
      }
      if (!isCurrent()) throw new Error(`session ${key} was closed while opening`)
      // Previews were dropped while the replay held events back, and a preview from a generation
      // not yet hosting the session is refused by the pool: viewers that outlived the previous
      // generation catch up now.
      for (const l of this.previewSets.get(key) ?? []) {
        try {
          l.gap?.()
        } catch {
          // One viewer failing must not keep the others from catching up.
        }
      }
      for (const l of this.openListeners) l(key)
      return entry
    } catch (error) {
      // Tail setup and other post-publication startup work can fail while the process remains live.
      // Withdraw this exact generation and close its session channel before exposing the failure.
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
        entry.recover = false
        entry.ac.abort(error)
        this.artifactQueues.delete(key)
        this.rejectArtifactProjectionWaiters(key)
        this.artifactProjectedThrough.delete(key)
        this.artifactReplayBuffers.delete(key)
        if (entry.listeners.size === 0 && this.listenerSets.get(key) === entry.listeners)
          this.listenerSets.delete(key)
        try {
          this.artifactAuthority?.resetSession(key)
        } catch {
          // Preserve the startup failure; authority was detached before its durable cleanup ran.
        }
        await entry.session.close().catch(() => undefined)
      }
      throw error
    }
  }

  async fork(o: {
    parent: string
    at: number
    childKey?: string
    binding?: WorkspaceBindingEnvelope
    credential?: unknown
  }): Promise<RemoteEntry> {
    const parent = this.require(o.parent)
    const parentStatus = await parent.session.status()
    const childKey = o.childKey ?? `agnes:fork:${randomUUID()}`
    const existing = this.entries.get(childKey)
    if (existing) {
      const status = await existing.session.status()
      if (status.parent?.key === o.parent && status.parent.boundarySeq === o.at) return existing
      throw rpcError('SEMANTIC_REJECTED', { reason: 'child key already names another session' })
    }
    const timeline = (await parent.session.projectUI()) as { opState?: unknown }
    if (timeline.opState !== null)
      throw rpcError('SESSION_BUSY', { sessionId: o.parent, reason: 'fork requires an idle parent' })
    const [boundary] = (await parent.session.scan({ fromSeq: o.at, toSeq: o.at, limit: 1 })) as Array<{
      type?: string
      data?: { reason?: unknown }
    }>
    if (boundary?.type !== 'turn/end' || boundary.data?.reason !== 'completed')
      throw rpcError('SEMANTIC_REJECTED', { reason: 'fork boundary must be a completed turn/end' })
    assertWorkspaceBindingEnvelope(o.binding)
    await parent.session.fork(o.at, childKey, o.credential, o.binding)
    try {
      return await this.open({
        key: childKey,
        cwd: parent.session.cwd,
        binding: o.binding,
        ...(parentStatus.preset ? { preset: parentStatus.preset } : {}),
        ...(parentStatus.permission ? { permission: parentStatus.permission } : {}),
        parent: o.parent,
        forkAt: o.at,
        resume: true,
      })
    } catch (error) {
      await this.pool.closeHostedSession?.(childKey, 'fork adoption failed').catch(() => undefined)
      throw error
    }
  }

  onOpen(fn: (key: string) => void): void {
    this.openListeners.push(fn)
  }

  /**
   * Retire every ordinary session generation against the old resource snapshot. Idle sessions are
   * forgotten synchronously so a same-history `session/load` creates a worker from the durable
   * replacement snapshot. Busy sessions are marked and retire only at their terminal turn boundary.
   *
   * A general capability: it still retires *every* live
   * session, unconditionally. Its caller, supervisor.ts's
   * `wireResourceSnapshotNotifications`, prefers the lightweight in-place
   * `resource.stale` notice (@agnes/resource-control-runtime's `notifyLiveSessionWorkers`) and calls
   * this method's narrower sibling, `retireSessions()`, only for sessions whose notice failed to
   * deliver -- see that method's doc comment.
   */
  retireForResourceSnapshot(): void {
    this.markForResourceRetirement(this.entries.keys(), 'resource-snapshot-reload')
  }

  /**
   * Narrower sibling of `retireForResourceSnapshot()`: retires only the sessions named in `keys`,
   * leaving every other live session on its current (already-delivered) resource snapshot untouched.
   * Fallback path for sessions whose lightweight
   * `resource.stale` notice (@agnes/resource-control-runtime's `notifyLiveSessionWorkers`) failed to
   * deliver -- a session that *did* receive the notice needs no process kill/respawn at all.
   *
   * Shares the exact per-key retirement mechanics with `retireForResourceSnapshot()` (see
   * `markForResourceRetirement`); only the key set and the diagnostic `reason` differ. Still bumps
   * `resourceEpoch` on every call -- see `openFresh`'s epoch fence -- because a worker that is
   * mid-`acquire()` when *any* resource snapshot commits was never a candidate for the lightweight
   * notification in the first place (it has no registered activation link yet, so it cannot appear in
   * either the success or the failure list) and must still be discarded on an epoch mismatch,
   * regardless of which already-live sessions this particular call retires.
   */
  retireSessions(keys: readonly string[], reason: string): void {
    this.markForResourceRetirement(keys, reason)
  }

  /**
   * Record that a resource snapshot durably committed, retiring nothing. This is the epoch half of
   * `retireSessions()` on its own, and it is what the daemon's wiring (supervisor.ts's
   * `wireResourceSnapshotNotifications`) calls on *every* commit.
   *
   * The two concerns are genuinely independent and must not be coupled: which live sessions need
   * retiring depends on whose lightweight `resource.stale` notice failed to deliver, while
   * `openFresh`'s fence protects a worker that is mid-`acquire()` - already spawned, its snapshot
   * file already read, no hello yet - which by definition appears in neither the delivered nor the
   * failed set and so can never be named in a retirement call. Before this existed the bump only ever
   * happened inside `markForResourceRetirement`, i.e. only when some session's notice had failed, so
   * on the common all-delivered path a mid-`acquire()` worker came up on the superseded snapshot and
   * stayed there until its process was replaced for some unrelated reason.
   */
  noteResourceSnapshotCommitted(): void {
    this.resourceEpoch++
  }

  private markForResourceRetirement(keys: Iterable<string>, reason: string): void {
    this.noteResourceSnapshotCommitted()
    for (const key of keys) {
      const entry = this.entries.get(key)
      if (!entry) continue
      this.resourceRetirements.set(key, { entry, reason })
      this.retireAtTurnBoundary(key, entry)
    }
  }

  /** Called by the turn lifecycle and the ACP inflight-clear path. */
  retireAtTurnBoundary(key: string, expected?: RemoteEntry): void {
    const retirement = this.resourceRetirements.get(key)
    if (!retirement || (expected && retirement.entry !== expected)) return
    const entry = this.entries.get(key)
    if (!entry || entry !== retirement.entry) {
      this.resourceRetirements.delete(key)
      return
    }
    if (entry.inflight || entry.session.running) return
    // Forget before close. This prevents a same-history prompt from being handed a closing link;
    // WorkerPool.acquire() will create its replacement from the current daemon snapshot.
    entry.ac.abort(new Error('resource snapshot retired'))
    entry.recover = false
    this.listenerSets.delete(key)
    try {
      this.artifactAuthority?.resetSession(key)
    } catch {
      // resetSession detaches the live scope before durable cleanup; retirement must still forget
      // this generation so a cleanup failure cannot keep stale authority reachable.
    }
    this.artifactQueues.delete(key)
    this.rejectArtifactProjectionWaiters(key)
    this.artifactProjectedThrough.delete(key)
    this.artifactReplayBuffers.delete(key)
    this.entries.delete(key)
    this.resourceRetirements.delete(key)
    this.pool.retire([key], retirement.reason)
  }

  get(key: string): RemoteEntry | undefined {
    return this.entries.get(key)
  }

  /**
   * Whether the writer `runId` of `key` is alive here: this daemon's entry was opened as that writer,
   * or an open for the key is in flight and will take the lease over.
   */
  holds(key: string, runId: string): boolean {
    return this.opening.has(key) || this.entries.get(key)?.session.writerRunId === runId
  }

  require(key: string): RemoteEntry {
    const e = this.entries.get(key)
    if (!e) throw rpcError('SESSION_NOT_FOUND', { sessionId: key })
    return e
  }

  subscribe(key: string, fn: (e: EventEnvelope) => void): Disposer {
    const e = this.require(key)
    e.listeners.add(fn)
    return () => e.listeners.delete(fn)
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  // Forgotten first, same as SessionRegistry.close() (local/sessions.ts): an await between "stop
  // trusting this key" and "actually close" is a window in which a handler could still resolve this
  // key and subscribe to a session that is on its way out.
  async close(key: string): Promise<void> {
    this.sessionEpochs.set(key, (this.sessionEpochs.get(key) ?? 0) + 1)
    this.listenerSets.delete(key)
    this.previewSets.delete(key)
    this.publishedThrough.delete(key)
    let firstError: unknown
    try {
      this.artifactAuthority?.resetSession(key)
    } catch (error) {
      firstError = error
    }
    const closeEntry = async (entry: RemoteEntry | undefined): Promise<void> => {
      if (!entry) return
      entry.recover = false
      entry.ac.abort(new Error('session closed'))
      if (this.entries.get(key) === entry) this.entries.delete(key)
      await entry.session.close()
    }
    try {
      await closeEntry(this.entries.get(key))
    } catch (error) {
      firstError ??= error
    }
    const pending = this.opening.get(key)?.promise
    if (pending) await pending.catch(() => undefined)
    try {
      await closeEntry(this.entries.get(key))
    } catch (error) {
      firstError ??= error
    }
    this.artifactQueues.delete(key)
    this.rejectArtifactProjectionWaiters(key)
    this.artifactProjectedThrough.delete(key)
    this.artifactReplayBuffers.delete(key)
    this.resourceRetirements.delete(key)
    if (firstError !== undefined) throw firstError
  }

  async closeAll(): Promise<void> {
    this.closingAll = true
    const keys = new Set([...this.listenerSets.keys(), ...this.entries.keys(), ...this.opening.keys()])
    const closed = await Promise.allSettled([...keys].map((key) => this.close(key)))
    await Promise.allSettled(this.recovering.values())
    const failed = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  /** A session-scoped transport failure closes and durably reopens only that session. */
  interrupt(key: string, reason: unknown): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.interruptEntry(key, entry, entry.reopen, reason)
  }

  private interruptEntry(key: string, entry: RemoteEntry, open: RemoteOpen, reason: unknown): void {
    // A future reconnect may have replaced this key. An old link must not delete the replacement.
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
      entry.ac.abort(reason)
      try {
        this.artifactAuthority?.resetSession(key)
      } catch {
        // The next open resets again before replay; transport callbacks never throw cleanup errors.
      }
      this.artifactQueues.delete(key)
      this.rejectArtifactProjectionWaiters(key)
      this.artifactProjectedThrough.delete(key)
      this.artifactReplayBuffers.delete(key)
    }
    if (this.resourceRetirements.get(key)?.entry === entry) this.resourceRetirements.delete(key)
    // Only a session somebody is still subscribed to is worth reopening eagerly.
    const watched = (): boolean => (this.listenerSets.get(key)?.size ?? 0) > 0
    // An entry that no longer holds the key leaves recovery to the one that does. Starting a
    // recovery here would find the key taken, end at once, and still block the holder's own.
    if (!entry.recover || !watched() || this.recovering.has(key) || this.entries.has(key)) return
    const recovery = (async () => {
      let delayMs = 50
      while (entry.recover && watched() && !this.entries.has(key)) {
        try {
          await this.open({ key, ...open, resume: true })
          return
        } catch {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs)
            timer.unref()
          })
          delayMs = Math.min(delayMs * 2, 1_000)
        }
      }
    })().finally(() => {
      if (this.recovering.get(key) === recovery) this.recovering.delete(key)
    })
    this.recovering.set(key, recovery)
  }
}
