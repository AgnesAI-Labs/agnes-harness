import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as requestHttp } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  PLUGIN_STREAM_OPEN_PATH,
  PLUGIN_STREAM_PATH,
  REMOTE_FRONTEND_AUTH,
  REMOTE_FRONTEND_INFO,
  REMOTE_FRONTEND_WS,
  remoteFrontendSessionPath,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { createPublishedFrontend } from '@agnes/web/server'
import { expect, it, vi } from 'vitest'
import {
  createPluginStreamBroker,
  createPluginStreamGateway,
  type StreamPrincipal,
} from '../../plugin-streams/src/index.js'

const fixture = vi.hoisted(() => ({ origin: '' }))
vi.mock('node:https', async () => ({
  request: (...args: unknown[]) => {
    const url = args[0] as URL
    expect(url.origin).toBe('https://8443-fixture.ap-shanghai.tencentags.com')
    return requestHttp(
      new URL(url.pathname + url.search, fixture.origin),
      args[1] as object,
      args[2] as never,
    )
  },
}))

import { createCloudGateway } from './cloud-gateway.js'
import { pluginStreamProxy } from './plugin-stream-proxy.js'

it('admits streams across the real cloud/publication/proxy chain without trusting browser proofs or replaying writes', async () => {
  const lifetime = new AbortController()
  const servers: ReturnType<typeof createServer>[] = []
  const peers = new Set<Duplex>()
  const gateway = createCloudGateway()
  let proxy: ReturnType<typeof pluginStreamProxy> | undefined
  let streams: ReturnType<typeof createPluginStreamGateway> | undefined
  let publication: Awaited<ReturnType<typeof createPublishedFrontend>> | undefined
  let send: ((value: { state: string }) => unknown) | undefined
  let writes = 0
  const digest = `sha256-${'0'.repeat(64)}`
  const row = {
    rowId: 'web:sample/plugin',
    moduleName: 'sample/plugin',
    revision: 'one',
    contentDigest: digest,
    enabled: true,
    phase: 'ready',
    streams: ['browser.state'],
    binding: { availability: 'active', profileId: 'local-dev' },
  }
  const principal: StreamPrincipal = {
    profileId: 'local-dev',
    subject: 'synthetic-user',
    connectionId: 'synthetic-connection',
    actor: { id: 'synthetic-user', org: 'synthetic', role: 'user', deptPath: [], attrs: {} },
    source: 'web',
    signal: lifetime.signal,
  }
  const broker = createPluginStreamBroker({
    async authorize(_principal, request) {
      if (
        request.client?.rowId !== row.rowId ||
        request.client.revision !== row.revision ||
        request.client.contentDigest !== digest
      )
        throw Error('immutable roster refused')
      return { signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted() }
    },
  })
  broker.register({
    owner: row.moduleName,
    profileId: 'local-dev',
    activationId: 'one',
    signal: lifetime.signal,
    declaration: {
      name: 'browser.state',
      scope: 'profile',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      lane: 'events',
      directions: ['outbound'],
      maxFrameBytes: 4096,
      maxBufferedBytes: 32768,
      maxBytesPerSecond: 122880,
    },
    validateInput: (value) => !!value && typeof value === 'object' && Object.keys(value).length === 0,
    handler(_input, context) {
      send = (value) => context.stream.send(value)
    },
  })
  const listen = async (server: ReturnType<typeof createServer>) => {
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  try {
    const surface = createServer(async (request, response) => {
      // Both public relays must strip caller-supplied identity and private worker admission.
      for (const header of [
        'x-agnes-stream-proof',
        'x-agnes-stream-row',
        'x-forwarded-user',
        'authorization',
        'cookie',
      ])
        expect(request.headers[header]).toBeUndefined()
      if (await proxy?.handleHttp(request, response)) return
      request.resume()
      if (request.url === '/api/partial') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
        response.write('partial')
        setTimeout(() => response.destroy(), 20)
        return
      }
      if (request.url === '/api/write') {
        writes++
        response.writeHead(401).end()
        return
      }
      response.writeHead(404).end()
    })
    surface.on('upgrade', (request, socket, head) => {
      if (request.url === PLUGIN_STREAM_PATH) {
        void proxy?.handleUpgrade(request, socket, head)
        return
      }
      peers.add(socket)
      socket.once('close', () => peers.delete(socket))
      socket.on('error', () => {})
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('ready')]))
      socket.once('end', () => socket.destroy())
    })
    const origin = await listen(surface)
    const worker = createServer(async (request, response) => {
      if (!(await streams?.handleHttp(request, response))) response.writeHead(404).end()
    })
    worker.on('upgrade', (request, socket, head) => {
      void streams?.handleUpgrade(request, socket, head)
    })
    const workerOrigin = await listen(worker)
    streams = createPluginStreamGateway({
      origin,
      broker,
      async authenticate(request) {
        return request.headers['x-agnes-stream-proof'] === 'synthetic-worker-proof' ? principal : null
      },
    })
    proxy = pluginStreamProxy({
      client: {
        clientModules: { list: async () => ({ rows: [row] }) },
        call: async () => ({
          host: '127.0.0.1',
          port: Number(new URL(workerOrigin).port),
          proof: 'synthetic-worker-proof',
        }),
      } as unknown as Client,
      origin,
      profile: 'local-dev',
      initialize: async () => {},
      body: async (request) => {
        let body = ''
        for await (const chunk of request) body += chunk
        return JSON.parse(body)
      },
    })
    const key = 'synthetic-deployment-key'
    publication = await createPublishedFrontend({
      publication: {
        enabled: true,
        access: 'key-owner',
        auth: { keySha256: createHash('sha256').update(key).digest('hex') },
        host: '127.0.0.1',
        port: 0,
      },
      webOrigin: origin,
      instanceId: 'synthetic-B',
      wsUrl: () => origin.replace('http:', 'ws:'),
      current: async () => true,
    })
    // Only this HTTPS boundary is replaced. B publication, admission proxy and worker gateway are real.
    fixture.origin = publication.url
    const authorization = await fetch(publication.url + REMOTE_FRONTEND_AUTH, {
      method: 'POST',
      body: JSON.stringify({ key }),
    })
    expect(authorization.status).toBe(200)
    const grant = (await authorization.json()) as { token: string; expiresAt: number }
    const prefix = remoteFrontendSessionPath(grant.token)
    const server = createServer(async (request, response) => {
      if (!(await gateway.handleHttp(request, response))) response.writeHead(404).end()
    })
    server.on('upgrade', (request, socket, head) => {
      void gateway.handleUpgrade(request, socket, head)
    })
    const local = await listen(server)
    const target = 'https://8443-fixture.ap-shanghai.tencentags.com'
    expect((await fetch(local + prefix + REMOTE_FRONTEND_INFO)).status).toBe(401)
    gateway.register(target, { ...grant, trafficToken: 'synthetic-platform-proof' })
    const main = new WebSocket(local.replace('http:', 'ws:') + prefix + REMOTE_FRONTEND_WS)
    const next = (socket: WebSocket) =>
      new Promise<string>((resolve, reject) => {
        socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true })
        socket.addEventListener('error', () => reject(Error('unexpected socket error')), { once: true })
      })
    expect(await next(main)).toBe('ready')
    const input = {
      owner: row.moduleName,
      name: 'browser.state',
      scope: { kind: 'profile', profileId: 'local-dev' },
      client: { rowId: row.rowId, revision: row.revision, contentDigest: digest },
      input: {},
    }
    const headers = {
      'content-type': 'application/json',
      'x-agnes-stream-open': '1',
      'x-agnes-stream-proof': 'forged-proof',
      'x-agnes-stream-row': 'forged-row',
      'x-forwarded-user': 'forged-user',
      authorization: 'Bearer forged-owner',
      cookie: 'forged-cookie',
    }
    const admit = (body: unknown, marked = true) =>
      fetch(local + prefix + PLUGIN_STREAM_OPEN_PATH, {
        method: 'POST',
        headers: marked ? headers : { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const admitted = await admit(input)
    expect(admitted.status).toBe(200)
    const ticket = (await admitted.json()) as { ticket: string; streamId: number }
    expect(JSON.stringify(ticket)).not.toContain('synthetic-worker-proof')
    const stream = new WebSocket(local.replace('http:', 'ws:') + prefix + PLUGIN_STREAM_PATH)
    const ready = next(stream)
    stream.addEventListener('open', () => stream.send(JSON.stringify({ ticket: ticket.ticket })), {
      once: true,
    })
    expect(JSON.parse(await ready)).toEqual({ ready: true, streamId: ticket.streamId })
    const event = next(stream)
    expect(send?.({ state: 'ready' })).toBe('accepted')
    expect(JSON.parse(await event)).toMatchObject({ streamId: ticket.streamId, data: { state: 'ready' } })
    for (const [body, marked] of [
      [input, false],
      [{ ...input, input: { denied: true } }, true],
      [{ ...input, client: { ...input.client, revision: 'stale' } }, true],
    ] as const) {
      const refused = await admit(body, marked)
      expect(refused.status).toBe(403)
      await refused.text()
      expect((await fetch(local + prefix + REMOTE_FRONTEND_INFO)).status).toBe(200)
      expect(main.readyState).toBe(WebSocket.OPEN)
    }
    const partial = await fetch(local + prefix + '/api/partial', { signal: AbortSignal.timeout(1000) })
    expect(partial.status).toBe(200)
    await expect(partial.text()).rejects.toMatchObject({ name: 'TypeError' })
    expect((await fetch(local + prefix + REMOTE_FRONTEND_INFO)).status).toBe(200)
    expect(main.readyState).toBe(WebSocket.OPEN)
    const forgedToken = grant.token.slice(0, -1) + (grant.token.endsWith('A') ? 'B' : 'A')
    gateway.register(target, { ...grant, token: forgedToken, trafficToken: 'synthetic-platform-proof' })
    expect((await fetch(local + remoteFrontendSessionPath(forgedToken) + REMOTE_FRONTEND_INFO)).status).toBe(
      401,
    )
    expect(main.readyState).toBe(WebSocket.OPEN)
    const closed = new Promise<void>((resolve) =>
      main.addEventListener('close', () => resolve(), { once: true }),
    )
    expect((await fetch(local + prefix + '/api/write', { method: 'POST', body: 'write-once' })).status).toBe(
      401,
    )
    await closed
    expect(
      (await fetch(local + prefix + '/api/write', { method: 'POST', body: 'second-user-request' })).status,
    ).toBe(401)
    expect(writes).toBe(1)
  } finally {
    gateway.close()
    await publication?.close()
    proxy?.close()
    streams?.close()
    broker.close()
    lifetime.abort()
    for (const peer of peers) peer.destroy()
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      ),
    )
  }
})

it.each([200, 502, 503])(
  'relays admitted streams and preserves operation refusals when owner info returns %i',
  async (infoStatus) => {
    const token = `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`
    const prefix = remoteFrontendSessionPath(token)
    let status = 200
    let abortForbidden = false
    const received: {
      token: string
      cookie: string | undefined
      auth: string | undefined
      path: string | undefined
    }[] = []
    const upstream = createServer((request, response) => {
      received.push({
        token: request.headers['e2b-traffic-access-token'] as string,
        cookie: request.headers.cookie,
        auth: request.headers.authorization,
        path: request.url,
      })
      request.resume()
      const admitted =
        request.url !== prefix + PLUGIN_STREAM_OPEN_PATH || request.headers['x-agnes-stream-open'] === '1'
      if (abortForbidden && request.url === prefix + REMOTE_FRONTEND_INFO) {
        setTimeout(() => response.writeHead(infoStatus).end(), 50)
        return
      }
      if (abortForbidden && !admitted) {
        response.writeHead(403).write('partial refusal')
        setTimeout(() => response.destroy(), 10)
        return
      }
      response.writeHead(
        request.url === prefix + REMOTE_FRONTEND_INFO ? infoStatus : admitted ? status : 403,
        {
          'content-type': 'text/plain',
          'set-cookie': 'should-not-be-forwarded=x',
          location: 'https://foreign.example/',
        },
      )
      response.end('sandbox-response')
    })
    upstream.on('upgrade', (request, socket) => {
      if (request.url === prefix + PLUGIN_STREAM_PATH) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      expect(request.headers['e2b-traffic-access-token']).toBe('business-fixture')
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('ready')]))
      socket.on('error', () => {})
      socket.once('end', () => socket.destroy())
      socket.once('data', () => socket.destroy())
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    fixture.origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    const gateway = createCloudGateway()
    const server = createServer(async (request, response) => {
      if (!(await gateway.handleHttp(request, response))) response.writeHead(404).end()
    })
    server.on('upgrade', (request, socket, head) => {
      void gateway.handleUpgrade(request, socket, head)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const register = (expiresAt = Date.now() + 60_000) =>
      gateway.register('https://8443-fixture.ap-shanghai.tencentags.com', {
        token,
        expiresAt,
        trafficToken: 'business-fixture',
      })
    try {
      expect((await fetch(local + prefix + '/api/test')).status).toBe(401)
      register()
      const response = await fetch(local + prefix + '/plugins/fixture/client.js', {
        headers: {
          cookie: 'local-secret',
          authorization: 'Bearer local-secret',
          'e2b-traffic-access-token': 'spoofed',
        },
      })
      expect(await response.text()).toBe('sandbox-response')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(received.at(-1)).toEqual({
        token: 'business-fixture',
        cookie: undefined,
        auth: undefined,
        path: prefix + '/plugins/fixture/client.js',
      })
      expect((await fetch(local + '/api/local-management')).status).toBe(404)
      expect(
        (await fetch(local + prefix + '/api/test', { headers: { origin: 'https://foreign.example' } }))
          .status,
      ).toBe(401)
      const ws = new WebSocket(local.replace('http:', 'ws:') + prefix + '/_agnes/remote-frontend/ws')
      const message = new Promise<string>((resolve, reject) => {
        ws.onmessage = (event) => resolve(String(event.data))
        ws.onerror = () => reject(Error('upgrade failed'))
      })
      expect(await message).toBe('ready')
      // Opening the browser's display stream must preserve admission without dropping the session socket.
      const stream = await fetch(local + prefix + PLUGIN_STREAM_OPEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agnes-stream-open': '1' },
        body: '{}',
      })
      expect(stream.status).toBe(200)
      expect(await stream.text()).toBe('sandbox-response')
      expect(ws.readyState).toBe(WebSocket.OPEN)
      const refusedStream = await fetch(local + prefix + PLUGIN_STREAM_OPEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(refusedStream.status).toBe(403)
      expect((await fetch(local + prefix + '/api/test')).status).toBe(200)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      const refusedSocket = new WebSocket(local.replace('http:', 'ws:') + prefix + PLUGIN_STREAM_PATH)
      await new Promise<void>((resolve) =>
        refusedSocket.addEventListener('error', () => resolve(), { once: true }),
      )
      expect((await fetch(local + prefix + '/api/test')).status).toBe(200)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      abortForbidden = true
      await expect(
        fetch(local + prefix + PLUGIN_STREAM_OPEN_PATH, {
          method: 'POST',
          body: '{}',
          signal: AbortSignal.timeout(1000),
        }).then((response) => response.text()),
      ).rejects.toMatchObject({ name: 'TypeError' })
      expect((await fetch(local + prefix + '/api/test')).status).toBe(200)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      abortForbidden = false
      ws.close()
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) resolve()
        else ws.onclose = () => resolve()
      })
      const beforeWrite = received.length
      status = 401
      expect(
        (await fetch(local + prefix + '/api/write', { method: 'POST', body: 'write-once' })).status,
      ).toBe(401)
      expect(received).toHaveLength(beforeWrite + 1)
      expect(
        (await fetch(local + prefix + '/api/write', { method: 'POST', body: 'new-request' })).status,
      ).toBe(401)
      expect(received).toHaveLength(beforeWrite + 1)
      register()
      expect(
        (await fetch(local + prefix + '/api/test', { headers: { 'sec-fetch-site': 'cross-site' } })).status,
      ).toBe(401)
      register()
      status = 304
      expect((await fetch(local + prefix + '/api/test')).status).toBe(304)
      status = 302
      expect((await fetch(local + prefix + '/api/test')).status).toBe(502)
      status = 401
      expect((await fetch(local + prefix + '/api/test')).status).toBe(401)
      status = 200
      expect((await fetch(local + prefix + '/api/test')).status).toBe(401)
      register(Date.now() - 1)
      expect((await fetch(local + prefix + '/api/test')).status).toBe(401)
      expect(() =>
        gateway.register('http://127.0.0.1:1', { token, expiresAt: Date.now() + 1000, trafficToken: 'x' }),
      ).toThrow()
      for (let index = 0; index < 35; index++)
        gateway.register('https://8443-fixture.ap-shanghai.tencentags.com', {
          token: `zzzzzzzz.${String(index).padStart(22, 'A')}.${'B'.repeat(43)}`,
          expiresAt: Date.now() + 60_000,
          trafficToken: 'business-fixture',
        })
      register()
      expect((await fetch(local + prefix + '/api/test')).status).toBe(200)
      gateway.close()
      expect(register).toThrow('closed')
      expect((await fetch(local + prefix + '/api/test')).status).toBe(401)
    } finally {
      gateway.close()
      server.closeAllConnections()
      upstream.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ])
    }
  },
)

it.each([401, 403])(
  'refreshes transport credentials after confirmed %i, backs off failures and never replays writes',
  async (deniedStatus) => {
    const token = `zzzzzzzz.${'C'.repeat(22)}.${'D'.repeat(43)}`
    const prefix = remoteFrontendSessionPath(token)
    const origin = 'https://8443-fixture.ap-shanghai.tencentags.com'
    const seen: { key: string | undefined; body: string }[] = []
    const handshakes: string[] = []
    let status = 200
    let generation = 1
    let unavailable = false
    const upstream = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      if (request.url === prefix + REMOTE_FRONTEND_INFO) {
        response.writeHead(status).end()
        return
      }
      seen.push({ key: request.headers['e2b-traffic-access-token'] as string, body })
      response.writeHead(status).end('result')
    })
    upstream.on('upgrade', (request, socket) => {
      handshakes.push(String(request.headers['e2b-traffic-access-token']))
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('ready')]))
      socket.on('error', () => {})
      socket.once('end', () => socket.destroy())
      socket.once('data', () => socket.destroy())
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    fixture.origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    const gateway = createCloudGateway()
    const grant = () => ({ token, expiresAt: Date.now() + 60_000, trafficToken: `business-${generation}` })
    const refresh = vi.fn(async () => {
      if (unavailable) throw Error('private-traffic-key-must-not-escape')
      generation++
      return grant()
    })
    gateway.register(origin, grant(), refresh)
    const server = createServer(async (request, response) => {
      if (!(await gateway.handleHttp(request, response))) response.writeHead(404).end()
    })
    server.on('upgrade', (request, socket, head) => {
      void gateway.handleUpgrade(request, socket, head)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const connect = async () => {
      const socket = new WebSocket(local.replace('http:', 'ws:') + prefix + '/_agnes/remote-frontend/ws')
      await new Promise<void>((resolve, reject) => {
        socket.onmessage = () => resolve()
        socket.onerror = () => reject(Error('failed'))
      })
      return socket
    }
    try {
      for (let n = 0; n < 2; n++) {
        const socket = await connect()
        const ended = new Promise((resolve) => {
          socket.onclose = resolve
        })
        socket.close()
        await ended
      }
      expect(handshakes).toEqual(['business-1', 'business-2'])
      status = deniedStatus
      expect(
        (await fetch(local + prefix + '/api/write', { method: 'POST', body: 'failed-write' })).status,
      ).toBe(deniedStatus)
      expect(seen).toEqual([{ key: 'business-2', body: 'failed-write' }])
      status = 200
      const response = await fetch(local + prefix + '/api/write', {
        method: 'POST',
        body: 'new-user-request',
      })
      expect(response.status).toBe(200)
      expect(seen).toEqual([
        { key: 'business-2', body: 'failed-write' },
        { key: 'business-3', body: 'new-user-request' },
      ])
      status = deniedStatus
      await fetch(local + prefix + '/api/test')
      unavailable = true
      const before = refresh.mock.calls.length
      for (let n = 0; n < 3; n++) {
        const denied = await fetch(local + prefix + '/api/test')
        expect(denied.status).toBe(503)
        expect(denied.headers.get('retry-after')).toBe('30')
        expect(await denied.text()).not.toContain('private-traffic-key')
      }
      expect(refresh.mock.calls.length - before).toBe(1)
      expect(seen.filter((row) => row.body === 'failed-write')).toHaveLength(1)
    } finally {
      gateway.close()
      server.closeAllConnections()
      upstream.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ])
    }
  },
)
