import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
  STATUS_CODES,
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

const MAX_TIMEOUT_MS = 2_147_483_647

function scheduleDeadline(expiresAt: number, onExpire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const arm = () => {
    if (cancelled) return
    const remaining = expiresAt - Date.now()
    const step = Math.min(MAX_TIMEOUT_MS, Math.max(1, remaining))
    const finalLeg = remaining <= MAX_TIMEOUT_MS
    timer = setTimeout(() => {
      timer = undefined
      if (cancelled) return
      if (finalLeg || Date.now() >= expiresAt) onExpire()
      else arm()
    }, step)
    timer.unref()
  }
  arm()
  return () => {
    cancelled = true
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }
}

/** A transport-only relay on the isolated cloud origin. It cannot reach local management routes. */
export function createCloudGateway(ownerOrigin?: string) {
  const canonicalOwnerOrigin = ownerOrigin ? new URL(ownerOrigin).origin : undefined
  const isOwnerInfoRequest = (request: IncomingMessage, pathname: string, prefix: string) =>
    canonicalOwnerOrigin !== undefined &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    pathname === `${prefix}${REMOTE_FRONTEND_INFO}` &&
    request.headers.origin === canonicalOwnerOrigin &&
    (!request.headers['sec-fetch-site'] ||
      ['same-origin', 'same-site', 'none'].includes(String(request.headers['sec-fetch-site'])))
  type Grant = {
    origin: string
    trafficToken: string
    expiresAt: number
    epoch: number
    credentialRef?: string
    lifetime: AbortController
    refresh?: (signal: AbortSignal) => Promise<AdminCloudAuthorization>
    refreshing?: Promise<void>
    checking?: { result: Promise<void>; refusals: Set<() => void> }
    rejected: boolean
    retryAt: number
    failures: number
    sockets: Set<Duplex>
    exchanges: Set<() => void>
    cancelTimer?: () => void
  }
  const grants = new Map<string, Grant>()
  const requests = new Set<ClientRequest>()
  let closed = false
  const revoke = (prefix: string, except?: ReadonlySet<() => void>) => {
    const grant = grants.get(prefix)
    grants.delete(prefix)
    if (grant) grant.epoch += 1
    grant?.lifetime.abort()
    grant?.cancelTimer?.()
    for (const abort of [...(grant?.exchanges ?? [])]) if (!except?.has(abort)) abort()
    for (const socket of [...(grant?.sockets ?? [])]) socket.destroy()
  }
  const revokeAll = () => {
    for (const prefix of grants.keys()) revoke(prefix)
  }
  const register = (
    origin: string,
    result: AdminCloudAuthorization,
    refresh?: Grant['refresh'],
    credentialRef?: string,
  ) => {
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
    const existing = grants.get(prefix)
    if (
      existing &&
      !existing.rejected &&
      existing.origin === target.origin &&
      existing.credentialRef === credentialRef &&
      existing.trafficToken === result.trafficToken &&
      existing.expiresAt === result.expiresAt
    ) {
      if (refresh) existing.refresh = refresh
      return true
    }
    if (grants.size >= 32 && !grants.has(prefix)) {
      const oldest = grants.keys().next().value
      if (oldest) revoke(oldest)
    }
    revoke(prefix)
    grants.set(prefix, {
      origin: target.origin,
      trafficToken: result.trafficToken,
      expiresAt: result.expiresAt,
      epoch: 0,
      lifetime: new AbortController(),
      ...(credentialRef !== undefined ? { credentialRef } : {}),
      ...(refresh ? { refresh } : {}),
      rejected: false,
      retryAt: 0,
      failures: 0,
      sockets: new Set(),
      exchanges: new Set(),
    })
    const grant = grants.get(prefix)
    if (grant) grant.cancelTimer = scheduleDeadline(result.expiresAt, () => revoke(prefix))
    return true
  }
  const resolve = (request: IncomingMessage, upgrade = false) => {
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
    if (!upgrade && isOwnerInfoRequest(request, url.pathname, prefix))
      return { grant, prefix, url: new URL(`${url.pathname}${url.search}`, grant.origin) }
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return null
    if (
      request.headers['sec-fetch-site'] &&
      !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))
    )
      return null
    return { grant, prefix, url: new URL(`${url.pathname}${url.search}`, grant.origin) }
  }
  const rejectGrant = (prefix: string, grant: Grant, except: ReadonlySet<() => void>) => {
    if (!grant.refresh) return revoke(prefix, except)
    grant.epoch += 1
    grant.rejected = true
    grant.trafficToken = ''
    for (const abort of [...grant.exchanges]) if (!except.has(abort)) abort()
    for (const socket of [...grant.sockets]) socket.destroy()
  }
  const renew = async (prefix: string, grant: Grant) => {
    if (grant.refreshing) return grant.refreshing
    if (!grant.refresh || grant.retryAt > Date.now()) throw Error('cloud authorization unavailable')
    grant.refreshing = (async () => {
      try {
        const next = await grant.refresh?.(grant.lifetime.signal)
        if (closed || grants.get(prefix) !== grant || grant.expiresAt <= Date.now()) throw Error('revoked')
        if (!next?.trafficToken || !validateMethod('_agnes/v1/admin.cloud.authorize', 'result', next).ok)
          throw Error('invalid authorization')
        // Keep this browser capability's original expiry and B session path; refresh only transport access.
        grant.trafficToken = next.trafficToken
        grant.rejected = false
        grant.retryAt = 0
        grant.failures = 0
      } catch {
        grant.retryAt = Date.now() + ([2_000, 5_000, 10_000][Math.min(grant.failures++, 2)] ?? 10_000)
        throw Error('cloud authorization unavailable')
      }
    })().finally(() => {
      delete grant.refreshing
    })
    return grant.refreshing
  }
  const retryAfter = (grant: Grant) => String(Math.max(1, Math.ceil((grant.retryAt - Date.now()) / 1000)))
  const own = (request: ClientRequest) => {
    requests.add(request)
    request.once('close', () => requests.delete(request))
    return request
  }
  const checkRejection = (prefix: string, grant: Grant, epoch: number, refusal: () => void) => {
    if (grants.get(prefix) !== grant || grant.epoch !== epoch || grant.rejected) return
    if (grant.checking) {
      grant.checking.refusals.add(refusal)
      return grant.checking.result
    }
    const refusals = new Set([refusal])
    const trafficToken = grant.trafficToken
    const result = new Promise<number | undefined>((resolve) => {
      // A stream/operation can be refused while the deployment credential remains valid.
      // Verify the fixed owner-info endpoint rather than trusting an error body or proxy header.
      const probe = own(
        httpsRequest(
          new URL(prefix + REMOTE_FRONTEND_INFO, grant.origin),
          {
            headers: { origin: grant.origin, 'e2b-traffic-access-token': trafficToken },
            signal: AbortSignal.any([grant.lifetime.signal, AbortSignal.timeout(3000)]),
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
          grant.epoch === epoch &&
          grant.trafficToken === trafficToken &&
          (status === 401 || status === 403)
        )
          rejectGrant(prefix, grant, refusals)
      })
      .finally(() => {
        delete grant.checking
      })
    grant.checking = { result, refusals }
    return result
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
      const requestPath = request.url ?? ''
      const parsedPath = requestPath.startsWith(REMOTE_FRONTEND_SESSION_PREFIX)
        ? new URL(requestPath, 'http://127.0.0.1').pathname
        : ''
      const requestPrefix = parsedPath ? parsedPath.split('/').slice(0, 4).join('/') : ''
      const ownerCors: Record<string, string> =
        canonicalOwnerOrigin && parsedPath && isOwnerInfoRequest(request, parsedPath, requestPrefix)
          ? { 'access-control-allow-origin': canonicalOwnerOrigin, vary: 'Origin' }
          : {}
      const route = resolve(request)
      if (route === undefined) return false
      if (!route) {
        request.resume()
        response.writeHead(401, { 'cache-control': 'no-store', ...ownerCors }).end()
        return true
      }
      const rawPath = requestPath.slice(route.prefix.length).split('?', 1)[0] ?? '/'
      const normalizedPath = route.url.pathname.slice(route.prefix.length)
      const assetNamespace = /^\/(?:plugins|skins)(?:\/|$)/u
      if (
        rawPath !== normalizedPath &&
        (assetNamespace.test(rawPath) || assetNamespace.test(normalizedPath))
      ) {
        request.resume()
        response.writeHead(404, { 'cache-control': 'no-store' }).end()
        return true
      }
      if (route.grant.rejected) {
        try {
          await renew(route.prefix, route.grant)
        } catch {
          request.resume()
          response
            .writeHead(503, {
              'cache-control': 'no-store',
              'retry-after': retryAfter(route.grant),
              ...ownerCors,
            })
            .end()
          return true
        }
      }
      if (closed || request.aborted || response.destroyed) return true
      if (grants.get(route.prefix) !== route.grant || route.grant.expiresAt <= Date.now()) {
        if (grants.get(route.prefix) === route.grant) revoke(route.prefix)
        request.resume()
        response.writeHead(401, { 'cache-control': 'no-store', ...ownerCors }).end()
        return true
      }
      if (route.grant.rejected) {
        request.resume()
        response
          .writeHead(503, {
            'cache-control': 'no-store',
            'retry-after': retryAfter(route.grant),
            ...ownerCors,
          })
          .end()
        return true
      }
      const observedEpoch = route.grant.epoch
      let upstream: ClientRequest | undefined
      const abort = () => {
        cancelExpiry()
        route.grant.exchanges.delete(abort)
        upstream?.destroy()
        response.destroy()
      }
      const cancelExpiry = scheduleDeadline(route.grant.expiresAt, abort)
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
            if (status === 401 || status === 403)
              await checkRejection(route.prefix, route.grant, observedEpoch, abort)
            if (response.destroyed) {
              incoming.resume()
              return
            }
            if (status >= 300 && status < 400 && status !== 304) {
              incoming.resume()
              response.writeHead(502, { 'cache-control': 'no-store', ...ownerCors }).end()
              return
            }
            const safe: OutgoingHttpHeaders = {
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              ...ownerCors,
            }
            for (const name of [
              'content-type',
              'content-range',
              'accept-ranges',
              'content-disposition',
              'content-security-policy',
            ]) {
              const value =
                name === 'content-security-policy' ? incoming.headersDistinct[name] : incoming.headers[name]
              if (typeof value === 'string' && value && !/[\r\n\0]/u.test(value)) safe[name] = value
              else if (Array.isArray(value)) {
                const clean = value.filter((item) => item && !/[\r\n\0]/u.test(item))
                if (clean.length > 0)
                  safe[name] = name === 'content-security-policy' ? clean : clean.join(', ')
              }
            }
            response.writeHead(status, safe)
            incoming.pipe(response)
          },
        ),
      )
      upstream.setTimeout(30_000, () => upstream.destroy())
      upstream.on('error', () => {
        if (response.headersSent) response.destroy()
        else response.writeHead(502, { 'cache-control': 'no-store', ...ownerCors }).end()
      })
      request.once('aborted', () => upstream.destroy())
      request.once('error', () => upstream.destroy())
      response.once('close', () => {
        cancelExpiry()
        route.grant.exchanges.delete(abort)
        upstream.destroy()
      })
      request.pipe(upstream)
      return true
    },
    async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
      const route = resolve(request, true)
      if (route === undefined) return false
      if (!route) {
        socket.destroy()
        return true
      }
      if (route.grant.rejected) {
        try {
          await renew(route.prefix, route.grant)
        } catch {
          socket.end(
            `HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: ${retryAfter(route.grant)}\r\n\r\n`,
          )
          return true
        }
      }
      if (closed || socket.destroyed) return true
      if (grants.get(route.prefix) !== route.grant || route.grant.expiresAt <= Date.now()) {
        if (grants.get(route.prefix) === route.grant) revoke(route.prefix)
        socket.destroy()
        return true
      }
      if (route.grant.rejected) {
        socket.end(
          `HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: ${retryAfter(route.grant)}\r\n\r\n`,
        )
        return true
      }
      const observedEpoch = route.grant.epoch
      let upstream: ClientRequest | undefined
      let peerSocket: Duplex | undefined
      const abortUpgrade = () => {
        cancelExpiry()
        route.grant.exchanges.delete(abortUpgrade)
        route.grant.sockets.delete(socket)
        if (peerSocket) route.grant.sockets.delete(peerSocket)
        upstream?.destroy()
        peerSocket?.destroy()
        socket.destroy()
      }
      const cancelExpiry = scheduleDeadline(route.grant.expiresAt, abortUpgrade)
      route.grant.exchanges.add(abortUpgrade)
      upstream = own(
        httpsRequest(route.url, {
          headers: headers(request, route.grant.origin, route.grant.trafficToken, true),
        }),
      )
      upstream.setTimeout(20_000, () => abortUpgrade())
      upstream.on('upgrade', (incoming, peer, upstreamHead) => {
        if (
          closed ||
          socket.destroyed ||
          grants.get(route.prefix) !== route.grant ||
          route.grant.rejected ||
          route.grant.epoch !== observedEpoch ||
          route.grant.expiresAt <= Date.now()
        ) {
          peer.destroy()
          abortUpgrade()
          return
        }
        peerSocket = peer
        route.grant.exchanges.delete(abortUpgrade)
        upstream?.setTimeout(0)
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
        const close = abortUpgrade
        socket.once('close', close)
        peer.once('close', close)
        socket.on('error', close)
        peer.on('error', close)
        socket.pipe(peer).pipe(socket)
      })
      upstream.on('response', async (incoming) => {
        incoming.on('error', () => socket.destroy())
        incoming.once('aborted', () => socket.destroy())
        const status = incoming.statusCode
        if (status === 401 || status === 403) {
          await checkRejection(route.prefix, route.grant, observedEpoch, abortUpgrade)
          if (!socket.destroyed) {
            socket.write(
              `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/plain\r\n\r\n`,
            )
            incoming.pipe(socket)
            return
          }
        }
        incoming.resume()
        socket.destroy()
      })
      upstream.on('error', () => abortUpgrade())
      socket.once('close', () => {
        cancelExpiry()
        route.grant.exchanges.delete(abortUpgrade)
        upstream?.destroy()
      })
      upstream.end()
      return true
    },
    revokeCredential(credentialRef: string) {
      for (const [prefix, grant] of grants) if (grant.credentialRef === credentialRef) revoke(prefix)
    },
    revokeAll,
    close() {
      closed = true
      revokeAll()
      for (const request of requests) request.destroy()
      requests.clear()
    },
  }
}
