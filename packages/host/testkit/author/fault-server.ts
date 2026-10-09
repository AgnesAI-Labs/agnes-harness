import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/** Every accepted request consumes exactly one entry, including cancelled requests. */
export type ModelFault = {
  latencyMs?: number
  chunkDelayMs?: number
} & (
  | { kind: 'http'; status: number; body?: unknown; retryAfterMs?: number }
  | { kind: 'sse'; chunks: readonly unknown[] }
  | { kind: 'truncated'; chunks: readonly unknown[]; reset?: boolean }
  | { kind: 'malformed'; chunks?: readonly unknown[]; raw?: string }
)
export interface FaultServer {
  /** OpenAI-shaped endpoint is `${baseUrl}/v1/chat/completions`; all paths use the same script. */
  readonly baseUrl: string
  /** No request headers, keys or bodies are captured. */
  readonly requests: readonly { attempt: number; kind: ModelFault['kind'] | 'exhausted' }[]
  assertConsumed(): void
  close(): Promise<void>
}
function milliseconds(value: number | undefined) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647))
    throw new RangeError('Fault delay must be a non-negative timer integer')
}

/** Programmable HTTP/SSE faults on loopback only; no credentials or external provider calls. */
export async function startModelFaultServer(script: readonly ModelFault[]): Promise<FaultServer> {
  if (!script.length) throw new Error('Provide at least one fault response')
  const faults = structuredClone(script)
  for (const fault of faults) {
    milliseconds(fault.latencyMs)
    milliseconds(fault.chunkDelayMs)
    if (fault.kind === 'http') {
      if (!Number.isInteger(fault.status) || fault.status < 200 || fault.status > 599)
        throw new RangeError('Fault HTTP status must be 200..599')
      milliseconds(fault.retryAfterMs)
    } else if (!['sse', 'truncated', 'malformed'].includes(fault.kind)) throw new Error('Unknown model fault')
  }
  const requests: { attempt: number; kind: ModelFault['kind'] | 'exhausted' }[] = []
  const active = new Set<AbortController>()
  const work = new Set<Promise<void>>()
  let cursor = 0
  let closing: Promise<void> | undefined
  const server = createServer((request, response) => {
    // Drain, never retain the caller's potentially sensitive payload.
    request.resume()
    const fault = faults[cursor++]
    requests.push({ attempt: cursor, kind: fault?.kind ?? 'exhausted' })
    const controller = new AbortController()
    active.add(controller)
    const closed = () => controller.abort()
    response.once('close', closed)
    const task = (async () => {
      try {
        if (!fault) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'FIXTURE_EXHAUSTED' } }))
          return
        }
        if (fault.latencyMs) await delay(fault.latencyMs, undefined, { signal: controller.signal })
        controller.signal.throwIfAborted()
        if (fault.kind === 'http') {
          response.writeHead(fault.status, {
            'content-type': 'application/json',
            ...(fault.retryAfterMs === undefined
              ? {}
              : { 'retry-after': String(Math.ceil(fault.retryAfterMs / 1000)) }),
          })
          response.end(JSON.stringify(fault.body ?? { error: { code: `HTTP_${fault.status}` } }))
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.flushHeaders()
        for (const chunk of fault.chunks ?? []) {
          if (fault.chunkDelayMs) await delay(fault.chunkDelayMs, undefined, { signal: controller.signal })
          controller.signal.throwIfAborted()
          response.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        if (fault.kind === 'truncated') {
          if (fault.reset) response.destroy()
          else response.end()
        } else if (fault.kind === 'malformed') response.end(fault.raw ?? 'data: {malformed-json\n\n')
        else response.end('data: [DONE]\n\n')
      } catch (error) {
        if (!controller.signal.aborted) response.destroy(error instanceof Error ? error : undefined)
      } finally {
        response.removeListener('close', closed)
        active.delete(controller)
      }
    })()
    work.add(task)
    void task.finally(() => work.delete(task))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => reject(cause)
      server.once('error', error)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', error)
        resolve()
      })
    })
  } catch (error) {
    server.close()
    throw error
  }
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    assertConsumed() {
      if (cursor !== faults.length || active.size) throw new Error('Model fault script not fully consumed')
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const controller of active) controller.abort()
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }).then(async () => {
        await Promise.allSettled([...work])
      })
      return closing
    },
  }
}
