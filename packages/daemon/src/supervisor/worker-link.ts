import type { Duplex } from 'node:stream'
import type { PreviewUpdate } from '@agnes/daemon-foundation/registry'
import type {
  DaemonNotice,
  EventEnvelope,
  LoopSelection,
  McpStatus,
  RuntimeTargetArtifact,
} from '@agnes/protocol'
import type {
  RequestFrame,
  SessionMethod,
  SessionOpenResult,
  WorkerHello,
  WorkerMethod,
  WorkerToSupervisor,
  WorkspaceBindingFrame,
} from './frames.js'
import { parseWorkerHello } from './frames.js'
import { encodeFrame, JsonlDecoder } from './framing.js'
import { packageManageReplyError } from './package-manage-error.js'
import { PermissionFence } from './permission-fence.js'
import { PermissionRequestFailure } from './permission-requests.js'
import { skillInstallReplyError } from './skill-install-error.js'

export type WorkerCommandOptions = {
  historySignal?: AbortSignal
  timeoutMs?: number
  onHistoryProgress?: (progress: { verifiedSeq: number; lastSeq: number }) => void
}

/** Session-scoped view of the shared process connection. */
export class WorkerSessionChannel {
  readonly hello: Promise<SessionOpenResult>
  private closed = false

  constructor(
    readonly sessionKey: string,
    private readonly worker: WorkerLink,
    open: Readonly<{
      binding: WorkspaceBindingFrame
      preset?: string
      permission?: string
      agent?: string
      agentDigest?: string
      bundles?: readonly string[]
      systemPromptAppend?: string
      loop?: LoopSelection
      resume?: boolean
      parent?: { key: string; boundarySeq: number }
    }>,
    private readonly onClosed?: () => void,
    onHistoryProgress?: WorkerCommandOptions['onHistoryProgress'],
    historySignal?: AbortSignal,
  ) {
    this.hello = worker.openSession(sessionKey, open, {
      ...(onHistoryProgress ? { onHistoryProgress } : {}),
      ...(historySignal ? { historySignal } : {}),
    })
  }

  get alive(): boolean {
    return !this.closed && this.worker.alive
  }

  command(
    method: SessionMethod,
    params: Record<string, unknown>,
    options: WorkerCommandOptions = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('worker session channel closed'))
    return this.worker.commandForSession(this.sessionKey, method, params, options)
  }

  close(_reason = 'session closed'): void {
    void this.closeSession(_reason).catch(() => undefined)
  }

  tail(fromSeq: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('worker session channel closed'))
    return this.worker.tailSession(this.sessionKey, fromSeq)
  }

  async closeSession(reason = 'session closed'): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.worker.closeSession(this.sessionKey, reason)
    } finally {
      this.onClosed?.()
    }
  }

  onExit(handler: () => void): void {
    this.worker.onExit(handler)
  }
}

/** One process-wide connection. Session routing remains explicit on every session frame. */
export class WorkerLink {
  readonly permissionFence = new PermissionFence()
  private readonly requestsLifetime = new AbortController()
  private readonly sessionRequests = new Map<string, AbortController>()
  readonly hello: Promise<WorkerHello>
  private resolveHello!: (hello: WorkerHello) => void
  private readonly pending = new Map<
    string,
    {
      sessionKey?: string
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
      onHistoryProgress?: WorkerCommandOptions['onHistoryProgress']
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  private nextId = 1
  alive = true
  private readonly exitHandlers: Array<() => void> = []
  private readonly frameChains = new Map<string, Promise<void>>()
  private readonly failedSessions = new Set<string>()

  constructor(
    private readonly socket: Duplex,
    private readonly options: {
      onEvent: (sessionKey: string, event: EventEnvelope) => void | Promise<void>
      onPreview?: (sessionKey: string, update: PreviewUpdate) => void
      onDecisionsChanged?: (detail: Extract<DaemonNotice, { kind: 'decisions_changed' }>['detail']) => void
      onResourceStatus?: (serverId: string, status: McpStatus) => void
      onRequest: (frame: RequestFrame, signal: AbortSignal) => Promise<unknown>
      onLog?: (
        sessionKey: string,
        level: 'debug' | 'info' | 'warn' | 'error',
        message: string,
        correlation?: { traceId: string; spanId: string },
      ) => void
      onActivity?: (sessionKey: string) => void
      onSessionFailure?: (sessionKey: string, error: unknown) => void
      onRuntimeFrame?: (frame: unknown) => void
    },
  ) {
    this.hello = new Promise((resolve) => {
      this.resolveHello = resolve
    })
    const decoder = new JsonlDecoder()
    socket.on('data', (chunk: Buffer) => {
      let frames: WorkerToSupervisor[]
      try {
        frames = decoder.feed(chunk) as WorkerToSupervisor[]
      } catch {
        this.close('invalid worker frame')
        return
      }
      for (const frame of frames) this.enqueue(frame)
    })
    socket.on('close', () => this.markDead())
    socket.on('error', () => this.markDead())
  }

  private enqueue(frame: WorkerToSupervisor): void {
    const runtimeType =
      frame && typeof frame === 'object' && 'type' in frame ? (frame as { type?: unknown }).type : undefined
    if (typeof runtimeType === 'string') {
      if (
        runtimeType === 'runtime.boot_ready' ||
        runtimeType === 'runtime.converged' ||
        runtimeType === 'runtime.apply_failed'
      ) {
        this.options.onRuntimeFrame?.(frame)
        return
      }
      this.close('unknown worker frame')
      return
    }
    if (!frame || typeof frame !== 'object' || typeof (frame as { kind?: unknown }).kind !== 'string') {
      this.close('invalid worker frame')
      return
    }
    const sessionKinds = new Set([
      'event',
      'preview',
      'request',
      'session.interrupted',
      'session.loading',
      'log',
    ])
    const candidate = frame as WorkerToSupervisor & { sessionKey?: unknown }
    if (
      sessionKinds.has(frame.kind) &&
      (typeof candidate.sessionKey !== 'string' || candidate.sessionKey.length === 0)
    ) {
      this.close('session frame missing session key')
      return
    }
    const knownKinds = new Set([
      'hello',
      'event',
      'preview',
      'resourceStatus',
      'decisionsChanged',
      'reply',
      'request',
      'session.interrupted',
      'session.loading',
      'log',
    ])
    if (!knownKinds.has(frame.kind)) {
      this.close('unknown worker frame')
      return
    }
    const sessionKey = 'sessionKey' in frame ? frame.sessionKey : undefined
    const chainKey = sessionKey || '@worker'
    const chain = this.frameChains.get(chainKey) ?? Promise.resolve()
    const next = chain
      .then(() => {
        if (sessionKey && this.failedSessions.has(sessionKey) && frame.kind !== 'reply') return
        return this.processFrame(frame)
      })
      .catch((error) => {
        if (!sessionKey) {
          this.close('worker frame projection failed')
          return
        }
        this.failSession(sessionKey, error)
      })
    this.frameChains.set(chainKey, next)
  }

  /**
   * Marks the session failed and tells the observer, once. The observer's own failure stays here:
   * this runs on the frame chain's rejection handler, which nothing awaits, so an exception escaping
   * it would be an unhandled rejection (fatal to the daemon) and would re-run the handler for the
   * session's next queued frame.
   */
  revokeSessionRequests(sessionKey: string): void {
    let lifetime = this.sessionRequests.get(sessionKey)
    if (!lifetime) {
      lifetime = new AbortController()
      this.sessionRequests.set(sessionKey, lifetime)
    }
    lifetime.abort('stopped')
  }

  resetSessionRequests(sessionKey: string): void {
    // Keep live controllers: a delayed turn/start must not orphan an offer from a later stop.
    if (this.sessionRequests.get(sessionKey)?.signal.aborted) this.sessionRequests.delete(sessionKey)
  }

  private failSession(sessionKey: string, error: unknown): void {
    this.permissionFence.closeSession(sessionKey)
    this.failedSessions.add(sessionKey)
    this.sessionRequests.get(sessionKey)?.abort('stopped')
    this.sessionRequests.delete(sessionKey)
    try {
      this.options.onSessionFailure?.(sessionKey, error)
    } catch (observerError) {
      this.options.onLog?.(
        sessionKey,
        'error',
        `session failure handler threw: ${observerError instanceof Error ? observerError.name : typeof observerError}`,
      )
    }
  }

  private processFrame(frame: WorkerToSupervisor): void | Promise<void> {
    if (frame.kind === 'hello') {
      this.resolveHello(parseWorkerHello(frame))
      return
    }
    if (frame.kind === 'event') {
      return Promise.resolve(this.options.onEvent(frame.sessionKey, frame.event)).then(() => {
        this.options.onActivity?.(frame.sessionKey)
      })
    }
    if (frame.kind === 'preview') {
      const { kind: _kind, sessionKey, ...update } = frame
      this.options.onPreview?.(sessionKey, update)
      return
    }
    if (frame.kind === 'decisionsChanged') {
      const { detail } = frame
      if (
        !detail ||
        typeof detail.profile !== 'string' ||
        !detail.principal ||
        typeof detail.principal.id !== 'string' ||
        typeof detail.principal.org !== 'string'
      )
        throw new Error('invalid decision invalidation')
      // Reconstruct the signal, never forward unrecognized worker payload fields.
      this.options.onDecisionsChanged?.({
        profile: detail.profile,
        principal: { id: detail.principal.id, org: detail.principal.org },
      })
      return
    }
    if (frame.kind === 'resourceStatus') {
      this.options.onResourceStatus?.(frame.serverId, frame.status)
      return
    }
    if (frame.kind === 'session.interrupted') {
      this.failSession(frame.sessionKey, new Error(frame.reason))
      return
    }
    if (frame.kind === 'session.loading') {
      const pending = this.pending.get(frame.requestId)
      if (
        pending?.sessionKey === frame.sessionKey &&
        Number.isSafeInteger(frame.verifiedSeq) &&
        frame.verifiedSeq >= 0 &&
        Number.isSafeInteger(frame.lastSeq) &&
        frame.lastSeq >= frame.verifiedSeq
      )
        pending.onHistoryProgress?.({ verifiedSeq: frame.verifiedSeq, lastSeq: frame.lastSeq })
      return
    }
    if (frame.kind === 'log') {
      this.options.onLog?.(
        frame.sessionKey,
        frame.level,
        frame.message,
        typeof frame.traceId === 'string' &&
          /^[a-f0-9]{32}$/.test(frame.traceId) &&
          typeof frame.spanId === 'string' &&
          /^[a-f0-9]{16}$/.test(frame.spanId)
          ? { traceId: frame.traceId, spanId: frame.spanId }
          : undefined,
      )
      this.options.onActivity?.(frame.sessionKey)
      return
    }
    if (frame.kind === 'reply') {
      const replySessionKey = 'sessionKey' in frame ? frame.sessionKey : undefined
      this.settle(frame.requestId, (pending) => {
        if (pending.sessionKey !== replySessionKey)
          return pending.reject(new Error('worker reply session mismatch'))
        if (frame.error) pending.reject(frame.error)
        else pending.resolve(frame.result)
      })
      if (replySessionKey) this.options.onActivity?.(replySessionKey)
      return
    }
    if (frame.method === 'permission-revoke') {
      const context = frame.params as { sessionId?: unknown; epoch?: unknown } | null
      if (typeof context?.sessionId !== 'string' || typeof context.epoch !== 'number')
        throw new Error('Invalid permission revocation')
      this.permissionFence.revoke(frame.sessionKey, context.sessionId, context.epoch)
      this.send({ kind: 'reply', sessionKey: frame.sessionKey, requestId: frame.requestId, result: null })
      return
    }
    let sessionLifetime = this.sessionRequests.get(frame.sessionKey)
    if (!sessionLifetime) {
      sessionLifetime = new AbortController()
      this.sessionRequests.set(frame.sessionKey, sessionLifetime)
    }
    void this.options
      .onRequest(frame, AbortSignal.any([this.requestsLifetime.signal, sessionLifetime.signal]))
      .then(
        (result) =>
          this.send({
            kind: 'reply',
            requestId: frame.requestId,
            sessionKey: frame.sessionKey,
            result,
          }),
        (failure) => {
          const error = failure instanceof PermissionRequestFailure ? failure.cause : failure
          this.send({
            kind: 'reply',
            ...(failure instanceof PermissionRequestFailure ? { permissionEvidence: failure.evidence } : {}),
            requestId: frame.requestId,
            sessionKey: frame.sessionKey,
            error:
              frame.method === 'plugin-manage'
                ? packageManageReplyError(error)
                : frame.method === 'mcp-manage'
                  ? {
                      code:
                        typeof (error as { data?: { code?: unknown } })?.data?.code === 'string'
                          ? (error as { data: { code: string } }).data.code
                          : 'HELPER_MANAGEMENT_FAILED',
                      message:
                        'The AGH extension operation did not finish. Check its status or policy in Settings.',
                    }
                  : frame.method === 'skill-install'
                    ? skillInstallReplyError(error)
                    : { code: 'E_REQUEST', message: String(error) },
          })
        },
      )
    this.options.onActivity?.(frame.sessionKey)
  }

  private markDead(): void {
    if (!this.alive) return
    this.alive = false
    this.permissionFence.close()
    this.requestsLifetime.abort('stopped')
    for (const requestId of [...this.pending.keys()])
      this.settle(requestId, (pending) => pending.reject(new Error('worker link closed')))
    for (const handler of this.exitHandlers) handler()
  }

  private settle(
    requestId: string,
    complete: (pending: {
      sessionKey?: string
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
    }) => void,
  ): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    complete(pending)
    return true
  }

  private send(frame: unknown): void {
    if (this.alive) this.socket.write(encodeFrame(frame))
  }

  offerRuntimeTarget(artifact: RuntimeTargetArtifact): void {
    this.send({ type: 'runtime.stale', artifact })
  }

  command(
    method: WorkerMethod,
    params: Record<string, unknown>,
    options: WorkerCommandOptions = {},
  ): Promise<unknown> {
    return this.sendCommand(undefined, method, params, options)
  }

  commandForSession(
    sessionKey: string,
    method: SessionMethod,
    params: Record<string, unknown>,
    options: WorkerCommandOptions = {},
  ): Promise<unknown> {
    if (!sessionKey) return Promise.reject(new Error('session key is required'))
    return this.sendCommand(sessionKey, method, params, options)
  }

  openSession(
    sessionKey: string,
    params: Readonly<{
      binding: WorkspaceBindingFrame
      preset?: string
      permission?: string
      agent?: string
      agentDigest?: string
      bundles?: readonly string[]
      systemPromptAppend?: string
      loop?: LoopSelection
      resume?: boolean
      parent?: { key: string; boundarySeq: number }
    }>,
    options: WorkerCommandOptions = {},
  ): Promise<SessionOpenResult> {
    if (!this.alive) return Promise.reject(new Error('worker link closed'))
    this.permissionFence.openSession(sessionKey)
    const requestId = `s${this.nextId++}`
    const signal = options.historySignal
    const cancel = () => {
      if (this.alive) this.send({ kind: 'session.open.cancel', requestId, sessionKey })
    }
    const result = new Promise<SessionOpenResult>((resolve, reject) => {
      const pending: {
        sessionKey: string
        resolve: (value: unknown) => void
        reject: (error: unknown) => void
        onHistoryProgress?: WorkerCommandOptions['onHistoryProgress']
        timer?: ReturnType<typeof setTimeout>
      } = {
        sessionKey,
        resolve: (value) => resolve(value as SessionOpenResult),
        reject,
        ...(options.onHistoryProgress ? { onHistoryProgress: options.onHistoryProgress } : {}),
      }
      this.pending.set(requestId, pending)
      if (options.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.settle(requestId, (current) => current.reject(new Error('worker session.open timed out')))
        }, options.timeoutMs)
        pending.timer.unref()
      }
      this.send({ kind: 'session.open', requestId, sessionKey, params })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
    return result.finally(() => signal?.removeEventListener('abort', cancel))
  }

  tailSession(sessionKey: string, fromSeq: number, options: WorkerCommandOptions = {}): Promise<void> {
    return this.sendSessionLifecycle('session.tail', sessionKey, { fromSeq }, options) as Promise<void>
  }

  async closeSession(sessionKey: string, reason: string, options: WorkerCommandOptions = {}): Promise<void> {
    this.permissionFence.closeSession(sessionKey)
    this.revokeSessionRequests(sessionKey)
    try {
      await this.sendSessionLifecycle('session.close', sessionKey, { reason }, options)
    } finally {
      this.failedSessions.delete(sessionKey)
      this.frameChains.delete(sessionKey)
    }
  }

  private sendSessionLifecycle(
    kind: 'session.tail' | 'session.close',
    sessionKey: string,
    payload: { fromSeq?: number; reason?: string },
    options: WorkerCommandOptions,
  ): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error('worker link closed'))
    const requestId = `s${this.nextId++}`
    return new Promise((resolve, reject) => {
      const pending: {
        sessionKey: string
        resolve: (value: unknown) => void
        reject: (error: unknown) => void
        onHistoryProgress?: WorkerCommandOptions['onHistoryProgress']
        timer?: ReturnType<typeof setTimeout>
      } = { sessionKey, resolve, reject }
      this.pending.set(requestId, pending)
      if (options.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.settle(requestId, (current) => current.reject(new Error(`worker ${kind} timed out`)))
        }, options.timeoutMs)
        pending.timer.unref()
      }
      this.send({ kind, requestId, sessionKey, ...payload })
    })
  }

  session(
    sessionKey: string,
    open: Readonly<{
      binding: WorkspaceBindingFrame
      preset?: string
      permission?: string
      agent?: string
      agentDigest?: string
      bundles?: readonly string[]
      systemPromptAppend?: string
      loop?: LoopSelection
      resume?: boolean
      parent?: { key: string; boundarySeq: number }
    }>,
    onClosed?: () => void,
    onHistoryProgress?: WorkerCommandOptions['onHistoryProgress'],
    historySignal?: AbortSignal,
  ): WorkerSessionChannel {
    return new WorkerSessionChannel(sessionKey, this, open, onClosed, onHistoryProgress, historySignal)
  }

  private sendCommand(
    sessionKey: string | undefined,
    method: WorkerMethod | SessionMethod,
    params: Record<string, unknown>,
    options: WorkerCommandOptions,
  ): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error('worker link closed'))
    const requestId = `s${this.nextId++}`
    const signal = options.historySignal
    const cancel = () => {
      if (this.alive && sessionKey) this.send({ kind: 'session.open.cancel', requestId, sessionKey })
    }
    const result = new Promise<unknown>((resolve, reject) => {
      const pending: {
        sessionKey?: string
        resolve: (value: unknown) => void
        reject: (error: unknown) => void
        onHistoryProgress?: WorkerCommandOptions['onHistoryProgress']
        timer?: ReturnType<typeof setTimeout>
      } = {
        ...(sessionKey ? { sessionKey } : {}),
        resolve,
        reject,
        ...(options.onHistoryProgress ? { onHistoryProgress: options.onHistoryProgress } : {}),
      }
      this.pending.set(requestId, pending)
      if (options.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.settle(requestId, (current) => current.reject(new Error(`worker command ${method} timed out`)))
        }, options.timeoutMs)
        pending.timer.unref()
      }
      this.send({ kind: 'command', requestId, ...(sessionKey ? { sessionKey } : {}), method, params })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
    return result.finally(() => signal?.removeEventListener('abort', cancel))
  }

  close(reason: string): void {
    if (!this.alive) return
    this.send({ kind: 'close', reason })
    this.socket.end()
    this.markDead()
  }

  onExit(handler: () => void): void {
    if (!this.alive) {
      handler()
      return
    }
    this.exitHandlers.push(handler)
  }
}
