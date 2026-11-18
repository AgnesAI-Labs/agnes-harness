import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as requestHttp } from 'node:http'
import { remoteFrontendSessionPath } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'

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

it('relays only authorized cloud capability paths, strips local credentials, supports WebSocket and fails closed', async () => {
  const token = `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`
  const prefix = remoteFrontendSessionPath(token)
  let status = 200
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
    response.writeHead(status, {
      'content-type': 'text/plain',
      'set-cookie': 'should-not-be-forwarded=x',
      location: 'https://foreign.example/',
    })
    response.end('sandbox-response')
  })
  upstream.on('upgrade', (request, socket) => {
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
      (await fetch(local + prefix + '/api/test', { headers: { origin: 'https://foreign.example' } })).status,
    ).toBe(401)
    const ws = new WebSocket(local.replace('http:', 'ws:') + prefix + '/_agnes/remote-frontend/ws')
    const message = new Promise<string>((resolve, reject) => {
      ws.onmessage = (event) => resolve(String(event.data))
      ws.onerror = () => reject(Error('upgrade failed'))
    })
    expect(await message).toBe('ready')
    ws.close()
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve()
      else ws.onclose = () => resolve()
    })
    const beforeWrite = received.length
    status = 401
    expect((await fetch(local + prefix + '/api/write', { method: 'POST', body: 'write-once' })).status).toBe(
      401,
    )
    expect(received).toHaveLength(beforeWrite + 1)
    expect((await fetch(local + prefix + '/api/write', { method: 'POST', body: 'new-request' })).status).toBe(
      401,
    )
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
})

it('refreshes transport credentials on reconnect and rejection, backs off failures and never replays writes', async () => {
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
    status = 401
    expect(
      (await fetch(local + prefix + '/api/write', { method: 'POST', body: 'failed-write' })).status,
    ).toBe(401)
    expect(seen).toEqual([{ key: 'business-2', body: 'failed-write' }])
    status = 200
    const response = await fetch(local + prefix + '/api/write', { method: 'POST', body: 'new-user-request' })
    expect(response.status).toBe(200)
    expect(seen).toEqual([
      { key: 'business-2', body: 'failed-write' },
      { key: 'business-3', body: 'new-user-request' },
    ])
    status = 401
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
})
