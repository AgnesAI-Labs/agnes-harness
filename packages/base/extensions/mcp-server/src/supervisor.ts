import type { McpConnection } from '../../../src/mcp/register.js'

/**
 * Connection supervisor: owns one MCP server's live connection generation, keeps its registered
 * tools in sync with the live generation, and -- when the connection drops -- reconnects with
 * bounded exponential backoff. Ported from dsh's `packages/mcp/mcp-client/src/connection.ts` onto
 * Agnes's `McpConnection` abstraction (stage 2b, D102/D118).
 *
 * One outage shares one attempt budget (`maxAttempts` consecutive failed attempts, delays doubling
 * from `initialDelayMs` up to `maxDelayMs`). A connection that stays up past the stability window
 * (`maxDelayMs`) closes the outage, so the next disconnect starts a fresh budget while a
 * crash-looping server -- even one whose connects briefly succeed -- still exhausts the cap instead
 * of retrying forever. Exhaustion unregisters the server's tools and stops; disposal is the only way
 * back from that state.
 */
export type ReconnectPolicy = Readonly<{
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt. */
  initialDelayMs: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets. */
  maxDelayMs: number
  /** Consecutive failed attempts per outage before giving up for good. */
  maxAttempts: number
}>

export const RECONNECT_DEFAULTS: ReconnectPolicy = Object.freeze({
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/**
 * The live connection status a row reports as it changes, independent of the one-shot `ready`
 * promise: `connecting` from the moment supervision starts or a connection drops until the next
 * attempt settles, `ready` after every successful (re-)sync (including a `tools/list_changed`
 * re-sync, whose catalog may have changed), `unavailable` once the reconnect budget is exhausted.
 */
export type ConnectionStatusEvent =
  | Readonly<{ state: 'connecting' }>
  | Readonly<{
      state: 'ready'
      toolCount: number
      catalogRevision: string
      /** The full accepted catalog this revision was computed from - what a paginated read of it
       *  serves back. Same shape as `@agnes/base`'s `McpCatalogTool`, spelled out here rather than
       *  imported so this file stays independent of the catalog-info helper. */
      tools: readonly Readonly<{ name: string; description: string; inputSchema: Record<string, unknown> }>[]
    }>
  | Readonly<{
      state: 'unavailable'
      error: unknown
      /** `'exhausted'` once the reconnect budget is used up for good (dispose() is the only way
       *  back); otherwise which kind of attempt is still retrying in the background - `'lost'` for a
       *  connection that was live and dropped, `'failed'` for one that never got established in the
       *  first place. Either retry case reports `unavailable` immediately rather than sitting on an
       *  uninformative `connecting` for however long the backoff schedule takes to give up. */
      reason: 'lost' | 'failed' | 'exhausted'
    }>

/** Timeout waiting for a superseded connection's own `close()` to resolve before starting the next
 * attempt -- a hung close must not leave two live connections (e.g. two stdio child processes) for
 * the same server. */
const CLOSE_TIMEOUT_MS = 5_000

export type ConnectionSupervisorDeps = Readonly<{
  /** One connection attempt. Resolving means the connection is live; rejecting counts as a failed
   * attempt and feeds the backoff schedule. */
  connect(signal: AbortSignal): Promise<McpConnection>
  /** (Re-)registers this server's tools against a live connection. Called once for the initial
   * connection and again after every successful reconnect or `tools/list_changed` notification.
   * `reportCatalog`, if the implementation calls it, feeds this attempt's `ready` status event -
   * existing callers that only take one parameter still satisfy this type and simply never report. */
  sync(
    connection: McpConnection,
    reportCatalog?: (
      info: Readonly<{
        toolCount: number
        catalogRevision: string
        tools: readonly Readonly<{
          name: string
          description: string
          inputSchema: Record<string, unknown>
        }>[]
      }>,
    ) => void,
  ): Promise<() => void | Promise<void>>
  /** Resolves after `ms`, or rejects once `signal` aborts (whichever comes first). */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** Live status as it changes; see {@link ConnectionStatusEvent}. Never awaited or allowed to throw
   * into the supervisor's own control flow. */
  onStatus?(event: ConnectionStatusEvent): void
  log?: Readonly<{
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }>
}>

export type ConnectionSupervisorHandle = Readonly<{
  /** Settles when the first connection attempt completes (success or failure). The supervisor
   * enters its reconnect loop regardless; the caller decides whether a failed startup is fatal. */
  ready: Promise<{ error?: unknown }>
  /** Stops reconnection, closes the live connection, waits for the in-flight attempt and queued
   * syncs to quiesce, then unregisters every tool this server still owns. */
  dispose(): Promise<void>
}>

const SILENT_LOG = Object.freeze({ info() {}, warn() {}, error() {} })

/** Races `task` against a timeout; returns whether `task` won. Never rejects. */
async function withTimeout(task: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([task.then(() => true as const), timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Starts the supervised connection for one MCP server and keeps it alive per `policy`. Never
 * throws; failures are reported through `ready` and the log.
 */
export function superviseConnection(
  deps: ConnectionSupervisorDeps,
  policy: ReconnectPolicy = RECONNECT_DEFAULTS,
): ConnectionSupervisorHandle {
  const log = deps.log ?? SILENT_LOG
  let disposed = false
  /** Current generation: the live connection; undefined during backoff waits and after final
   * failure or a connect attempt that has not yet resolved. */
  let current: McpConnection | undefined
  /** A failed generation is removed from `current` before replacement admission. Its close may
   * still be pending after the diagnostic timeout, so disposal must also wait for this owner. */
  let pendingFailedClose: Readonly<{ generation: McpConnection; close: Promise<void> }> | undefined
  /** Live tool registrations owned by the current generation; only `enqueueSync` and dispose swap it. */
  let disposeSync: (() => void | Promise<void>) | undefined
  let failedAttempts = 0
  /** When the current generation finished connect + initial sync; undefined while down. */
  let connectedAt: number | undefined
  let firstAttemptError: unknown
  /** The most recent attempt's failure, independent of `firstAttemptError` (which only ever holds
   *  the very first one): what `scheduleReconnect` reports when the budget is exhausted. */
  let lastAttemptError: unknown
  const abort = new AbortController()

  const isCurrent = (generation: McpConnection): boolean => !disposed && current === generation
  deps.onStatus?.({ state: 'connecting' })

  /** Serializes every sync call -- the initial sync, reconnect syncs, and notification re-syncs --
   * so two syncs can never interleave their dispose-previous/register-next swap.
   *
   * The previous registration is retired BEFORE the next one registers: a re-sync registers the same
   * tool names again, and Host's tool registry refuses a name that is still held
   * (E_REGISTRY_DUPLICATE). Registering first would fail every reconnect and every
   * `tools/list_changed`, leaving the old tools bound to a dead or stale connection. The cost is a
   * short window in which this server has no tools -- the same as while it is down. */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueueSync(generation: McpConnection): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      const previous = disposeSync
      disposeSync = undefined
      if (previous) await previous()
      const next = await deps.sync(generation, (info) => {
        // A late report from a sync this generation has since lost ownership of (superseded or
        // disposed) would contradict whatever status followed it; only the current generation reports.
        if (isCurrent(generation)) deps.onStatus?.({ state: 'ready', ...info })
      })
      if (!isCurrent(generation)) {
        // Lost ownership while syncing (disposed, or superseded by a newer generation): the fresh
        // registrations belong to nobody now, so retire them instead of leaking or double-owning.
        await next()
        return
      }
      disposeSync = next
    })
    // The chain tail must survive a failed sync; the caller owns reporting.
    syncChain = run.catch(() => undefined)
    return run
  }

  function generationDown(generation: McpConnection): void {
    if (!isCurrent(generation)) return
    current = undefined
    scheduleReconnect(true)
  }

  /** @param hadConnection Whether this outage followed a connection that was actually established
   * (vs. a connect attempt that never succeeded in the first place) -- purely for the log message. */
  function scheduleReconnect(hadConnection: boolean): void {
    // A connection that stayed up past the stability window ended the previous outage: start a
    // fresh budget.
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      syncChain = syncChain.then(async () => {
        const dispose = disposeSync
        disposeSync = undefined
        if (dispose) await dispose()
      })
      log.error(
        `giving up after ${policy.maxAttempts} consecutive failed reconnect attempts -- tools unregistered; reload to reconnect`,
      )
      deps.onStatus?.({
        state: 'unavailable',
        error: lastAttemptError ?? new Error('reconnect budget exhausted'),
        reason: 'exhausted',
      })
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = hadConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    log.warn(`${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    deps.onStatus?.({
      state: 'unavailable',
      error: hadConnection
        ? new Error('MCP transport closed unexpectedly')
        : (lastAttemptError ?? new Error('connection attempt failed')),
      reason: hadConnection ? 'lost' : 'failed',
    })
    settling = deps
      .sleep(delayMs, abort.signal)
      .then(() => (disposed ? undefined : connectGeneration()))
      .catch(() => undefined)
  }

  /** One connection attempt. Every failure funnels through `scheduleReconnect`; success arms the
   * onClose-driven disconnect path. Never rejects. */
  async function connectGeneration(): Promise<void> {
    let generation: McpConnection
    try {
      generation = await deps.connect(abort.signal)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      lastAttemptError = error
      if (!disposed) {
        log.warn(`connection attempt failed: ${String(error)}`)
        scheduleReconnect(false)
      }
      return
    }
    if (disposed) {
      await generation.close().catch(() => undefined)
      return
    }
    current = generation
    generation.onClose?.(() => generationDown(generation))
    generation.onToolsChanged?.(() => {
      if (!isCurrent(generation)) return
      log.info('tool list changed, re-syncing')
      enqueueSync(generation).catch((error) => {
        if (!disposed) log.error(`tool re-sync failed: ${String(error)}`)
      })
    })
    try {
      await enqueueSync(generation)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      lastAttemptError = error
      if (!isCurrent(generation)) return
      log.warn(`initial tool sync failed: ${String(error)}`)
      const close = generation.close()
      pendingFailedClose = { generation, close }
      const closed = await withTimeout(close, CLOSE_TIMEOUT_MS)
      if (!isCurrent(generation)) return
      current = undefined
      if (!closed) {
        log.error(
          `failed generation did not close within ${CLOSE_TIMEOUT_MS}ms -- reconnect stopped to avoid overlapping connections; reload to retry`,
        )
        deps.onStatus?.({ state: 'unavailable', error, reason: 'exhausted' })
        return
      }
      scheduleReconnect(false)
      return
    }
    if (!isCurrent(generation)) return
    connectedAt = Date.now()
    if (failedAttempts > 0)
      log.info(`reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
    failedAttempts = 0
  }

  /** The in-flight (or last settled) connection attempt / backoff wait; dispose awaits it for
   * quiescence. */
  let settling = connectGeneration()

  const ready: Promise<{ error?: unknown }> = settling.then(() => {
    if (current !== undefined) return {}
    return { error: firstAttemptError ?? new Error('initial connection failed') }
  })

  return {
    ready,
    async dispose(): Promise<void> {
      disposed = true
      abort.abort()
      const closing = current
      current = undefined
      if (closing) {
        const close = pendingFailedClose?.generation === closing ? pendingFailedClose.close : closing.close()
        if (!(await withTimeout(close, CLOSE_TIMEOUT_MS))) {
          // The old transport may still own a stdio child or HTTP session. Keep this row's
          // disposer pending until that ownership is really gone: a replacement waits for it.
          log.error(`MCP connection close exceeded ${CLOSE_TIMEOUT_MS}ms; waiting before replacement`)
          await close
        }
      }
      if (pendingFailedClose) await pendingFailedClose.close
      // Quiesce, don't just request it: an in-flight attempt or backoff wait may still enqueue a
      // sync before settling, so awaiting both leaves `disposeSync` final.
      await settling
      await syncChain
      if (disposeSync) {
        const dispose = disposeSync
        disposeSync = undefined
        await dispose()
      }
    },
  }
}
