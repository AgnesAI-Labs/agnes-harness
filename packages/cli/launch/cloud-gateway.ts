import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { remoteFrontendOrigin, remoteFrontendSessionPath } from '@agnes/protocol'
import type { AdminCloudAuthorization } from '@agnes/protocol/gen/app-server'

/** A transport-only relay on the isolated cloud origin. It cannot reach local management routes. */
export function createCloudGateway() {
  const grants = new Map<string, { origin: string; trafficToken: string; expiresAt: number }>()
  const sockets = new Set<Duplex>()
  const register = (origin: string, result: AdminCloudAuthorization) => {
    if (!result.trafficToken) return false
    const target = new URL(remoteFrontendOrigin(origin))
    if (
      target.protocol !== 'https:' ||
      target.port ||
      !/^8443-[a-z0-9-]+\.[a-z0-9-]+\.tencentags\.com$/u.test(target.hostname)
    )
      throw Error('invalid sandbox target')
    for (const [path, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(path)
    const prefix = remoteFrontendSessionPath(result.token)
    if (grants.size >= 32 && !grants.has(prefix)) {
      const oldest = grants.keys().next().value
      if (oldest) grants.delete(oldest)
    }
    grants.set(prefix, {
      origin: target.origin,
      trafficToken: result.trafficToken,
      expiresAt: result.expiresAt,
    })
    return true
  }
  const resolve = (request: IncomingMessage) => {
    const path = request.url ?? ''
    if (!path.startsWith('/_agnes/remote-access/')) return
    const url = new URL(path, 'http://127.0.0.1')
    const prefix = url.pathname.split('/').slice(0, 4).join('/')
    const grant = grants.get(prefix)
    if (!grant || grant.expiresAt <= Date.now()) {
      grants.delete(prefix)
      return null
    }
    // Never route user-supplied absolute URLs, authority changes or normalized dot-segment escapes.
    if (!path.startsWith(`${prefix}/`) || !url.pathname.startsWith(`${prefix}/`)) return null
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return null
    return { grant, prefix, url: new URL(`${url.pathname}${url.search}`, grant.origin) }
  }
  const headers = (request: IncomingMessage, origin: string, trafficToken: string, upgrade = false) => {
    const result: Record<string, string> = { origin, 'e2b-traffic-access-token': trafficToken }
    const allowed = ['accept', 'content-type', 'range', 'if-none-match', 'if-modified-since']
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
      const upstream = (route.url.protocol === 'https:' ? httpsRequest : httpRequest)(
        route.url,
        {
          method: request.method,
          headers: headers(request, route.grant.origin, route.grant.trafficToken),
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502
          if (status === 401 || status === 403) grants.delete(route.prefix)
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
          incoming.on('error', () => response.destroy())
          incoming.pipe(response)
        },
      )
      upstream.setTimeout(30_000, () => upstream.destroy())
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
      request.once('aborted', () => upstream.destroy())
      response.once('close', () => upstream.destroy())
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
      const upstream = httpsRequest(route.url, {
        headers: headers(request, route.grant.origin, route.grant.trafficToken, true),
      })
      upstream.setTimeout(10_000, () => upstream.destroy())
      upstream.on('upgrade', (incoming, peer, upstreamHead) => {
        upstream.setTimeout(0)
        const raw = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket']
        for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
          const value = incoming.headers[name]
          if (typeof value === 'string') raw.push(`${name}: ${value}`)
        }
        socket.write(`${raw.join('\r\n')}\r\n\r\n`)
        if (head.length) peer.write(head)
        if (upstreamHead.length) socket.write(upstreamHead)
        sockets.add(socket)
        sockets.add(peer)
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
          sockets.delete(socket)
          sockets.delete(peer)
          socket.destroy()
          peer.destroy()
        }
        socket.once('close', close)
        peer.once('close', close)
        socket.on('error', close)
        peer.on('error', close)
        socket.pipe(peer).pipe(socket)
      })
      upstream.on('response', (incoming) => {
        if ([401, 403].includes(incoming.statusCode ?? 0)) grants.delete(route.prefix)
        incoming.resume()
        socket.destroy()
      })
      upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
      upstream.end()
      return true
    },
    close() {
      grants.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}
