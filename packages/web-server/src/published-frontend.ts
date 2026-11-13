import { readFile } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestListener,
} from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  type FrontendPublication,
  REMOTE_FRONTEND_AUTH,
  REMOTE_FRONTEND_INFO,
  REMOTE_FRONTEND_KEY_VERSION,
  REMOTE_FRONTEND_VERSION,
  REMOTE_FRONTEND_WS,
} from '@agnes/protocol'
import { publicationAuthentication } from './published-auth.js'

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function headers(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const skip = new Set([
    ...HOP_HEADERS,
    ...(source.connection ?? '').split(',').map((v) => v.trim().toLowerCase()),
  ])
  return Object.fromEntries(Object.entries(source).filter(([key]) => !skip.has(key)))
}

/**
 * Explicit profile-owner publication. Key mode verifies a deployment credential before delegating
 * local workbench authority; legacy public mode delegates it to every network caller.
 * This is not the authenticated multi-user WSS leg.
 * Targets are fixed by the launcher; callers cannot choose an upstream or inject proxy identity.
 */
export async function createPublishedFrontend(input: {
  publication: FrontendPublication
  webOrigin: string
  instanceId: string
  wsUrl(): string
  current(): Promise<boolean>
}): Promise<{ url: string; close(): Promise<void> }> {
  const { publication } = input
  if (!publication.enabled || !['public-owner', 'key-owner'].includes(publication.access))
    throw new Error('publication disabled')
  const authentication =
    publication.access === 'key-owner'
      ? publicationAuthentication(publication.auth?.keySha256 ?? '')
      : undefined
  const local = new URL(input.webOrigin)
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1')
    throw new Error('publication needs a local workbench')
  const sockets = new Set<Duplex>()
  let closed = false
  const allowed = async () => {
    if (closed) return false
    try {
      return (await input.current()) && !closed
    } catch {
      return false
    }
  }
  const forwarded = (source: IncomingHttpHeaders, upgrade = false): IncomingHttpHeaders => {
    const result = headers(source)
    for (const key of Object.keys(result)) {
      if (/^(?:forwarded|x-forwarded-|x-agnes-|proxy-authorization|authorization|cookie|referer)/iu.test(key))
        delete result[key]
    }
    result.host = local.host
    result.origin = local.origin
    result['sec-fetch-site'] = 'same-origin'
    if (upgrade) {
      result.connection = 'Upgrade'
      result.upgrade = 'websocket'
    }
    return result
  }
  const serve: RequestListener = async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? 'content-type',
      'access-control-expose-headers': 'content-disposition, content-type',
      'access-control-allow-private-network': 'true',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    }
    try {
      if (!(await allowed())) {
        req.resume()
        res.writeHead(503, cors).end()
        return
      }
      if (req.method === 'OPTIONS') {
        req.resume()
        res.writeHead(204, cors).end()
        return
      }
      if (authentication && new URL(req.url ?? '/', local).pathname === REMOTE_FRONTEND_AUTH) {
        if (req.method !== 'POST') {
          req.resume()
          res.writeHead(405, cors).end()
          return
        }
        const session = await authentication.exchange(req)
        res
          .writeHead(session ? 200 : 401, { ...cors, 'content-type': 'application/json' })
          .end(JSON.stringify(session ?? { error: 'invalid_cloud_key' }))
        return
      }
      const authorized = authentication?.resolve(req.url ?? '/')
      if (authentication && !authorized) {
        req.resume()
        res.writeHead(401, cors).end()
        return
      }
      const requestUrl = authorized?.url ?? req.url ?? '/'
      const path = new URL(requestUrl, local).pathname
      if (path === '/' && !new URL(req.url ?? '/', local).searchParams.has('remote')) {
        const publicOrigin = new URL(`${publication.tls ? 'https' : 'http'}://${req.headers.host}`).origin
        const target = new URL(req.url ?? '/', publicOrigin)
        target.searchParams.set('remote', publicOrigin)
        res.writeHead(307, { ...cors, location: `${target.pathname}${target.search}` }).end()
        return
      }
      if (path === REMOTE_FRONTEND_INFO) {
        if (req.method !== 'GET') {
          req.resume()
          res.writeHead(405, cors).end()
          return
        }
        res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(
          JSON.stringify({
            version: authentication ? REMOTE_FRONTEND_KEY_VERSION : REMOTE_FRONTEND_VERSION,
            access: publication.access,
            wsPath: REMOTE_FRONTEND_WS,
            instanceId: input.instanceId,
          }),
        )
        return
      }
      const upstream = httpRequest(
        {
          hostname: local.hostname,
          port: local.port,
          method: req.method,
          path: requestUrl.startsWith('/') ? requestUrl : '/',
          headers: forwarded(req.headers),
        },
        (reply) => {
          const output = { ...headers(reply.headers), ...cors }
          // Do not send a browser back to B's loopback address after a local canonical redirect.
          if (typeof output.location === 'string' && output.location.startsWith(local.origin))
            output.location = output.location.slice(local.origin.length) || '/'
          if (
            authorized &&
            typeof output.location === 'string' &&
            output.location.startsWith('/') &&
            !output.location.startsWith('//')
          )
            output.location = `${authorized.prefix}${output.location}`
          res.writeHead(reply.statusCode ?? 502, output)
          reply.pipe(res)
        },
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, cors)
        res.end()
      })
      req.once('aborted', () => upstream.destroy())
      res.once('close', () => upstream.destroy())
      req.pipe(upstream)
    } catch {
      req.resume()
      if (!res.headersSent) res.writeHead(503, cors)
      res.end()
    }
  }
  const server = publication.tls
    ? createTlsServer(
        { cert: await readFile(publication.tls.certFile), key: await readFile(publication.tls.keyFile) },
        serve,
      )
    : createServer(serve)
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    if (closed) socket.destroy()
  })
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      if (!(await allowed())) {
        socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n')
        return
      }
      const authorized = authentication?.resolve(req.url ?? '/')
      if (authentication && !authorized) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      const requestUrl = authorized?.url ?? req.url ?? '/'
      const rpc = new URL(requestUrl, local).pathname === REMOTE_FRONTEND_WS
      const target = rpc ? new URL(input.wsUrl()) : local
      if (!['http:', 'ws:'].includes(target.protocol) || target.hostname !== '127.0.0.1')
        throw new Error('invalid local target')
      const h = forwarded(req.headers, true)
      h.host = target.host
      const upstream = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: rpc ? '/' : requestUrl,
        method: 'GET',
        headers: h,
      })
      upstream.on('upgrade', (reply, peer, initial) => {
        if (closed) {
          peer.destroy()
          socket.destroy()
          return
        }
        sockets.add(peer)
        peer.once('close', () => sockets.delete(peer))
        const lines = Object.entries(reply.headers).flatMap(([key, value]) =>
          value === undefined
            ? []
            : Array.isArray(value)
              ? value.map((v) => `${key}: ${v}`)
              : [`${key}: ${value}`],
        )
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
        if (initial.length) socket.write(initial)
        if (head.length) peer.write(head)
        peer.on('error', () => socket.destroy())
        socket.on('error', () => peer.destroy())
        socket.once('close', () => peer.destroy())
        peer.once('close', () => socket.destroy())
        socket.pipe(peer).pipe(socket)
        if (authorized) {
          const timer = setTimeout(() => socket.destroy(), Math.max(0, authorized.expiresAt - Date.now()))
          timer.unref()
          socket.once('close', () => clearTimeout(timer))
        }
      })
      upstream.on('response', (reply) => {
        reply.resume()
        socket.end(`HTTP/1.1 ${reply.statusCode ?? 502} Unavailable\r\nConnection: close\r\n\r\n`)
      })
      upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
      upstream.end()
    })().catch(() => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(publication.port, publication.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', () => {
    closed = true
    for (const socket of sockets) socket.destroy()
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing publication listener')
  const hostname = address.address.includes(':') ? `[${address.address}]` : address.address
  let closing: Promise<void> | undefined
  return {
    url: `${publication.tls ? 'https' : 'http'}://${hostname}:${address.port}`,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        closed = true
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
      })),
  }
}
