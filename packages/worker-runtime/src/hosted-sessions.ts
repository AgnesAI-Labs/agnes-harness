import type { Host, HostSession, WorkspaceBinding } from '@agnes/host'
import type { WorkerGeneration } from '@agnes/protocol'
import { handleCommand, type WorkerResourceSlot } from './commands.js'
import {
  type EventFrame,
  type PreviewFrame,
  parseWorkspaceBinding,
  type SessionCommandFrame,
  type SessionOpenFrame,
  type SessionOpenResult,
} from './frames.js'
import type { SharedSessionChannel } from './shared-session-channel.js'
import { type TailHandle, tailSession } from './tail.js'

type HostedSession = {
  readonly session: HostSession
  readonly aborts: Map<string, AbortController>
  tail?: AbortController
  following?: TailHandle
  /** Entries still working on this session, including those that woke it. */
  inflight: number
  lastActivityAt: number
}

/** What a hibernated session keeps: enough to reopen it, and nothing that grants authority. */
type HibernatedStub = {
  binding: WorkspaceBinding
  parent?: { key: string; boundarySeq: number }
  preset: string
  lastSeq: number
  /** The ledger head read from storage: another writer may append while the session sleeps. */
  head(): Promise<number>
  tailFrom?: number
}

/**
 * `worker.session_idle_close_ms` from a profile's limits: a non-negative whole number of
 * milliseconds, 0 turning hibernation off. Anything else falls back to the default rather than,
 * say, a string becoming a sweep every few milliseconds.
 */
export function sessionIdleCloseMs(limits: Readonly<Record<string, unknown>> | undefined): number {
  const value = limits?.['worker.session_idle_close_ms']
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 600_000
}

/** The session a worker-level command names, under either parameter name commands use for it. */
export function sessionScopedKey(params: Readonly<Record<string, unknown>>): string | undefined {
  const key = params.sessionKey ?? params.sessionId
  return typeof key === 'string' ? key : undefined
}

/** Worker-level commands whose parameters name a session; each wakes that session first. */
export const SESSION_SCOPED_WORKER_METHODS: readonly string[] = ['callService', 'inspectService']

// Commands that change or run a session count as activity; reads, `ping` and a run-less `abort` do not.
const ACTIVE_METHODS = new Set([
  'enqueue',
  'run',
  'append',
  'setPreset',
  'setModel',
  'setYolo',
  'manualCompact',
  'decideApproval',
  'fork',
  'resume',
  'callService',
])

/** Owns every HostSession in the single shared business worker. */
export class HostedSessions {
  private readonly sessions = new Map<string, HostedSession>()
  private readonly opening = new Map<string, Promise<HostedSession>>()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly stubs = new Map<string, HibernatedStub>()
  private readonly hibernating = new Map<string, Promise<void>>()
  private readonly waking = new Map<string, Promise<HostedSession>>()
  private closingAll = false
  private readonly clock: () => number
  private readonly sweeper: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly options: {
      host: Host
      channel: SharedSessionChannel
      send(frame: unknown): void
      workerGeneration: WorkerGeneration
      workspaceRoot: string
      workerResourcesInput?: Parameters<typeof handleCommand>[2]['workerResourcesInput']
      resources?: WorkerResourceSlot
      /** A session idle this long is hibernated; 0 or absent never hibernates. */
      idleCloseMs?: number
      clock?: () => number
    },
  ) {
    this.clock = options.clock ?? (() => Date.now())
    const idle = options.idleCloseMs ?? 0
    if (idle > 0) {
      this.sweeper = setInterval(() => void this.sweep(), Math.min(60_000, Math.max(5_000, idle / 4)))
      this.sweeper.unref()
    }
  }

  keys(): string[] {
    return [...this.sessions.keys()]
  }

  async open(frame: SessionOpenFrame): Promise<SessionOpenResult> {
    if (this.closingAll) throw new Error('shared worker is closing')
    const envelope = parseWorkspaceBinding(frame.params.binding, frame.sessionKey)
    const binding = this.options.host.acceptWorkspaceBinding(envelope, frame.sessionKey)
    const parent = frame.params.parent
    if (
      parent !== undefined &&
      (typeof parent.key !== 'string' ||
        parent.key.length === 0 ||
        !Number.isSafeInteger(parent.boundarySeq) ||
        parent.boundarySeq < 1)
    )
      throw new Error('invalid fork parent')
    const closing = this.closing.get(frame.sessionKey)
    if (closing) await closing
    if (this.closingAll) throw new Error('shared worker is closing')
    if (this.dormant(frame.sessionKey)) {
      const woken = await this.acquire(frame.sessionKey)
      this.assertAuthority(woken.session, binding, parent)
      return this.describe(woken.session)
    }
    const existing = this.sessions.get(frame.sessionKey)
    if (existing) {
      this.assertAuthority(existing.session, binding, parent)
      return this.describe(existing.session)
    }
    const pending = this.opening.get(frame.sessionKey)
    if (pending) {
      const hosted = await pending
      this.assertAuthority(hosted.session, binding, parent)
      return this.describe(hosted.session)
    }
    const opening = this.options.channel.run(frame.sessionKey, async () => {
      const session = await this.options.host.createSession({
        key: frame.sessionKey,
        binding,
        ...(frame.params.preset ? { preset: frame.params.preset } : {}),
        ...(parent ? { parent } : {}),
      })
      const hosted = this.adopt(frame.sessionKey, session)
      return hosted
    })
    this.opening.set(frame.sessionKey, opening)
    try {
      return this.describe((await opening).session)
    } finally {
      if (this.opening.get(frame.sessionKey) === opening) this.opening.delete(frame.sessionKey)
    }
  }

  private describe(session: HostSession): SessionOpenResult {
    return {
      sessionKey: session.key,
      writerRunId: session.writerRunId,
      generation: 1,
      lastSeq: session.lastSeq,
    }
  }

  async tail(sessionKey: string, fromSeq: number): Promise<void> {
    const hosted = this.dormant(sessionKey) ? await this.acquire(sessionKey) : this.require(sessionKey)
    this.follow(sessionKey, hosted, fromSeq)
  }

  private follow(sessionKey: string, hosted: HostedSession, fromSeq: number): void {
    if (hosted.tail) return
    const controller = new AbortController()
    hosted.tail = controller
    const offPreview = hosted.session.onPreview((p) => {
      hosted.lastActivityAt = this.clock()
      this.options.send({ kind: 'preview', sessionKey, ...p } satisfies PreviewFrame)
    })
    controller.signal.addEventListener('abort', offPreview, { once: true })
    hosted.following = tailSession(hosted.session, {
      fromSeq,
      pollMs: 25,
      signal: controller.signal,
      onEvents: (events) => {
        hosted.lastActivityAt = this.clock()
        for (const event of events)
          this.options.send({
            kind: 'event',
            sessionKey,
            seq: event.seq,
            event,
          } satisfies EventFrame)
      },
      onError: (error) => {
        this.options.send({
          kind: 'session.interrupted',
          sessionKey,
          reason: error instanceof Error ? error.message : String(error),
        })
      },
    })
  }

  async dispatch(frame: SessionCommandFrame): Promise<unknown> {
    const stub = this.stubs.get(frame.sessionKey)
    // A stub answers these itself: a listing or a stray cancel must not wake a session.
    if (stub && frame.method === 'ping')
      return { ok: true, lastSeq: await stub.head(), preset: stub.preset, parent: stub.parent ?? null }
    if (stub && frame.method === 'abort') return {}
    if (stub && frame.method === 'previewSnapshot') return []
    return this.enter(frame.sessionKey, frame.method, (hosted) =>
      this.options.channel.run(frame.sessionKey, () =>
        handleCommand(hosted.session, frame, {
          host: this.options.host,
          aborts: hosted.aborts,
          workerGeneration: this.options.workerGeneration,
          ...(this.options.workerResourcesInput
            ? { workerResourcesInput: this.options.workerResourcesInput }
            : {}),
          ...(this.options.resources ? { resources: this.options.resources } : {}),
          fork: (input) => this.adoptFork(hosted.session, input),
        }),
      ),
    )
  }

  /**
   * Runs a worker-level command that names a session with that session open, waking it first if it
   * hibernated. A key this worker does not know is passed through, so the command reports it.
   */
  withSession<T>(sessionKey: string, method: string, fn: () => T | Promise<T>): Promise<T> {
    if (!this.sessions.has(sessionKey) && !this.dormant(sessionKey)) return Promise.resolve().then(fn)
    return this.enter(sessionKey, method, fn)
  }

  /** Runs `fn` on the open session, waking it if needed and keeping it open until `fn` settles. */
  private enter<T>(
    sessionKey: string,
    method: string,
    fn: (hosted: HostedSession) => T | Promise<T>,
  ): Promise<T> {
    const open = this.sessions.get(sessionKey)
    // An open session is entered in the same tick, so commands keep their arrival order.
    if (open) return this.inside(open, method, fn)
    return this.acquire(sessionKey).then((hosted) => this.inside(hosted, method, fn))
  }

  private async inside<T>(
    hosted: HostedSession,
    method: string,
    fn: (hosted: HostedSession) => T | Promise<T>,
  ): Promise<T> {
    const active = ACTIVE_METHODS.has(method) || (method === 'abort' && hosted.aborts.size > 0)
    hosted.inflight++
    if (active) hosted.lastActivityAt = this.clock()
    try {
      return await fn(hosted)
    } finally {
      hosted.inflight--
      if (active) hosted.lastActivityAt = this.clock()
    }
  }

  /** Hibernates every session that has been idle for the configured time. */
  async sweep(): Promise<void> {
    const idleMs = this.options.idleCloseMs ?? 0
    if (idleMs <= 0 || this.closingAll) return
    const now = this.clock()
    const started: Promise<void>[] = []
    for (const [key, hosted] of this.sessions)
      if (now - hosted.lastActivityAt >= idleMs && this.quiet(key, hosted))
        started.push(this.hibernate(key, hosted))
    await Promise.allSettled(started)
  }

  private quiet(key: string, hosted: HostedSession): boolean {
    const { session } = hosted
    if (hosted.inflight > 0 || hosted.aborts.size > 0 || this.options.channel.hasPending(key)) return false
    if (session.turn !== null || session.op() !== null || session.d.log.faulted) return false
    if (((session.latest('inbox') as { items?: unknown[] } | undefined)?.items?.length ?? 0) > 0) return false
    if (session.state.pendingApprovals.size > 0) return false
    // A child still open keeps its parent open; children hibernate first.
    for (const other of this.options.host.kernel.sessions.values())
      if (other !== session && other.d.log.parent?.key === key) return false
    return true
  }

  private hibernate(key: string, hosted: HostedSession): Promise<void> {
    const { session } = hosted
    const started = this.clock()
    this.sessions.delete(key)
    // Resume the stream from what was pushed, not from lastSeq: rows committed while the log drains
    // on close were never pushed and are sent after waking.
    const delivered = hosted.following?.deliveredThrough()
    const ledger = session.d.log.storage
    const lastSeq = session.lastSeq
    this.stubs.set(key, {
      binding: session.d.workspaceIdentity as WorkspaceBinding,
      ...(session.d.log.parent ? { parent: session.d.log.parent } : {}),
      preset: session.preset.name,
      lastSeq,
      head: async () => {
        try {
          return (await ledger.scan(key, { order: 'desc', limit: 1 }))[0]?.seq ?? lastSeq
        } catch {
          return lastSeq
        }
      },
      ...(delivered !== undefined ? { tailFrom: delivered + 1 } : {}),
    })
    hosted.tail?.abort()
    const done = (async () => {
      try {
        await session.close()
      } catch (error) {
        this.log(
          key,
          'warn',
          `session hibernation close failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        this.options.host.kernel.sessions.delete(key)
        this.options.channel.closeSession(key)
      }
      this.log(key, 'info', `session hibernated in ${this.clock() - started} ms`)
    })().finally(() => this.hibernating.delete(key))
    this.hibernating.set(key, done)
    return done
  }

  private dormant(key: string): boolean {
    return this.stubs.has(key) || this.hibernating.has(key) || this.waking.has(key)
  }

  /** The open session for `key`, waking it from its stub if it hibernated. */
  private async acquire(key: string): Promise<HostedSession> {
    for (;;) {
      const hibernating = this.hibernating.get(key)
      if (hibernating) {
        await hibernating
        continue
      }
      const open = this.sessions.get(key)
      if (open) return open
      const waking = this.waking.get(key)
      if (waking) return waking
      const stub = this.stubs.get(key)
      // A session being closed is not woken: close would not see a wake that starts after it looked.
      if (!stub || this.closingAll || this.closing.has(key)) throw new Error(`session ${key} is not open`)
      return this.wake(key, stub)
    }
  }

  private wake(key: string, stub: HibernatedStub): Promise<HostedSession> {
    const started = this.clock()
    // No parent: the ledger records it, and this is the shape a reopen after restart takes.
    const woken = this.options.channel.run(key, async () => {
      const session = await this.options.host.createSession({
        key,
        binding: stub.binding,
        preset: stub.preset,
      })
      this.stubs.delete(key)
      const hosted = this.adopt(key, session)
      if (stub.tailFrom !== undefined) this.follow(key, hosted, stub.tailFrom)
      return hosted
    })
    this.waking.set(key, woken)
    woken.then(
      () => this.log(key, 'info', `session woke in ${this.clock() - started} ms`),
      (error: unknown) =>
        this.log(
          key,
          'warn',
          `session wake failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    )
    void woken.catch(() => undefined).finally(() => this.waking.delete(key))
    return woken
  }

  private adopt(key: string, session: HostSession): HostedSession {
    const hosted: HostedSession = { session, aborts: new Map(), inflight: 0, lastActivityAt: this.clock() }
    this.sessions.set(key, hosted)
    return hosted
  }

  private log(sessionKey: string, level: 'info' | 'warn', message: string): void {
    try {
      this.options.send({ kind: 'log', sessionKey, level, message })
    } catch {
      /* diagnostics must not change the outcome */
    }
  }

  private async adoptFork(
    parentSession: HostSession,
    input: { at: number; childKey: string; credential: unknown; binding: unknown },
  ): Promise<unknown> {
    if (
      !Number.isSafeInteger(input.at) ||
      input.at < 1 ||
      !input.childKey ||
      input.childKey === parentSession.key
    )
      throw new Error('invalid fork command')
    const envelope = parseWorkspaceBinding(input.binding, input.childKey)
    const binding = this.options.host.acceptWorkspaceBinding(envelope, input.childKey)
    const parent = { key: parentSession.key, boundarySeq: input.at }
    if (this.dormant(input.childKey)) {
      const woken = await this.acquire(input.childKey)
      this.assertAuthority(woken.session, binding, parent)
      return { sessionId: woken.session.key, parent: woken.session.d.log.parent }
    }
    const existing = this.sessions.get(input.childKey)
    if (existing) {
      this.assertAuthority(existing.session, binding, parent)
      return { sessionId: existing.session.key, parent: existing.session.d.log.parent }
    }
    const pending = this.opening.get(input.childKey)
    if (pending) {
      const hosted = await pending
      this.assertAuthority(hosted.session, binding, parent)
      return { sessionId: hosted.session.key, parent: hosted.session.d.log.parent }
    }
    const opening = this.options.channel.run(input.childKey, async () => {
      const child = await this.options.host.createSession({
        key: input.childKey,
        credential: input.credential,
        binding,
        preset: parentSession.preset.name,
        parent,
      })
      return this.adopt(input.childKey, child)
    })
    this.opening.set(input.childKey, opening)
    try {
      const hosted = await opening
      return { sessionId: hosted.session.key, parent: hosted.session.d.log.parent }
    } finally {
      if (this.opening.get(input.childKey) === opening) this.opening.delete(input.childKey)
    }
  }

  private assertAuthority(
    session: HostSession,
    binding: WorkspaceBinding,
    parent: { key: string; boundarySeq: number } | undefined,
  ): void {
    const actualBinding = session.d.workspaceIdentity as WorkspaceBinding | undefined
    const actualParent = session.d.log.parent
    if (
      !actualBinding ||
      actualBinding.sessionKey !== binding.sessionKey ||
      actualBinding.workspaceId !== binding.workspaceId ||
      actualBinding.authorityRevision !== binding.authorityRevision ||
      actualBinding.canonicalRoot !== binding.canonicalRoot ||
      actualParent?.key !== parent?.key ||
      actualParent?.boundarySeq !== parent?.boundarySeq
    )
      throw new Error('session.open authority does not match the hosted session')
  }

  close(sessionKey: string): Promise<void> {
    const active = this.closing.get(sessionKey)
    if (active) return active
    const closing = (async () => {
      await this.opening.get(sessionKey)?.catch(() => undefined)
      while (this.hibernating.has(sessionKey) || this.waking.has(sessionKey)) {
        await this.hibernating.get(sessionKey)
        await this.waking.get(sessionKey)?.catch(() => undefined)
      }
      this.stubs.delete(sessionKey)
      const hosted = this.sessions.get(sessionKey)
      if (!hosted) return
      this.sessions.delete(sessionKey)
      hosted.tail?.abort()
      for (const abort of hosted.aborts.values()) abort.abort()
      this.options.channel.closeSession(sessionKey)
      try {
        await hosted.session.close()
      } finally {
        // HostSession.close() can fail after the session has already been removed from this owner's
        // map. Always release the kernel registration as well, otherwise no owner remains that can
        // clean the stale key and a later session.open for the same key fails with E_LANE_BUSY.
        this.options.host.kernel.sessions.delete(sessionKey)
      }
    })().finally(() => {
      if (this.closing.get(sessionKey) === closing) this.closing.delete(sessionKey)
    })
    this.closing.set(sessionKey, closing)
    return closing
  }

  async closeAll(): Promise<void> {
    this.closingAll = true
    if (this.sweeper) clearInterval(this.sweeper)
    await Promise.allSettled(this.opening.values())
    await Promise.allSettled([...this.hibernating.values(), ...this.waking.values()])
    this.stubs.clear()
    await Promise.allSettled(this.keys().map((key) => this.close(key)))
    await Promise.allSettled(this.closing.values())
  }

  private require(sessionKey: string): HostedSession {
    const hosted = this.sessions.get(sessionKey)
    if (!hosted) throw new Error(`session ${sessionKey} is not open`)
    return hosted
  }
}
