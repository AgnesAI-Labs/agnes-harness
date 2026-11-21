import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import {
  REMOTE_FRONTEND_INFO,
  REMOTE_FRONTEND_SESSION_PREFIX,
  remoteFrontendOrigin,
  remoteFrontendSessionPath,
  validateMethod,
} from '@agnes/protocol'
import type { AdminCloudAuthorization } from '@agnes/protocol/gen/app-server'

/** A transport-only relay on the isolated cloud origin. It cannot reach local management routes. */
export function createCloudGateway() {
  type Grant = {
    origin: string
    trafficToken: string
    expiresAt: number
    refresh?: () => Promise<AdminCloudAuthorization>
    refreshing?: Promise<void>
    checking?: Promise<void>
    rejected: boolean
    reconnect: boolean
    retryAt: number
    sockets: Set<Duplex>
    exchanges: Set<() => void>
    timer?: ReturnType<typeof setTimeout>
  }
  const grants = new Map<string, Grant>()
  const requests = new Set<ClientRequest>()
  let closed = false
  const revoke = (prefix: string, except?: () => void) => {
    const grant = grants.get(prefix)
    grants.delete(prefix)
    if (grant?.timer) clearTimeout(grant.timer)
    for (const abort of [...(grant?.exchanges ?? [])]) if (abort !== except) abort()
    for (const socket of grant?.sockets ?? []) socket.destroy()
  }
  const register = (origin: string, result: AdminCloudAuthorization, refresh?: Grant['refresh']) => {
    if (closed) throw Error('cloud gateway closed')
    if (!validateMethod('_agnes/v1/admin.cloud.authorize', 'result', result).ok)
      throw Error('invalid authorization')
    if (!result.trafficToken) return false
    const target = new URL(remoteFrontendOrigin(origin))
    if (
      target.protocol !== 'https:' ||
      target.port ||
      !/^8443-[a-z0-9-]+\.[a-z0-9-]+\.tencentags\.com$/u.test(target.hostname)
    )
      throw Error('invalid sandbox target')
    for (const [path, grant] of grants) if (grant.expiresAt <= Date.now()) revoke(path)
    const prefix = remoteFrontendSessionPath(result.token)
    if (grants.size >= 32 && !grants.has(prefix)) {
      const oldest = grants.keys().next().value
      if (oldest) revoke(oldest)
    }
    revoke(prefix)
    grants.set(prefix, {
      origin: target.origin,
      trafficToken: result.trafficToken,
      expiresAt: result.expiresAt,
      ...(refresh ? { refresh } : {}),
      rejected: false,
      reconnect: false,
      retryAt: 0,
      sockets: new Set(),
      exchanges: new Set(),
    })
    const grant = grants.get(prefix)
    if (grant) {
      grant.timer = setTimeout(() => revoke(prefix), Math.max(1, result.expiresAt - Date.now()))
      grant.timer.unref()
    }
    return true
  }
  const resolve = (request: IncomingMessage) => {
    const path = request.url ?? ''
    if (!path.startsWith(REMOTE_FRONTEND_SESSION_PREFIX)) return
    const url = new URL(path, 'http://127.0.0.1')
    const prefix = url.pathname.split('/').slice(0, 4).join('/')
    const grant = grants.get(prefix)
    if (closed || !grant || grant.expiresAt <= Date.now()) {
      revoke(prefix)
      return null
    }
    // Never route user-supplied absolute URLs, authority changes or normalized dot-segment escapes.
    if (!path.startsWith(`${prefix}/`) || !url.pathname.startsWith(`${prefix}/`)) return null
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return null
    if (
      request.headers['sec-fetch-site'] &&
      !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))
    )
      return null
    return { grant, prefix, url: new URL(`${url.pathname}${url.search}`, grant.origin) }
  }
  const rejectGrant = (prefix: string, grant: Grant, except?: () => void) => {
    if (!grant.refresh) return revoke(prefix, except)
    grant.rejected = true
    grant.trafficToken = ''
    for (const abort of [...grant.exchanges]) if (abort !== except) abort()
    for (const socket of grant.sockets) socket.destroy()
  }
  const renew = async (prefix: string, grant: Grant) => {
    if (grant.refreshing) return grant.refreshing
    if (!grant.refresh || grant.retryAt > Date.now()) throw Error('cloud authorization unavailable')
    grant.refreshing = (async () => {
      try {
        const next = await grant.refresh?.()
        if (closed || grants.get(prefix) !== grant || grant.expiresAt <= Date.now()) throw Error('revoked')
        if (!next?.trafficToken || !validateMethod('_agnes/v1/admin.cloud.authorize', 'result', next).ok)
          throw Error('invalid authorization')
        // Keep this browser capability's original expiry and B session path; refresh only transport access.
        grant.trafficToken = next.trafficToken
        grant.rejected = false
        grant.reconnect = false
        grant.retryAt = 0
      } catch {
        grant.retryAt = Date.now() + 30_000
        throw Error('cloud authorization unavailable')
      }
    })().finally(() => {
      delete grant.refreshing
    })
    return grant.refreshing
  }
  const own = (request: ClientRequest) => {
    requests.add(request)
    request.once('close', () => requests.delete(request))
    return request
  }
  const checkForbidden = (prefix: string, grant: Grant, except?: () => void): Promise<void> => {
    if (grant.checking) return grant.checking
    const trafficToken = grant.trafficToken
    grant.checking = new Promise<number | undefined>((resolve) => {
      // A stream/operation can be refused while the deployment credential remains valid.
      // Verify the fixed owner-info endpoint rather than trusting an error body or proxy header.
      const probe = own(
        httpsRequest(
          new URL(prefix + REMOTE_FRONTEND_INFO, grant.origin),
          {
            headers: { origin: grant.origin, 'e2b-traffic-access-token': trafficToken },
            signal: AbortSignal.timeout(3000),
          },
          (response) => {
            response.resume()
            resolve(response.statusCode)
          },
        ),
      )
      probe.once('error', () => resolve(undefined))
      probe.end()
    })
      .catch(() => undefined)
      .then((status) => {
        if (
          grants.get(prefix) === grant &&
          grant.trafficToken === trafficToken &&
          (status === 401 || status === 403)
        )
          rejectGrant(prefix, grant, except)
      })
      .finally(() => {
        delete grant.checking
      })
    return grant.checking
  }
  const headers = (request: IncomingMessage, origin: string, trafficToken: string, upgrade = false) => {
    const result: Record<string, string> = { origin, 'e2b-traffic-access-token': trafficToken }
    const allowed = [
      'accept',
      'content-type',
      'range',
      'if-none-match',
      'if-modified-since',
      'x-agnes-stream-open',
    ]
    if (upgrade)
      allowed.push(
        'sec-websocket-key',
        'sec-websocket-version',
        'sec-websocket-protocol',
        'sec-websocket-extensions',
      )
    for (const name of allowed) {
      const value = request.headers[name]
      if (typeof value === 'string') result[name] = value
    }
    if (upgrade) Object.assign(result, { connection: 'Upgrade', upgrade: 'websocket' })
    return result
  }
  return {
    register,
    async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const route = resolve(request)
      if (route === undefined) return false
      if (!route) {
        request.resume()
        response.writeHead(401, { 'cache-control': 'no-store' }).end()
        return true
      }
      if (route.grant.rejected) {
        try {
          await renew(route.prefix, route.grant)
        } catch {
          request.resume()
          response.writeHead(503, { 'cache-control': 'no-store', 'retry-after': '30' }).end()
          return true
        }
      }
      if (closed || request.aborted || response.destroyed) return true
      if (grants.get(route.prefix) !== route.grant || route.grant.expiresAt <= Date.now()) {
        revoke(route.prefix)
        request.resume()
        response.writeHead(401, { 'cache-control': 'no-store' }).end()
        return true
      }
      let upstream: ClientRequest | undefined
      const abort = () => {
        clearTimeout(expiry)
        route.grant.exchanges.delete(abort)
        upstream?.destroy()
        response.destroy()
      }
      const expiry = setTimeout(abort, Math.max(1, route.grant.expiresAt - Date.now()))
      expiry.unref()
      route.grant.exchanges.add(abort)
      upstream = own(
        (route.url.protocol === 'https:' ? httpsRequest : httpRequest)(
          route.url,
          {
            method: request.method,
            headers: headers(request, route.grant.origin, route.grant.trafficToken),
          },
          async (incoming) => {
            incoming.on('error', () => response.destroy())
            incoming.once('aborted', () => response.destroy())
            const status = incoming.statusCode ?? 502
            if (status === 401) rejectGrant(route.prefix, route.grant, abort)
            else if (status === 403) await checkForbidden(route.prefix, route.grant, abort)
            if (response.destroyed) {
              incoming.resume()
              return
            }
            if (status >= 300 && status < 400 && status !== 304) {
              incoming.resume()
              response.writeHead(502, { 'cache-control': 'no-store' }).end()
              return
            }
            const safe: Record<string, string> = {
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
            }
            for (const name of ['content-type', 'content-range', 'accept-ranges', 'content-disposition']) {
              const value = incoming.headers[name]
              if (typeof value === 'string') safe[name] = value
            }
            response.writeHead(status, safe)
            incoming.pipe(response)
          },
        ),
      )
      upstream.setTimeout(30_000, () => upstream.destroy())
      upstream.on('error', () => {
        if (response.headersSent) response.destroy()
        else response.writeHead(502, { 'cache-control': 'no-store' }).end()
      })
      request.once('aborted', () => upstream.destroy())
      request.once('error', () => upstream.destroy())
      response.once('close', () => {
        clearTimeout(expiry)
        route.grant.exchanges.delete(abort)
        upstream.destroy()
      })
      request.pipe(upstream)
      return true
    },
    async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
      const route = resolve(request)
      if (route === undefined) return false
      if (!route) {
        socket.destroy()
        return true
      }
      if (route.grant.rejected || (route.grant.reconnect && route.grant.refresh)) {
        try {
          await renew(route.prefix, route.grant)
        } catch {
          socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 30\r\n\r\n')
          return true
        }
      }
      if (closed || socket.destroyed) return true
      const upstream = own(
        httpsRequest(route.url, {
          headers: headers(request, route.grant.origin, route.grant.trafficToken, true),
        }),
      )
      upstream.setTimeout(10_000, () => upstream.destroy())
      upstream.on('upgrade', (incoming, peer, upstreamHead) => {
        if (closed || socket.destroyed || grants.get(route.prefix) !== route.grant) {
          peer.destroy()
          return
        }
        upstream.setTimeout(0)
        const raw = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket']
        for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
          const value = incoming.headers[name]
          if (typeof value === 'string') raw.push(`${name}: ${value}`)
        }
        socket.write(`${raw.join('\r\n')}\r\n\r\n`)
        if (head.length) peer.write(head)
        if (upstreamHead.length) socket.write(upstreamHead)
        route.grant.sockets.add(socket)
        route.grant.sockets.add(peer)
        const timer = setTimeout(
          () => {
            socket.destroy()
            peer.destroy()
          },
          Math.max(1, route.grant.expiresAt - Date.now()),
        )
        timer.unref()
        const close = () => {
          clearTimeout(timer)
          route.grant.sockets.delete(socket)
          route.grant.sockets.delete(peer)
          route.grant.reconnect = true
          socket.destroy()
          peer.destroy()
        }
        socket.once('close', close)
        peer.once('close', close)
        socket.on('error', close)
        peer.on('error', close)
        socket.pipe(peer).pipe(socket)
      })
      upstream.on('response', async (incoming) => {
        incoming.on('error', () => socket.destroy())
        incoming.once('aborted', () => socket.destroy())
        incoming.resume()
        if (incoming.statusCode === 401) rejectGrant(route.prefix, route.grant)
        else if (incoming.statusCode === 403) await checkForbidden(route.prefix, route.grant)
        socket.destroy()
      })
      upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
      upstream.end()
      return true
    },
    close() {
      closed = true
      for (const prefix of grants.keys()) revoke(prefix)
      for (const request of requests) request.destroy()
      requests.clear()
    },
  }
}
