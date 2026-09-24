import type { Duplex } from 'node:stream'
import type { EventEnvelope, McpStatus, RuntimeTargetArtifact } from '@agnes/protocol'
import type { PreviewUpdate } from '../registry.js'
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
import { skillInstallReplyError } from './skill-install-error.js'

export type WorkerCommandOptions = { timeoutMs?: number }

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
      resume?: boolean
      parent?: { key: string; boundarySeq: number }
    }>,
    private readonly onClosed?: () => void,
  ) {
    this.hello = worker.openSession(sessionKey, open)
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
  readonly hello: Promise<WorkerHello>
  private resolveHello!: (hello: WorkerHello) => void
  private readonly pending = new Map<
    string,
    {
      sessionKey?: string
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
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
      onResourceStatus?: (serverId: string, status: McpStatus) => void
      onRequest: (frame: RequestFrame) => Promise<unknown>
      onLog?: (sessionKey: string, level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
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
    const sessionKinds = new Set(['event', 'preview', 'request', 'session.interrupted', 'log'])
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
      'reply',
      'request',
      'session.interrupted',
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
        this.failedSessions.add(sessionKey)
        this.options.onSessionFailure?.(sessionKey, error)
      })
    this.frameChains.set(chainKey, next)
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
    if (frame.kind === 'resourceStatus') {
      this.options.onResourceStatus?.(frame.serverId, frame.status)
      return
    }
    if (frame.kind === 'session.interrupted') {
      this.failedSessions.add(frame.sessionKey)
      this.options.onSessionFailure?.(frame.sessionKey, new Error(frame.reason))
      return
    }
    if (frame.kind === 'log') {
      this.options.onLog?.(frame.sessionKey, frame.level, frame.message)
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
    void this.options.onRequest(frame).then(
      (result) =>
        this.send({
          kind: 'reply',
          requestId: frame.requestId,
          sessionKey: frame.sessionKey,
          result,
        }),
      (error) =>
        this.send({
          kind: 'reply',
          requestId: frame.requestId,
          sessionKey: frame.sessionKey,
          error:
            frame.method === 'mcp-manage' || frame.method === 'plugin-manage'
              ? {
                  code:
                    typeof (error as { data?: { code?: unknown } })?.data?.code === 'string'
                      ? (error as { data: { code: string } }).data.code
                      : 'HELPER_MANAGEMENT_FAILED',
                  message: 'AGH 扩展操作未完成，请检查设置中的状态或策略。',
                }
              : frame.method === 'skill-install'
                ? skillInstallReplyError(error)
                : { code: 'E_REQUEST', message: String(error) },
        }),
    )
    this.options.onActivity?.(frame.sessionKey)
  }

  private markDead(): void {
    if (!this.alive) return
    this.alive = false
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
      resume?: boolean
      parent?: { key: string; boundarySeq: number }
    }>,
    options: WorkerCommandOptions = {},
  ): Promise<SessionOpenResult> {
    if (!this.alive) return Promise.reject(new Error('worker link closed'))
    const requestId = `s${this.nextId++}`
    return new Promise((resolve, reject) => {
      const pending: {
        sessionKey: string
        resolve: (value: unknown) => void
        reject: (error: unknown) => void
        timer?: ReturnType<typeof setTimeout>
      } = { sessionKey, resolve: (value) => resolve(value as SessionOpenResult), reject }
      this.pending.set(requestId, pending)
      if (options.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.settle(requestId, (current) => current.reject(new Error('worker session.open timed out')))
        }, options.timeoutMs)
        pending.timer.unref()
      }
      this.send({ kind: 'session.open', requestId, sessionKey, params })
    })
  }

  tailSession(sessionKey: string, fromSeq: number, options: WorkerCommandOptions = {}): Promise<void> {
    return this.sendSessionLifecycle('session.tail', sessionKey, { fromSeq }, options) as Promise<void>
  }

  async closeSession(sessionKey: string, reason: string, options: WorkerCommandOptions = {}): Promise<void> {
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
      resume?: boolean
      parent?: { key: string; boundarySeq: number }
    }>,
    onClosed?: () => void,
  ): WorkerSessionChannel {
    return new WorkerSessionChannel(sessionKey, this, open, onClosed)
  }

  private sendCommand(
    sessionKey: string | undefined,
    method: WorkerMethod | SessionMethod,
    params: Record<string, unknown>,
    options: WorkerCommandOptions,
  ): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error('worker link closed'))
    const requestId = `s${this.nextId++}`
    return new Promise((resolve, reject) => {
      const pending: {
        sessionKey?: string
        resolve: (value: unknown) => void
        reject: (error: unknown) => void
        timer?: ReturnType<typeof setTimeout>
      } = { ...(sessionKey ? { sessionKey } : {}), resolve, reject }
      this.pending.set(requestId, pending)
      if (options.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.settle(requestId, (current) => current.reject(new Error(`worker command ${method} timed out`)))
        }, options.timeoutMs)
        pending.timer.unref()
      }
      this.send({ kind: 'command', requestId, ...(sessionKey ? { sessionKey } : {}), method, params })
    })
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
