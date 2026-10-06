import { EventEmitter } from 'node:events'
import * as undici from 'undici'

/**
 * Host-owned pooled connections for Jev decision calls.
 *
 * The default global `fetch` keeps an idle connection for 4 s. Two decision calls in a JevLoop
 * turn are always separated by language generation, tool execution or user idle time, so nearly
 * every call paid a fresh TCP+TLS handshake (measured by mu against api.typesafe.ai: 0.7-1.9 s
 * per call on the default dispatcher, 0.25-0.36 s with a pooled one). This factory wraps a
 * dedicated undici dispatcher so decision calls reuse one warm connection per origin while all
 * other Host traffic keeps the global dispatcher.
 *
 * Two failure shapes are guarded:
 *
 * - A silently dead pooled connection (server or middlebox drop without FIN; undici's own pings
 *   never time out) would make every later call wait out its full timeout for the rest of the
 *   Host's life. After `failuresBeforeReconnect` consecutive unanswered calls the pool is
 *   replaced; any answered call - including an HTTP error status - proves the connection works
 *   and resets the count. The failed logical request is still returned as a failure: this is
 *   connection-pool management, not a retry, so the transport's single-attempt contract holds.
 * - A slow or absent response header is bounded by `headersTimeoutMs`, well under the transport's
 *   own 120 s timeout, so a dead connection is detected and counted as unanswered instead of
 *   stalling a step until the transport gives up.
 *
 * Connections are created lazily on the first call (constructing this for a Native-only Host
 * opens no socket) and closed together with the Host. `AGNES_JEV_HTTP2=off` keeps HTTP/1.1 for
 * proxies that cannot carry HTTP/2; proxies from the environment are honoured either way.
 */

/** Idle lifetime of a pooled decision connection; steps between two decisions outlast Node's 4 s default. */
export const JEV_KEEP_ALIVE_MS = 60_000

/** Unanswered calls in a row that replace the pool before the next call. */
export const JEV_FAILURES_BEFORE_RECONNECT = 2

/**
 * Bound on waiting for the first response header. Warm Jev decisions answer in well under a
 * second, so this only ever fires on a dead connection; it must stay below the transport's
 * 120 s timeout so the unanswered counter, not the transport's abort, classifies the failure.
 */
export const JEV_HEADERS_TIMEOUT_MS = 30_000

export interface JevDecisionFetchOptions {
  keepAliveMs?: number
  /** HTTP/2 where the endpoint speaks it; `false` forces HTTP/1.1 for incompatible proxies. */
  http2?: boolean
  headersTimeoutMs?: number
  failuresBeforeReconnect?: number
  /** Cleartext HTTP/2 prior knowledge; for local test servers only. */
  h2c?: boolean
}

export interface JevDecisionFetch {
  readonly fetch: typeof fetch
  readonly http2: boolean
  /** 1 until the pool has been replaced; each replacement increments. */
  generations(): number
  close(): Promise<void>
}

/**
 * A call that got no answer: its connection failed or its headers timed out. The transport's
 * own cancellation surfaces as an AbortError instead and is not connection evidence.
 */
const unanswered = (error: unknown): boolean => error instanceof TypeError

export function createJevDecisionFetch(options: JevDecisionFetchOptions = {}): JevDecisionFetch {
  const keepAliveMs = options.keepAliveMs ?? JEV_KEEP_ALIVE_MS
  const http2 = options.http2 ?? true
  const headersTimeoutMs = options.headersTimeoutMs ?? JEV_HEADERS_TIMEOUT_MS
  const failuresBeforeReconnect = options.failuresBeforeReconnect ?? JEV_FAILURES_BEFORE_RECONNECT
  let generations = 1
  let failures = 0
  let closed = false
  let dispatcher: undici.EnvHttpProxyAgent | undefined

  const connect = (): undici.EnvHttpProxyAgent => {
    const agent = new undici.EnvHttpProxyAgent({
      keepAliveTimeout: keepAliveMs,
      keepAliveMaxTimeout: Math.max(keepAliveMs, 600_000),
      // Decision calls are small and short; a few connections cover concurrent sessions in one Host.
      connections: 4,
      allowH2: http2,
      headersTimeout: headersTimeoutMs,
      ...(options.h2c ? { useH2c: true } : {}),
    })
    // A pooled connection dying while idle raises 'error' on the dispatcher; without a listener
    // that would crash the Host. Reconnection accounting happens per call in the wrapper below.
    EventEmitter.prototype.on.call(agent, 'error', () => {})
    return agent
  }

  // The pool is created on first use and after each replacement, never at construction.
  const current = (): undici.EnvHttpProxyAgent => (dispatcher ??= connect())

  const fetchImpl = undici.fetch as unknown as typeof fetch
  const pooledFetch: typeof fetch = async (input, init) => {
    if (closed) throw new TypeError('Jev decision connections are closed')
    const used = current()
    try {
      const response = await fetchImpl(input, { ...(init ?? {}), dispatcher: used } as RequestInit)
      if (used === dispatcher) failures = 0
      return response
    } catch (error) {
      // Calls still awaiting a pool that was already replaced count for nothing; a pool that was
      // closed does not exist anymore either.
      if (used === dispatcher && unanswered(error) && ++failures >= failuresBeforeReconnect) {
        dispatcher = undefined
        failures = 0
        generations++
        void used.destroy().catch(() => {})
      }
      throw error
    }
  }

  return {
    fetch: pooledFetch,
    http2,
    generations: () => generations,
    async close() {
      closed = true
      const used = dispatcher
      dispatcher = undefined
      // Best-effort teardown: sessions close before the Host does, so nothing should be in flight.
      await used?.close().catch(() => undefined)
    },
  }
}
