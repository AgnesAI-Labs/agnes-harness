import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type AppServerParams,
  type AppServerResult,
  httpRpcError,
  normalizeRpcError,
  type RpcError,
  validateMethod,
} from '@agnes/protocol'
import { DaemonUnavailableError, daemonUnavailableBody } from './daemon-link.js'

/** Exact-origin HTTP compatibility adapter; daemon owns context config and workspace authority. */
export function contextAdmin(
  origin: string,
  invoke: (
    input: AppServerParams<'_agnes/v1/admin.context'>,
  ) => Promise<AppServerResult<'_agnes/v1/admin.context'>>,
  memory?: (
    input: AppServerParams<'_agnes/v1/admin.memory'>,
  ) => Promise<AppServerResult<'_agnes/v1/admin.memory'>>,
  observability?: (
    input: AppServerParams<'_agnes/v1/admin.observability'>,
  ) => Promise<AppServerResult<'_agnes/v1/admin.observability'>>,
  feedback?: (
    input: AppServerParams<'_agnes/v1/admin.feedback'>,
  ) => Promise<AppServerResult<'_agnes/v1/admin.feedback'>>,
  telemetry?: (
    input: AppServerParams<'_agnes/v1/admin.telemetry'>,
  ) => Promise<AppServerResult<'_agnes/v1/admin.telemetry'>>,
) {
  const routes = {
    '/api/context': ['_agnes/v1/admin.context', invoke],
    '/api/memory': ['_agnes/v1/admin.memory', memory],
    '/api/observability': ['_agnes/v1/admin.observability', observability],
    '/api/feedback': ['_agnes/v1/admin.feedback', feedback],
    '/api/telemetry': ['_agnes/v1/admin.telemetry', telemetry],
  } as const
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', origin)
    if (!Object.hasOwn(routes, url.pathname)) return false
    const [method, handler] = routes[url.pathname as keyof typeof routes]
    if (!handler) return false
    const reply = (status: number, data: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(JSON.stringify(data))
    }
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.host !== new URL(origin).host ||
      request.headers.origin !== origin ||
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
    ) {
      request.resume()
      reply(403, { error: httpRpcError(403, 'E_ADMIN_ORIGIN') })
      return true
    }
    try {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('request')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > (method === '_agnes/v1/admin.memory' ? 8 * 1024 * 1024 : 65536)) throw new Error('request')
        chunks.push(bytes)
      }
      const input: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      )
      if (!validateMethod(method, 'params', input).ok) throw new Error('request')
      // Each method and its handler are paired above and the matching schema has validated the input.
      reply(200, await handler(input as never))
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        reply(503, daemonUnavailableBody())
        return true
      }
      const rpc = (error as { rpc?: RpcError })?.rpc
      reply(rpc?.code === -32006 ? 403 : 400, {
        error: rpc ? normalizeRpcError(rpc) : httpRpcError(400, 'E_ADMIN_REQUEST'),
      })
    }
    return true
  }
}
