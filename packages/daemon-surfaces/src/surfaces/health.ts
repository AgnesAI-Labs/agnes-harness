import { request as httpRequest } from 'node:http'
import type { SurfaceEndpoint, SurfaceRuntimeHandle } from './types.js'

const MAX_HEALTH_BODY_BYTES = 64 * 1_024

export type HealthProbe = (endpoint: SurfaceEndpoint, signal: AbortSignal) => Promise<boolean>

export function probeSurfaceHealth(endpoint: SurfaceEndpoint, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, healthy = false) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error !== null) reject(error)
      else resolve(healthy)
    }
    const request = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: endpoint.healthPath,
        method: 'GET',
        headers: { accept: 'application/json', connection: 'close' },
      },
      (response) => {
        let bytes = 0
        response.on('data', (chunk: Buffer | string) => {
          bytes += Buffer.byteLength(chunk)
          if (bytes > MAX_HEALTH_BODY_BYTES) request.destroy()
        })
        response.on('end', () =>
          finish(
            null,
            bytes <= MAX_HEALTH_BODY_BYTES &&
              response.statusCode !== undefined &&
              response.statusCode >= 200 &&
              response.statusCode < 300,
          ),
        )
        response.on('error', () => finish(null, false))
      },
    )
    const onAbort = () => {
      request.destroy()
      finish(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    request.on('error', () => finish(null, false))
    request.end()
  })
}

export async function waitForSurfaceHealth(
  handle: SurfaceRuntimeHandle,
  options: Readonly<{ timeoutMs: number; intervalMs: number; signal: AbortSignal }>,
): Promise<void> {
  const timeoutMs = boundedDelay(options.timeoutMs, 'health timeout')
  const intervalMs = boundedDelay(options.intervalMs, 'health interval')
  const timeout = new AbortController()
  let timedOut = false
  let resolveDeadline!: (result: { kind: 'timeout' }) => void
  let resolveCancellation!: (result: { kind: 'cancelled' }) => void
  const hardDeadline = new Promise<{ kind: 'timeout' }>((resolve) => {
    resolveDeadline = resolve
  })
  const cancelled = new Promise<{ kind: 'cancelled' }>((resolve) => {
    resolveCancellation = resolve
  })
  const onAbort = () => {
    timeout.abort()
    resolveCancellation({ kind: 'cancelled' })
  }
  options.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    timeout.abort()
    resolveDeadline({ kind: 'timeout' })
  }, timeoutMs)
  timer.unref?.()
  const deadline = Date.now() + timeoutMs
  if (options.signal.aborted) onAbort()
  try {
    while (true) {
      options.signal.throwIfAborted()
      const result = await Promise.race([
        Promise.resolve(handle.probe(timeout.signal)).then(
          (healthy) => ({ kind: 'probe' as const, healthy }),
          () => ({ kind: 'probe' as const, healthy: false }),
        ),
        handle.exited.then(() => ({ kind: 'exit' as const })),
        hardDeadline,
        cancelled,
      ])
      if (result.kind === 'cancelled') {
        options.signal.throwIfAborted()
        throw abortError()
      }
      if (result.kind === 'timeout') throw new Error('surface health deadline exceeded')
      if (result.kind === 'exit') throw new Error('surface exited before becoming healthy')
      if (result.healthy) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('surface health deadline exceeded')
      await abortableDelay(Math.min(intervalMs, remaining), timeout.signal)
    }
  } catch (error) {
    if (options.signal.aborted) options.signal.throwIfAborted()
    if (timedOut) throw new Error('surface health deadline exceeded')
    throw error
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
  }
}

export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    function finish() {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function boundedDelay(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} is invalid`)
  }
  return value
}

function abortError(): Error {
  const error = new Error('surface operation aborted')
  error.name = 'AbortError'
  return error
}
