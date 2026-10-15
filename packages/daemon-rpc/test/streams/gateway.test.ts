import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { StreamContext } from '@agnes/extension-api'
import {
  createPluginStreamBroker,
  createPluginStreamGateway,
  type StreamPrincipal,
} from '@agnes/plugin-streams'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function start(source = false) {
  const active = new AbortController()
  let context: StreamContext | undefined
  const p: StreamPrincipal = {
    profileId: 'one',
    subject: 'synthetic-user',
    connectionId: 'login-one',
    actor: { id: 'synthetic-user', org: 'synthetic', role: 'user', deptPath: [], attrs: {} },
    source: 'web',
    signal: active.signal,
  }
  const broker = createPluginStreamBroker({
    async authorize(_principal, request) {
      if (
        !source &&
        (request.client?.rowId !== 'web:sample/plugin' ||
          request.client.revision !== 'revision-one' ||
          request.client.contentDigest !== `sha256-${'0'.repeat(64)}`)
      )
        throw new Error('immutable client roster refused')
      return {
        signal: active.signal,
        assertCurrent() {
          active.signal.throwIfAborted()
        },
      }
    },
  })
  broker.register({
    owner: 'sample/plugin',
    profileId: 'one',
    activationId: 'one',
    signal: active.signal,
    declaration: {
      name: 'sample.events',
      scope: 'profile',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      lane: 'events',
      directions: ['outbound'],
      maxFrameBytes: 4096,
      maxBufferedBytes: 32768,
      maxBytesPerSecond: 122880,
    },
    validateInput: () => true,
    handler(_input, ctx) {
      context = ctx
    },
  })
  let gateway: ReturnType<typeof createPluginStreamGateway> | undefined
  const server = createServer((req, res) => {
    void gateway?.handleHttp(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    void gateway?.handleUpgrade(req, socket, head).then((handled) => {
      if (!handled) socket.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  gateway = createPluginStreamGateway({
    origin,
    broker,
    source,
    async authenticate(req) {
      return (
        source
          ? req.headers['x-source-proof'] === 'synthetic-source' &&
            req.headers['x-user-grant'] === 'synthetic-user'
          : req.headers.cookie === 'synthetic-login'
      )
        ? p
        : null
    },
  })
  cleanup.push(async () => {
    gateway?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const request = {
    owner: 'sample/plugin',
    client: {
      rowId: 'web:sample/plugin',
      revision: 'revision-one',
      contentDigest: `sha256-${'0'.repeat(64)}`,
    },
    name: 'sample.events',
    scope: { kind: 'profile', profileId: 'one' },
    input: {},
  }
  const headers = {
    origin,
    cookie: 'synthetic-login',
    'content-type': 'application/json',
    'x-agnes-stream-open': '1',
  }
  return {
    origin,
    request,
    headers,
    active,
    broker,
    get context() {
      if (!context) throw new Error('missing admitted handler')
      return context
    },
  }
}
function connect(url: string, origin?: string, cookie = 'synthetic-login') {
  const ws = new WebSocket(url, { headers: { ...(origin ? { origin } : {}), cookie } })
  return ws
}
const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
describe('same-origin stream HTTP/WS gateway', () => {
  it('checks origin, CSRF header and login before minting tickets', async () => {
    const f = await start()
    for (const patch of [
      { origin: 'null' },
      { origin: 'http://other.invalid' },
      { origin: '' },
      { cookie: '' },
      { 'x-agnes-stream-open': '' },
    ]) {
      const res = await fetch(`${f.origin}/_agnes/plugin-stream/open`, {
        method: 'POST',
        headers: { ...f.headers, ...patch },
        body: JSON.stringify(f.request),
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
    for (const patch of [
      { client: { ...f.request.client, rowId: 'web:other/plugin' } },
      { client: { ...f.request.client, revision: 'stale-revision' } },
      { client: { ...f.request.client, contentDigest: `sha256-${'1'.repeat(64)}` } },
      { owner: 'other/plugin' },
      { scope: { kind: 'profile', profileId: 'other' } },
    ]) {
      const rejected = await fetch(`${f.origin}/_agnes/plugin-stream/open`, {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify({ ...f.request, ...patch }),
      })
      expect(rejected.status).toBe(403)
    }
    const res = await fetch(`${f.origin}/_agnes/plugin-stream/open`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(f.request),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ path: '/_agnes/plugin-stream', lane: 'events' })
  })
  it('refuses missing/foreign Origin and authenticates the hello before plugin bytes flow', async () => {
    const f = await start()
    const url = `${f.origin.replace('http:', 'ws:')}/_agnes/plugin-stream`
    for (const origin of [undefined, 'null', 'http://other.invalid']) {
      const ws = connect(url, origin)
      const failure = new Promise<number>((resolve) => {
        ws.once('unexpected-response', (_req, res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
          ws.terminate()
        })
        ws.on('error', () => {})
      })
      expect(await failure).toBe(403)
    }
    const binary = connect(url, f.origin),
      binaryClosed = closed(binary)
    await opened(binary)
    binary.send(new Uint8Array([1, 2, 3]))
    expect(await binaryClosed).toBe(1008)
    const ticket = await f.broker.open(
      {
        profileId: 'one',
        subject: 'synthetic-user',
        connectionId: 'login-one',
        actor: { id: 'synthetic-user', org: 'synthetic', role: 'user', deptPath: [], attrs: {} },
        source: 'web',
        signal: f.active.signal,
      },
      f.request,
    )
    const ws = connect(url, f.origin),
      messages: unknown[] = []
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    await opened(ws)
    const ready = new Promise<void>((resolve) => ws.once('message', () => resolve()))
    ws.send(JSON.stringify({ ticket: ticket.ticket }))
    await ready
    expect(messages[0]).toEqual({ ready: true, streamId: ticket.streamId })
    const event = new Promise<void>((resolve) => ws.once('message', () => resolve()))
    expect(f.context.stream.send({ cursor: 'event-one' })).toBe('accepted')
    await event
    expect(messages[1]).toMatchObject({
      streamId: ticket.streamId,
      kind: 'json',
      data: { cursor: 'event-one' },
    })
    const ended = closed(ws)
    f.active.abort()
    expect(await ended).toBe(1008)
  })
  it('keeps the source path Origin-free and requires both source identity and user grant', async () => {
    const f = await start(true)
    const path = `${f.origin}/_agnes/plugin-stream/source/open`
    const headers = {
      'content-type': 'application/json',
      'x-source-proof': 'synthetic-source',
      'x-user-grant': 'synthetic-user',
    }
    for (const patch of [{ 'x-user-grant': '' }, { 'x-source-proof': '' }, { origin: f.origin }]) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { ...headers, ...patch },
        body: JSON.stringify(f.request),
      })
      expect(response.status).toBeGreaterThanOrEqual(400)
    }
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(f.request) })
    expect(response.status).toBe(200)
    const ticket = (await response.json()) as { ticket: string }
    const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}/_agnes/plugin-stream/source`, { headers })
    ws.on('error', () => {})
    await opened(ws)
    const acknowledged = new Promise<void>((resolve) => ws.once('message', () => resolve()))
    ws.send(JSON.stringify({ ticket: ticket.ticket }))
    await acknowledged
    expect(f.context.scope.profileId).toBe('one')
    const ended = closed(ws)
    ws.close()
    await ended
  })
})
