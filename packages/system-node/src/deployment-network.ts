import { AsyncLocalStorage } from 'node:async_hooks'
import { Client, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

export type DeploymentTimeouts = { requestMs?: number; connectMs?: number; streamIdleMs?: number }
type ProxyEnvironment = Readonly<Record<string, string | undefined>>
const proxyOptions = (env: ProxyEnvironment) => ({
  httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? '',
  httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY ?? '',
  noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
})

/** Never return userinfo, paths or query strings in operator diagnostics. */
export function deploymentProxyHosts(env: ProxyEnvironment = process.env) {
  const options = proxyOptions(env)
  const host = (value: string) => {
    if (!value) return 'direct'
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) ? url.host : 'invalid'
    } catch {
      return 'invalid'
    }
  }
  return {
    http: host(options.httpProxy),
    https: host(options.httpsProxy),
    exclusionsConfigured: !!options.noProxy,
  }
}

let installed = false
const requestDispatcher = new AsyncLocalStorage<Dispatcher>()
class ScopedDispatcher extends Dispatcher {
  constructor(private readonly fallback: Dispatcher) {
    super()
  }
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return (requestDispatcher.getStore() ?? this.fallback).dispatch(options, handler)
  }
}
/** Google SDK transports use global fetch. Explicit dispatchers (public-fetch) retain their policy. */
export function ensureDeploymentProxy(): void {
  if (installed) return
  const options = proxyOptions(process.env)
  setGlobalDispatcher(new ScopedDispatcher(new EnvHttpProxyAgent(options)))
  installed = true
}

export function createDeploymentFetch(
  timeouts: DeploymentTimeouts = {},
  env: ProxyEnvironment = process.env,
) {
  const requestMs = timeouts.requestMs ?? 300_000
  const idleMs = timeouts.streamIdleMs ?? 60_000
  for (const value of [requestMs, idleMs, timeouts.connectMs ?? 10_000])
    if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000)
      throw new TypeError('Network timeouts must be integers from 1 to 3600000 milliseconds')
  const dispatcher = new EnvHttpProxyAgent({
    ...proxyOptions(env),
    connect: { timeout: timeouts.connectMs ?? 10_000 },
    proxyTls: { timeout: timeouts.connectMs ?? 10_000 },
    requestTls: { timeout: timeouts.connectMs ?? 10_000 },
    clientFactory: (origin, options) =>
      new Client(origin, { ...options, headersTimeout: timeouts.connectMs ?? 10_000 }),
  })
  const request: typeof globalThis.fetch = async (input, init) => {
    const controller = new AbortController()
    const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const abort = () => controller.abort(inherited?.reason)
    if (inherited?.aborted) abort()
    else inherited?.addEventListener('abort', abort, { once: true })
    const total = setTimeout(
      () => controller.abort(new DOMException('Request timeout', 'TimeoutError')),
      requestMs,
    )
    total.unref()
    let idle: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(total)
      clearTimeout(idle)
      inherited?.removeEventListener('abort', abort)
    }
    try {
      const response = await globalThis.fetch(input, {
        ...init,
        signal: controller.signal,
        dispatcher,
      } as RequestInit)
      // MCP's long-lived stream is a GET event-stream. Silence is normal, and a transport
      // error retires the server, so this response keeps neither the idle timer nor the
      // request deadline. POST streams, including model SSE, keep both.
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const sseGet =
        method === 'GET' &&
        (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream')
      if (sseGet) clearTimeout(total)
      if (!response.body) {
        clear()
        return response
      }
      const reader = response.body.getReader()
      const resetIdle = () => {
        if (sseGet) return
        clearTimeout(idle)
        idle = setTimeout(
          () => controller.abort(new DOMException('Stream idle timeout', 'TimeoutError')),
          idleMs,
        )
        idle.unref()
      }
      resetIdle()
      const stream = new ReadableStream<Uint8Array>({
        async pull(sink) {
          try {
            const next = await reader.read()
            if (next.done) {
              clear()
              sink.close()
            } else {
              resetIdle()
              sink.enqueue(next.value)
            }
          } catch (error) {
            clear()
            sink.error(error)
          }
        },
        async cancel(reason) {
          controller.abort(reason)
          clear()
          // Aborting the socket may reject its reader; explicit body cancellation must still succeed.
          await reader.cancel(reason).catch(() => undefined)
        },
      })
      const wrapped = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      Object.defineProperties(wrapped, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      })
      return wrapped
    } catch (error) {
      clear()
      throw error
    }
  }
  return {
    fetch: request,
    run: <T>(fn: () => T): T => requestDispatcher.run(dispatcher, fn),
    close: () => dispatcher.close(),
  }
}

let shared: ReturnType<typeof createDeploymentFetch> | undefined
/** One process-owned pool for MCP, package downloads and telemetry. */
export const deploymentFetch: typeof globalThis.fetch = (input, init) => {
  shared ??= createDeploymentFetch()
  return shared.fetch(input, init)
}
