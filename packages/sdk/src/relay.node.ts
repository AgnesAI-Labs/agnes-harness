import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGNES_ERRORS, type Credential, JSONRPC_ERRORS } from '@agnes/protocol'
import type { Client } from './client.js'
import { JsonRpcError } from './errors.js'
import { jcs } from './jcs.js'
import type { Session } from './session.js'

export type RelayRoute =
  | {
      method: 'GET' | 'POST'
      path: string
      rpc: string
      /** Inject the server-derived principal only under a parameter the target RPC schema declares. */
      principalParam?: 'credential' | 'approverCredential'
      map?: (body: Record<string, unknown>, url: URL) => Record<string, unknown>
    }
  | {
      method: 'GET'
      path: string
      sse: 'events'
      map?: (
        body: Record<string, unknown>,
        url: URL,
      ) => { sessionId: string; types?: string[]; upto?: number; surface?: 'tui' | 'web' | 'channel' }
    }

export type RelayOptions = {
  principal: (req: IncomingMessage) => Promise<Credential | null>
  /** Select an already identity-bound SDK connection. Mandatory for SSE/poll routes. */
  clientForPrincipal?: (principal: Credential, req: IncomingMessage) => Promise<Client> | Client
  maxBodyBytes?: number
  heartbeatMs?: number
  /** Bounds best-effort iterator cleanup after an SSE response closes. */
  iteratorReturnTimeoutMs?: number
}

const STRIPPED_KEYS = new Set([
  'actor',
  'credential',
  'approverCredential',
  '_meta',
  '__proto__',
  'constructor',
  'prototype',
])
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_ITERATOR_RETURN_TIMEOUT_MS = 1_000
// A Client represents one authenticated daemon connection. Keep the binding
// process-wide so separate relay handlers cannot accidentally reuse that same
// connection for different principals.
const CLIENT_PRINCIPALS = new WeakMap<Client, string>()
type StreamRef = {
  count: number
  typesKey: string
  session: Promise<Session>
  closing?: Promise<void>
}
const STREAM_REFS = new WeakMap<Client, Map<string, StreamRef>>()

/** Remove identity claims at every depth without trusting a caller-controlled object graph. */
export function stripIdentity<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value

  const root: unknown = Array.isArray(value) ? [] : Object.create(null)
  const seen = new WeakMap<object, unknown>([[value as object, root]])
  const pending: Array<{ source: object; target: unknown[] | Record<string, unknown> }> = [
    { source: value as object, target: root as unknown[] | Record<string, unknown> },
  ]

  while (pending.length > 0) {
    const item = pending.pop()
    if (!item) break
    for (const [key, child] of Object.entries(item.source)) {
      if (STRIPPED_KEYS.has(key)) continue
      if (child === null || typeof child !== 'object') {
        if (Array.isArray(item.target)) item.target[Number(key)] = child
        else item.target[key] = child
        continue
      }
      let copy = seen.get(child)
      if (!copy) {
        copy = Array.isArray(child) ? [] : Object.create(null)
        seen.set(child, copy)
        pending.push({ source: child, target: copy as unknown[] | Record<string, unknown> })
      }
      if (Array.isArray(item.target)) item.target[Number(key)] = copy
      else item.target[key] = copy
    }
  }

  return root as T
}

function statusForRpcError(code: number): number {
  switch (code) {
    case JSONRPC_ERRORS.INVALID_PARAMS:
    case AGNES_ERRORS.SEMANTIC_REJECTED:
    case AGNES_ERRORS.PRESET_SWITCH_REJECTED:
    case AGNES_ERRORS.APPROVAL_REJECTED:
      return 400
    case AGNES_ERRORS.SESSION_BUSY:
      return 409
    case AGNES_ERRORS.SESSION_NOT_FOUND:
      return 404
    case AGNES_ERRORS.AUTH_INVALID:
      return 401
    case AGNES_ERRORS.CAPABILITY_DENIED:
      return 403
    case AGNES_ERRORS.OVERLOADED:
      return 429
    default:
      return 500
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const length = Number(req.headers['content-length'])
  if (Number.isFinite(length) && length > maxBytes) {
    req.resume()
    throw new RelayHttpError(413, 'body too large')
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.byteLength
    if (size > maxBytes) {
      req.resume()
      throw new RelayHttpError(413, 'body too large')
    }
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RelayHttpError(400, 'invalid json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayHttpError(400, 'json object required')
  }
  return parsed as Record<string, unknown>
}

class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function validateRoutes(routes: RelayRoute[]): void {
  const keys = new Set<string>()
  for (const route of routes) {
    // Only origin-form local paths are legal. In particular, an absolute URL or a
    // protocol-relative metadata-service URL can never turn this proxy into an SSRF gadget.
    if (!route.path.startsWith('/api/') || route.path.startsWith('//') || /[?#]/.test(route.path)) {
      throw new TypeError(`relay route must be an /api/ origin path: ${route.path}`)
    }
    if ('rpc' in route && !route.rpc.startsWith('_agnes/v1/')) {
      throw new TypeError(`relay rpc must be an _agnes/v1 method: ${route.rpc}`)
    }
    if ('rpc' in route) {
      const expected =
        route.rpc === '_agnes/v1/participant.join'
          ? 'credential'
          : route.rpc === '_agnes/v1/approval.decide'
            ? 'approverCredential'
            : undefined
      if (route.principalParam !== expected) {
        const requirement = expected ? `requires ${expected}` : 'does not accept a principal parameter'
        throw new TypeError(`relay rpc ${route.rpc} ${requirement}`)
      }
    }
    const key = `${route.method}\0${route.path}`
    if (keys.has(key)) throw new TypeError(`duplicate relay route: ${route.method} ${route.path}`)
    keys.add(key)
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  let payload: string
  try {
    payload = JSON.stringify(body) ?? 'null'
  } catch {
    status = 500
    payload = '{"error":"internal"}'
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(payload)
  } catch {
    res.destroy()
  }
}

function routeTarget(route: Extract<RelayRoute, { sse: 'events' }>, body: Record<string, unknown>, url: URL) {
  return route.map?.(body, url) ?? { sessionId: url.searchParams.get('session') ?? '' }
}

function drainRequest(req: IncomingMessage): void {
  if (!req.destroyed && !req.complete) req.resume()
}

async function settleIteratorReturn(iterator: AsyncIterator<unknown> | undefined, timeoutMs: number) {
  if (!iterator?.return) return
  const returned = Promise.resolve().then(() => iterator.return?.())
  // Observe failures even when the timeout wins; a late rejection must not become unhandled.
  const observed = returned.then(
    () => undefined,
    () => undefined,
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      observed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createRelay(client: Client, allowlist: RelayRoute[], opts: RelayOptions) {
  validateRoutes(allowlist)
  const routes = Object.freeze(allowlist.map((route) => Object.freeze({ ...route })))
  if (routes.some((route) => 'sse' in route) && !opts.clientForPrincipal)
    throw new TypeError('relay SSE/poll routes require clientForPrincipal')
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const iteratorReturnTimeoutMs = opts.iteratorReturnTimeoutMs ?? DEFAULT_ITERATOR_RETURN_TIMEOUT_MS
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0)
    throw new TypeError('invalid relay maxBodyBytes')
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new TypeError('invalid relay heartbeatMs')
  if (!Number.isSafeInteger(iteratorReturnTimeoutMs) || iteratorReturnTimeoutMs < 0)
    throw new TypeError('invalid relay iteratorReturnTimeoutMs')
  const principalClient = async (principal: Credential, req: IncomingMessage): Promise<Client> => {
    const selected = (await opts.clientForPrincipal?.(principal, req)) ?? client
    const fingerprint = createHash('sha256').update(jcs(principal)).digest('hex')
    const bound = CLIENT_PRINCIPALS.get(selected)
    if (bound !== undefined && bound !== fingerprint)
      throw new RelayHttpError(403, 'client principal mismatch')
    CLIENT_PRINCIPALS.set(selected, fingerprint)
    return selected
  }

  const attachStream = async (selected: Client, sessionId: string, types?: string[]) => {
    const typesKey = jcs(types ?? [])
    const refs = STREAM_REFS.get(selected) ?? new Map<string, StreamRef>()
    STREAM_REFS.set(selected, refs)
    let current = refs.get(sessionId)
    while (current?.closing) {
      await current.closing.catch(() => undefined)
      current = refs.get(sessionId)
    }
    if (current && current.typesKey !== typesKey)
      throw new RelayHttpError(409, 'session stream filter mismatch')
    const ref =
      current ??
      ({
        count: 0,
        typesKey,
        session: selected.session.attach(sessionId, {
          filter: { ...(types ? { types } : {}), acpUpdates: false },
        }),
      } satisfies StreamRef)
    ref.count++
    refs.set(sessionId, ref)
    STREAM_REFS.set(selected, refs)
    let session: Session
    try {
      session = await ref.session
    } catch (error) {
      ref.count--
      if (ref.count === 0) refs.delete(sessionId)
      throw error
    }
    let released = false
    return {
      session,
      async release(): Promise<void> {
        if (released) return
        released = true
        ref.count--
        if (ref.count > 0) return
        const closing = Promise.resolve().then(() => session.detach())
        ref.closing = closing
        try {
          await closing
        } finally {
          if (refs.get(sessionId) === ref) refs.delete(sessionId)
          if (refs.size === 0) STREAM_REFS.delete(selected)
        }
      },
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Reject absolute-form request targets. Reverse proxies should pass origin-form;
      // accepting attacker-selected authorities makes route mappers an SSRF footgun.
      const rawUrl = req.url ?? '/'
      if (!rawUrl.startsWith('/') || rawUrl.startsWith('//'))
        throw new RelayHttpError(400, 'invalid request target')
      const url = new URL(rawUrl, 'http://relay.invalid')
      const route = routes.find(
        (candidate) => candidate.method === req.method && candidate.path === url.pathname,
      )
      if (!route) {
        drainRequest(req)
        return writeJson(res, 404, { error: 'not found' })
      }

      const principal = await opts.principal(req)
      if (!principal) {
        drainRequest(req)
        return writeJson(res, 401, { error: 'unauthenticated' })
      }

      const body = stripIdentity(await readBody(req, maxBodyBytes))
      if ('sse' in route) {
        const target = routeTarget(route, body, url)
        if (!target.sessionId) throw new RelayHttpError(400, 'sessionId required')
        const selected = await principalClient(principal, req)

        // A browser that cannot establish or retain SSE retries this same allowlisted
        // endpoint with transport=poll. The response is one projectUI snapshot; the
        // browser owns the polling cadence, so the relay never creates an unbounded loop.
        if (url.searchParams.get('transport') === 'poll') {
          const timeline = await selected.call('_agnes/v1/session.projectUI', {
            sessionId: target.sessionId,
            ...(target.upto !== undefined ? { upto: target.upto } : {}),
            ...(target.surface !== undefined ? { surface: target.surface } : {}),
          })
          return writeJson(res, 200, timeline)
        }

        const attached = await attachStream(selected, target.sessionId, target.types)
        const session = attached.session
        let iterator: AsyncIterator<unknown> | undefined
        let timer: ReturnType<typeof setInterval> | undefined
        try {
          if (res.destroyed || res.writableEnded) return
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          res.flushHeaders()

          timer = setInterval(() => {
            if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) {
              try {
                res.write(': ping\n\n')
              } catch {
                res.destroy()
              }
            }
          }, heartbeatMs)
          const waitWritable = async (): Promise<boolean> => {
            if (!res.writableNeedDrain) return !res.destroyed && !res.writableEnded
            return new Promise<boolean>((resolve) => {
              const finish = (writable: boolean): void => {
                res.off('drain', onDrain)
                res.off('close', onClose)
                res.off('error', onError)
                resolve(writable)
              }
              const onDrain = () => finish(!res.destroyed && !res.writableEnded)
              const onClose = () => finish(false)
              const onError = () => finish(false)
              res.once('drain', onDrain)
              res.once('close', onClose)
              res.once('error', onError)
            })
          }
          const nextOrClosed = <T>(next: Promise<T>): Promise<T | 'closed'> => {
            if (res.destroyed || res.writableEnded) return Promise.resolve('closed')
            return new Promise<T | 'closed'>((resolve, reject) => {
              const cleanup = () => {
                res.off('close', onClose)
                res.off('error', onError)
              }
              const onClose = (): void => {
                cleanup()
                resolve('closed')
              }
              const onError = (): void => {
                cleanup()
                resolve('closed')
              }
              res.once('close', onClose)
              res.once('error', onError)
              void next.then(
                (value) => {
                  cleanup()
                  resolve(value)
                },
                (error: unknown) => {
                  cleanup()
                  reject(error)
                },
              )
            })
          }
          const writeEvent = async (value: unknown): Promise<boolean> => {
            if (!(await waitWritable())) return false
            const accepted = res.write(`data: ${JSON.stringify(value)}\n\n`)
            return accepted || waitWritable()
          }
          iterator = session
            .events({ ...(target.types ? { types: target.types } : {}) })
            [Symbol.asyncIterator]()
          while (!res.destroyed && !res.writableEnded) {
            const next = await nextOrClosed(iterator.next())
            if (next === 'closed' || next.done) break
            if (!(await writeEvent(next.value))) break
          }
        } finally {
          if (timer) clearInterval(timer)
          try {
            await settleIteratorReturn(iterator, iteratorReturnTimeoutMs)
          } finally {
            await attached.release()
            if (!res.destroyed && !res.writableEnded) res.end()
          }
        }
        return
      }

      const selected = await principalClient(principal, req)
      const mapped = stripIdentity(route.map ? route.map(body, url) : body)
      const params = {
        ...mapped,
        ...(route.principalParam ? { [route.principalParam]: principal } : {}),
      }
      const result = await selected.call(route.rpc, params)
      writeJson(res, 200, result)
    } catch (error) {
      if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) res.destroy()
        return
      }
      drainRequest(req)
      if (error instanceof RelayHttpError) return writeJson(res, error.status, { error: error.message })
      if (error instanceof JsonRpcError) {
        return writeJson(res, statusForRpcError(error.code), { error: error.data.code, data: error.data })
      }
      writeJson(res, 500, { error: 'internal' })
    }
  }
}
