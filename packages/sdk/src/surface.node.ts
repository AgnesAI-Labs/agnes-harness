import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ExtensionCallParams, JsonValue } from '@agnes/protocol'
import type { ExtensionClient } from './extensions.node.js'
import { stripIdentity } from './relay.node.js'

export type SurfaceServiceRoute = Readonly<{
  method: 'GET' | 'POST'
  path: string
  extension: string
  service: string
  /** A BFF creates effect command IDs from its authenticated request context; browser input cannot set one. */
  commandId?: (request: IncomingMessage, body: Record<string, JsonValue>, url: URL) => string | undefined
  map?: (body: Record<string, JsonValue>, url: URL) => Record<string, JsonValue>
}>

export type SurfaceRelayOptions = Readonly<{
  /** The BFF authenticates the browser request and returns a connection bound to that one subject. */
  clientForRequest: (
    request: IncomingMessage,
  ) => Promise<SurfaceServiceClient | null> | SurfaceServiceClient | null
  maxBodyBytes?: number
}>

export type SurfaceServiceClient = Readonly<{
  /** Authenticated server-side session binding; browser input is never consulted for this value. */
  sessionId: string
  extensions: ExtensionClient
}>

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const IDENTITY_KEYS = new Set([
  'actor',
  'credential',
  'approverCredential',
  '_meta',
  'sourceAuth',
  'secret',
  'commandId',
])

function validRoute(route: SurfaceServiceRoute): boolean {
  return (
    route.path.startsWith('/api/') &&
    !route.path.startsWith('//') &&
    !/[?#]/.test(route.path) &&
    /^[a-z0-9-]+\/[a-z0-9-]+$/.test(route.extension) &&
    /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(route.service)
  )
}

function cleanInput(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const stripped = stripIdentity(value)
  for (const key of IDENTITY_KEYS) delete stripped[key]
  return stripped
}

function cleanUrl(url: URL): URL {
  const clean = new URL(url)
  for (const key of IDENTITY_KEYS) clean.searchParams.delete(key)
  return clean
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, JsonValue>> {
  const contentLength = Number(req.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    req.resume()
    throw new SurfaceRelayError(413, 'body too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += bytes.byteLength
    if (total > maxBodyBytes) {
      req.resume()
      throw new SurfaceRelayError(413, 'body too large')
    }
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new SurfaceRelayError(400, 'JSON object required')
    return parsed as Record<string, JsonValue>
  } catch (error) {
    if (error instanceof SurfaceRelayError) throw error
    throw new SurfaceRelayError(400, 'invalid JSON')
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

class SurfaceRelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Builds a closed Surface BFF handler. Routes select a manifest-qualified Service at deployment time;
 * browser requests only carry application input and can never choose an Agnes RPC, Actor, or secret.
 */
export function createSurfaceRelay(
  configuredRoutes: readonly SurfaceServiceRoute[],
  options: SurfaceRelayOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > DEFAULT_MAX_BODY_BYTES)
    throw new TypeError('invalid Surface relay body limit')
  const routes = configuredRoutes.map((route) => Object.freeze({ ...route }))
  const keys = new Set<string>()
  for (const route of routes) {
    if (!validRoute(route)) throw new TypeError(`invalid Surface relay route: ${route.path}`)
    const key = `${route.method}\0${route.path}`
    if (keys.has(key)) throw new TypeError(`duplicate Surface relay route: ${route.method} ${route.path}`)
    keys.add(key)
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const rawUrl = request.url ?? '/'
      if (!rawUrl.startsWith('/') || rawUrl.startsWith('//'))
        throw new SurfaceRelayError(400, 'invalid request')
      const url = new URL(rawUrl, 'http://surface.invalid')
      const route = routes.find(
        (candidate) => candidate.method === request.method && candidate.path === url.pathname,
      )
      if (!route) {
        request.resume()
        writeJson(response, 404, { error: 'not found' })
        return
      }
      const client = await options.clientForRequest(request)
      if (!client) {
        request.resume()
        writeJson(response, 401, { error: 'unauthenticated' })
        return
      }
      const body = cleanInput(await readJsonBody(request, maxBodyBytes))
      const safeUrl = cleanUrl(url)
      const input = route.map?.(body, safeUrl) ?? body
      const commandId = route.commandId?.(request, body, safeUrl)
      const params: ExtensionCallParams = {
        sessionId: client.sessionId,
        extension: route.extension,
        service: route.service,
        input,
        ...(commandId ? { commandId } : {}),
      }
      const result = await client.extensions.call(params)
      writeJson(response, 200, result.output)
    } catch (error) {
      if (error instanceof SurfaceRelayError) {
        writeJson(response, error.status, { error: error.message })
        return
      }
      writeJson(response, 502, { error: 'service unavailable' })
    }
  }
}
