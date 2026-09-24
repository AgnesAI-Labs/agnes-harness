import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DaemonNotice, UINode } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { type ChannelAdapter, type ChannelEvent, sessionKeyFor } from '../adapter.js'
import { ChannelError } from '../errors.js'
import { Approval } from './approval.js'
import { backoffDelays } from './backoff.js'
import type { RunnerConfig } from './config.js'
import { type HealthzHandle, startHealthz } from './health.js'
import { Inbound } from './inbound.js'
import { noticeText } from './notices.js'
import { Outbound } from './outbound.js'
import { RefStore } from './ref-store.js'
import { type BoundSession, SessionCache } from './session-cache.js'

export type RunnerLog = {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

type RunnerClient = {
  initialize: Client['initialize']
  apis: Client['apis']
  on: Client['on']
  session: ConstructorParameters<typeof SessionCache>[0]['session']
  claim: Pick<Client['claim'], 'once'>
  approval: Pick<Client['approval'], 'decide'>
  call?: Client['call']
  close: Client['close']
}

export type RunnerDeps = {
  adapter: ChannelAdapter
  cfg: RunnerConfig
  secrets: Record<string, string>
  client: RunnerClient
  log: RunnerLog
  backoff?: { baseMs: number; maxMs: number; jitter?: () => number }
  refsPath?: string
  refMaxAgeMs?: number
  refGcIntervalMs?: number
  maxTrackedSessions?: number
  inboundSettleMs?: number
  now?: () => number
}

export type RunnerStatus = {
  channel: 'connected' | 'reconnecting' | 'stopped'
  daemon: 'connecting' | 'connected' | 'reconnecting' | 'closed'
  lastEventAt?: string
  sessions: number
  degraded: string[]
}

export type Runner = {
  start(): Promise<void>
  stopIntake(): void
  stop(options?: { drainMs?: number }): Promise<void>
  status(): RunnerStatus
  readonly cache: SessionCache
  readonly inbound: Inbound
  directorySupported: boolean
  onEvent(handler: (event: ChannelEvent) => void): void
}

export function createRunner(dependencies: RunnerDeps): Runner {
  const abort = new AbortController()
  const sessionConfig = { cwd: dependencies.cfg.workspace, preset: 'channel' }
  const maxTrackedSessions = Math.max(1, dependencies.maxTrackedSessions ?? 1_024)
  let removeSession: ((key: string) => void) | undefined
  const cache = new SessionCache(dependencies.client, sessionConfig, {
    maxPendingKeys: maxTrackedSessions,
    onRemove: (key) => removeSession?.(key),
  })
  if (dependencies.refsPath !== undefined && dependencies.refsPath !== ':memory:') {
    mkdirSync(dirname(dependencies.refsPath), { recursive: true })
  }
  const refs = new RefStore(
    dependencies.refsPath ?? ':memory:',
    dependencies.now === undefined ? {} : { clock: dependencies.now },
  )
  const now = dependencies.now ?? Date.now
  const refMaxAgeMs = dependencies.refMaxAgeMs ?? 30 * 24 * 60 * 60 * 1_000
  refs.gc(now() - refMaxAgeMs)
  const outbound = new Outbound({
    adapter: dependencies.adapter,
    refs,
    cache,
    cfg: dependencies.cfg,
    caps: dependencies.adapter.capabilities(),
    limits: dependencies.adapter.manifest.limits,
    log: dependencies.log,
  })
  const targets = new Map<string, { chatId: string; threadId?: string }>()
  const requesters = new Map<string, string>()
  const approvalWatches = new Map<string, { session: object; dispose(): void }>()
  const approval = new Approval({
    adapter: dependencies.adapter,
    client: dependencies.client,
    cfg: dependencies.cfg,
    log: dependencies.log,
    signal: abort.signal,
    ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
    validateSlotAction: async (sessionKey, event, requestSeq, actionId) => {
      if (event.kind !== 'cardAction') return false
      const session = cache.current(sessionKey)
      if (session === undefined) return false
      const timeline = await session.projectUI(undefined, { surface: 'channel' })
      if (cache.current(sessionKey) !== session) return false
      for (const node of timeline.nodes) {
        if (!nodeHasSlotAction(node, requestSeq, actionId)) continue
        const delivered = refs.getState(sessionKey, node.id, session.id)
        if (
          delivered?.complete === true &&
          delivered.parts.some(
            ({ ref }) => ref.chatId === event.chat.id && (ref.cardBizId ?? ref.messageId) === event.cardBizId,
          )
        )
          return session.id
      }
      return false
    },
  })
  const degraded = new Map<string, Set<string>>()
  removeSession = (key) => {
    approvalWatches.get(key)?.dispose()
    approvalWatches.delete(key)
    requesters.delete(key)
    targets.delete(key)
    degraded.delete(key)
    outbound.detach(key)
  }
  outbound.onDegraded = (sessionKey, capability) => {
    const capabilities = degraded.get(sessionKey) ?? new Set<string>()
    capabilities.add(capability)
    degraded.delete(sessionKey)
    degraded.set(sessionKey, capabilities)
    trimTracked()
    safeWarn('channel outbound capability degraded', { sessionKey, capability })
  }
  let participantSupported = false
  const inbound = new Inbound({
    adapter: dependencies.adapter,
    claim: dependencies.client.claim,
    joinParticipant: async (sessionKey, credential) => {
      if (!participantSupported || dependencies.client.call === undefined) return
      await dependencies.client.call('_agnes/v1/participant.join', {
        sessionId: sessionKey,
        credential,
      })
    },
    cache,
    config: dependencies.cfg,
    signal: abort.signal,
    maxPendingLanes: maxTrackedSessions,
    log: dependencies.log,
    handleText: (key, session, event) => approval.handleText(key, session, event),
    onNewSession: async (key) => {
      if (abort.signal.aborted) return
      const session = await cache.renew(key)
      if (abort.signal.aborted || !cache.owns(key, session)) {
        await cache.evict(key, session)
        return
      }
      const target = targets.get(key)
      outbound.detach(key, { retire: true })
      degraded.delete(key)
      if (target !== undefined) {
        outbound.attach(key, session, target)
        watchApproval(key, session, target)
      }
    },
    onSession: (key, session, target, requesterUserId) => {
      if (abort.signal.aborted || !cache.owns(key, session)) return
      requesters.set(key, requesterUserId)
      targets.delete(key)
      targets.set(key, target)
      outbound.attach(key, session, target)
      watchApproval(key, session, target)
      trimTracked()
    },
  })
  const subscribers: Array<(event: ChannelEvent) => void> = []
  let phase: 'new' | 'starting' | 'running' | 'stopping' | 'stopped' = 'new'
  let channelState: RunnerStatus['channel'] = 'stopped'
  let daemonState: RunnerStatus['daemon'] = 'closed'
  let lastEventAt: string | undefined
  let startPromise: Promise<void> | undefined
  let shutdownPromise: Promise<void> | undefined
  let intake = true
  let healthz: HealthzHandle | undefined
  const unsubscribers: Array<() => void> = []
  const pendingInbound = new Set<Promise<void>>()
  const gcTimer = setInterval(
    () => {
      try {
        refs.gc(now() - refMaxAgeMs)
      } catch (error) {
        safeError('channel outbound ref gc failed', { error: String(error) })
      }
    },
    dependencies.refGcIntervalMs ?? Math.min(refMaxAgeMs, 60 * 60 * 1_000),
  )
  gcTimer.unref()

  const runner: Runner = {
    cache,
    inbound,
    directorySupported: false,

    onEvent(handler) {
      subscribers.push(handler)
    },

    start() {
      if (phase === 'running') return Promise.resolve()
      if (phase === 'starting' && startPromise !== undefined) return startPromise
      if (phase === 'stopping' || phase === 'stopped') {
        return Promise.reject(new ChannelError('E_CONNECT_FAILED', 'runner cannot restart after stop'))
      }
      phase = 'starting'
      startPromise = startRunner()
      return startPromise
    },

    stopIntake() {
      intake = false
    },

    stop(options) {
      return shutdown(options)
    },

    status() {
      return {
        channel: channelState,
        daemon: daemonState,
        ...(lastEventAt === undefined ? {} : { lastEventAt }),
        sessions: cache.keys().length,
        degraded: [...degraded]
          .flatMap(([key, values]) => [...values].map((capability) => `${key}:${capability}`))
          .sort(),
      }
    },
  }

  const receive = (event: ChannelEvent): void => {
    if (!intake || abort.signal.aborted) return
    lastEventAt = new Date().toISOString()
    if (pendingInbound.size >= maxTrackedSessions) {
      safeWarn('channel inbound task capacity reached; dropping event', { eventId: event.eventId })
      notifySubscribers(event)
      return
    }
    let task: Promise<void>
    task = Promise.resolve()
      .then(async () => {
        if (await approval.handleAction(event)) return
        if (event.kind === 'cardAction') {
          const sessionKey = sessionKeyFor({
            tenant: dependencies.cfg.tenant,
            agent: dependencies.cfg.agent,
            channel: dependencies.adapter.manifest.id,
            chat: event.chat,
          })
          if (await approval.handleSlotAction(sessionKey, event)) return
        }
        await inbound.handle(event)
      })
      .catch(() => {
        safeError('channel inbound dispatch failed', { eventId: event.eventId })
      })
      .finally(() => pendingInbound.delete(task))
    pendingInbound.add(task)
    notifySubscribers(event)
  }

  function notifySubscribers(event: ChannelEvent): void {
    for (const subscriber of subscribers) {
      try {
        subscriber(event)
      } catch {
        safeWarn('channel event subscriber failed', { eventId: event.eventId })
      }
    }
  }

  async function startRunner(): Promise<void> {
    try {
      daemonState = 'connecting'
      if (dependencies.cfg.healthz.enabled) {
        const started = await startHealthz(runner, dependencies.cfg.healthz.port)
        if (abort.signal.aborted) {
          await started.close().catch(() => undefined)
          throw cancelled()
        }
        healthz = started
      }
      try {
        await dependencies.client.initialize()
      } catch {
        throw new ChannelError('E_DAEMON_UNAVAILABLE', 'channel runner could not initialize daemon')
      }
      if (abort.signal.aborted) throw cancelled()
      daemonState = 'connected'

      unsubscribers.push(
        dependencies.client.on('connectionStateChanged', (value) => {
          if (abort.signal.aborted) return
          if (value === 'connected' || value === 'reconnecting' || value === 'closed') daemonState = value
        }),
      )

      let apis: Awaited<ReturnType<RunnerClient['apis']>>
      try {
        apis = await dependencies.client.apis()
      } catch {
        throw new ChannelError('E_DAEMON_UNAVAILABLE', 'channel runner could not inspect daemon APIs')
      }
      if (abort.signal.aborted) throw cancelled()
      const methods = new Set(apis.families.flatMap((family) => family.methods))
      if (!methods.has('_agnes/v1/session.attach')) {
        throw new ChannelError('E_CAPABILITY_MISSING', 'daemon does not expose _agnes/v1/session.attach')
      }
      runner.directorySupported = methods.has('_agnes/v1/directory.upsert')
      participantSupported = methods.has('_agnes/v1/participant.join')
      if (!apis.profile.presets.allowed.includes('channel')) {
        sessionConfig.preset = apis.profile.presets.default
        safeWarn('channel preset is unavailable; using daemon profile default')
      }

      const recover =
        (reason: 'gap' | 'generationChanged') =>
        (payload: unknown): void => {
          const sessionId = sessionIdOf(payload)
          if (sessionId !== undefined) {
            void outbound.flushSession(sessionId, reason).catch(() => {
              safeError('channel outbound recovery flush failed', { sessionId, reason })
            })
          }
        }
      unsubscribers.push(dependencies.client.on('gap', recover('gap')))
      unsubscribers.push(dependencies.client.on('generationChanged', recover('generationChanged')))
      unsubscribers.push(
        dependencies.client.on('notice', (payload) => {
          if (abort.signal.aborted || !isDaemonNotice(payload)) return
          // Client-module roster notices are consumed by the Web client. They deliberately carry
          // profile scope instead of a session id, so channel routing must ignore them before
          // narrowing to the session-scoped notice variants below.
          if (payload.kind === 'packages_changed' || payload.kind === 'tree_changed') return
          const text = noticeText(payload)
          if (text === null) return
          const matching = [...targets].filter(
            ([key]) =>
              payload.sessionId === undefined ||
              key === payload.sessionId ||
              cache.current(key)?.id === payload.sessionId,
          )
          const unique = new Map<string, string>()
          for (const [key, target] of matching) {
            unique.set(`${target.chatId}\0${target.threadId ?? ''}`, key)
          }
          for (const key of unique.values()) {
            void outbound
              .sendNotice(
                key,
                { blocks: [{ kind: 'text', markdown: text }] },
                `${payload.kind}\0${payload.sessionId ?? ''}\0${payload.at}\0${text}`,
              )
              .catch(() => safeWarn('channel daemon notice delivery failed', { kind: payload.kind }))
          }
        }),
      )

      await connectWithRetry(3)
      if (abort.signal.aborted) throw cancelled()
      phase = 'running'
    } catch (error) {
      await shutdown()
      throw error
    }
  }

  async function connectWithRetry(maxAttempts: number): Promise<void> {
    const delays = backoffDelays(dependencies.backoff)
    channelState = 'reconnecting'
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (abort.signal.aborted) throw cancelled()
      try {
        await dependencies.adapter.connect({
          credentials: dependencies.secrets,
          signal: abort.signal,
          onEvent: receive,
          log: dependencies.log,
        })
        if (abort.signal.aborted) {
          await dependencies.adapter.disconnect().catch(() => undefined)
          throw cancelled()
        }
        channelState = 'connected'
        return
      } catch {
        await dependencies.adapter.disconnect().catch(() => undefined)
        if (abort.signal.aborted) throw cancelled()
        safeWarn('channel connection attempt failed', { attempt })
        if (attempt === maxAttempts) {
          throw new ChannelError('E_CONNECT_FAILED', `channel connection failed after ${attempt} attempts`)
        }
        await abortableDelay(delays.next().value, abort.signal)
      }
    }
  }

  function shutdown(options: { drainMs?: number } = {}): Promise<void> {
    shutdownPromise ??= (async () => {
      const drainMs = Math.max(0, options.drainMs ?? 5_000)
      const deadline = Date.now() + drainMs
      // Keep a small slice of the one end-to-end budget for disconnect/client.close even when
      // admitted work consumes the rest. The outer signal timer remains the final hard stop.
      const cleanupReserveMs = Math.min(250, Math.ceil(drainMs / 4))
      const workDeadline = deadline - cleanupReserveMs
      phase = 'stopping'
      intake = false
      clearInterval(gcTimer)
      channelState = 'stopped'
      if (healthz !== undefined) {
        const closed = await settlePromises(
          [healthz.close().catch(() => safeWarn('channel health server close failed'))],
          remaining(workDeadline),
        )
        if (!closed) safeWarn('channel health server close timed out')
      }
      healthz = undefined
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe()
        } catch {
          safeWarn('channel daemon subscription cleanup failed')
        }
      }
      const inboundDrained = await settleTasks(
        pendingInbound,
        Math.min(dependencies.inboundSettleMs ?? 1_000, remaining(workDeadline)),
      )
      if (!inboundDrained) {
        safeWarn('channel inbound drain exceeded its grace window; cancelling admitted work', {
          pending: pendingInbound.size,
        })
      }
      if (!inboundDrained) abort.abort()
      const outboundDrained = await settlePromises(
        outbound.keys().map((key) => outbound.flush(key)),
        remaining(workDeadline),
      )
      if (!outboundDrained) {
        safeWarn('channel outbound drain exceeded its grace window; forcing disconnect', {
          pending: outbound.keys().length,
        })
      }
      abort.abort()
      const outboundStop = outbound.stop()
      const cacheStop = cache.stop()
      const resourcesStopped = await settlePromises([cacheStop, outboundStop], remaining(workDeadline))
      if (!resourcesStopped) safeWarn('channel runner resource drain timed out; forcing disconnect')
      const disconnect = dependencies.adapter.disconnect().catch(() => undefined)
      const clientClose = dependencies.client.close().catch(() => undefined)
      const transportsClosed = await settlePromises([disconnect, clientClose], remaining(deadline))
      if (!transportsClosed) safeWarn('channel transport close timed out')
      try {
        refs.close()
      } catch {
        safeWarn('channel outbound ref store close failed')
      }
      daemonState = 'closed'
      phase = 'stopped'
    })()
    return shutdownPromise
  }

  function safeWarn(message: string, meta?: Record<string, unknown>): void {
    try {
      dependencies.log.warn(message, meta)
    } catch {
      // A diagnostic sink cannot affect runner lifecycle.
    }
  }

  function watchApproval(
    key: string,
    session: BoundSession,
    target: { chatId: string; threadId?: string },
  ): void {
    const current = approvalWatches.get(key)
    if (current?.session === session) return
    current?.dispose()
    approvalWatches.set(key, {
      session,
      dispose: approval.watch(key, session, target, () => requesters.get(key)),
    })
  }

  function trimTracked(): void {
    while (targets.size > maxTrackedSessions) {
      const oldest = targets.keys().next().value as string | undefined
      if (oldest === undefined) break
      targets.delete(oldest)
      degraded.delete(oldest)
      outbound.detach(oldest)
      const expected = cache.current(oldest)
      if (expected !== undefined) void cache.evict(oldest, expected).catch(() => undefined)
    }
    while (degraded.size > maxTrackedSessions) {
      const oldest = degraded.keys().next().value as string | undefined
      if (oldest === undefined) break
      degraded.delete(oldest)
    }
  }

  function safeError(message: string, meta?: Record<string, unknown>): void {
    try {
      dependencies.log.error(message, meta)
    } catch {
      // A diagnostic sink cannot affect runner lifecycle.
    }
  }

  return runner
}

function cancelled(): ChannelError {
  return new ChannelError('E_CONNECT_FAILED', 'channel runner startup was cancelled')
}

function nodeHasSlotAction(node: UINode, requestSeq: number, actionId: string): boolean {
  const fills = node.kind === 'tool' ? (node.slots ?? []) : node.kind === 'slot' ? [node.fill] : []
  return fills.some((fill) => {
    if (fill.requestSeq !== requestSeq || typeof fill.payload !== 'object' || fill.payload === null)
      return false
    const actions = (fill.payload as { actions?: unknown }).actions
    return (
      Array.isArray(actions) &&
      actions.some(
        (action) =>
          typeof action === 'object' && action !== null && (action as { id?: unknown }).id === actionId,
      )
    )
  })
}

function sessionIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const sessionId = (payload as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

function isDaemonNotice(payload: unknown): payload is DaemonNotice {
  if (typeof payload !== 'object' || payload === null) return false
  const notice = payload as { kind?: unknown; detail?: unknown; at?: unknown }
  return (
    typeof notice.kind === 'string' &&
    [
      'resumed',
      'worker_crashed',
      'worker_quarantined',
      'overloaded',
      'job_dispatched',
      'job_dead',
      'shutting_down',
    ].includes(notice.kind) &&
    'detail' in notice &&
    typeof notice.at === 'string'
  )
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    function finish(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(cancelled())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function settleTasks(tasks: Set<Promise<void>>, timeoutMs: number): Promise<boolean> {
  return settlePromises([...tasks], timeoutMs)
}

function settlePromises(tasks: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (tasks.length === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (drained: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(drained)
    }
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
    timer.unref?.()
    void Promise.allSettled([...tasks]).then(() => finish(true))
  })
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}
