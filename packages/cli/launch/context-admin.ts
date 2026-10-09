import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type AppServerParams,
  type AppServerResult,
  httpRpcError,
  normalizeRpcError,
  type RpcError,
  validateMethod,
} from '@agnes/protocol'

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
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', origin)
    const isFeedback = url.pathname === '/api/feedback' && feedback !== undefined
    const isMemory = url.pathname === '/api/memory' && memory !== undefined
    const isObservability = url.pathname === '/api/observability' && observability !== undefined
    if (url.pathname !== '/api/context' && !isMemory && !isObservability && !isFeedback) return false
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
        if (size > (isMemory ? 8 * 1024 * 1024 : 65536)) throw new Error('request')
        chunks.push(bytes)
      }
      const input: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      )
      const method = isFeedback
        ? '_agnes/v1/admin.feedback'
        : isObservability
          ? '_agnes/v1/admin.observability'
          : isMemory
            ? '_agnes/v1/admin.memory'
            : '_agnes/v1/admin.context'
      if (!validateMethod(method, 'params', input).ok) throw new Error('request')
      reply(
        200,
        isFeedback
          ? await feedback!(input as AppServerParams<'_agnes/v1/admin.feedback'>)
          : isObservability
            ? await observability!(input as AppServerParams<'_agnes/v1/admin.observability'>)
            : isMemory
              ? await memory!(input as AppServerParams<'_agnes/v1/admin.memory'>)
              : await invoke(input as AppServerParams<'_agnes/v1/admin.context'>),
      )
    } catch (error) {
      const rpc = (error as { rpc?: RpcError })?.rpc
      reply(rpc?.code === -32006 ? 403 : 400, {
        error: rpc ? normalizeRpcError(rpc) : httpRpcError(400, 'E_ADMIN_REQUEST'),
      })
    }
    return true
  }
}
