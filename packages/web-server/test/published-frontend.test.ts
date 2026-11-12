import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { REMOTE_FRONTEND_INFO, REMOTE_FRONTEND_WS } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createPublishedFrontend } from '../src/published-frontend.js'

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('listener missing')
  return `http://127.0.0.1:${addr.port}`
}

it('publishes complete HTTP services with explicit public-owner authority and revokes new access', async () => {
  let current = true
  const seen: {
    method: string | undefined
    host: string | undefined
    origin: string | undefined
    site: string | string[] | undefined
    path: string | undefined
    body: string
  }[] = []
  const upstream = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({
      method: req.method,
      host: req.headers.host,
      origin: req.headers.origin,
      site: req.headers['sec-fetch-site'],
      path: req.url,
      body,
    })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"from":"B"}')
  })
  const origin = await listen(upstream)
  const gateway = await createPublishedFrontend({
    publication: { enabled: true, access: 'public-owner', host: '127.0.0.1', port: 0 },
    webOrigin: origin,
    instanceId: 'fixture-B',
    wsUrl: () => origin.replace('http:', 'ws:'),
    current: async () => current,
  })
  try {
    const info = await fetch(`${gateway.url}${REMOTE_FRONTEND_INFO}`)
    expect(await info.json()).toMatchObject({ access: 'public-owner', wsPath: REMOTE_FRONTEND_WS })
    const preflight = await fetch(`${gateway.url}/admin/packages/api/remove`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://computer-a:4177',
        'access-control-request-headers': 'content-type,x-example',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    const reply = await fetch(`${gateway.url}/admin/packages/api/remove`, {
      method: 'POST',
      headers: {
        origin: 'http://computer-a:4177',
        'content-type': 'application/json',
        'x-forwarded-host': 'evil.example',
      },
      body: '{"packageId":"fixture"}',
    })
    expect(await reply.json()).toEqual({ from: 'B' })
    expect(seen).toEqual([
      {
        method: 'POST',
        host: new URL(origin).host,
        origin,
        site: 'same-origin',
        path: '/admin/packages/api/remove',
        body: '{"packageId":"fixture"}',
      },
    ])
    const redirect = await fetch(gateway.url, { redirect: 'manual' })
    expect(redirect.status).toBe(307)
    expect(
      new URL(redirect.headers.get('location') ?? '/missing', gateway.url).searchParams.get('remote'),
    ).toBe(gateway.url)
    current = false
    expect((await fetch(`${gateway.url}${REMOTE_FRONTEND_INFO}`)).status).toBe(503)
    expect((await fetch(`${gateway.url}/api/config`)).status).toBe(503)
    expect(seen).toHaveLength(1)
  } finally {
    await gateway.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

it('relays browser WebSockets to the fixed daemon and closes them on shutdown', async () => {
  const peers = new Set<Duplex>()
  let observed: { origin: string | undefined; path: string | undefined } | undefined
  const upstream = createServer()
  upstream.on('upgrade', (req, peer) => {
    peers.add(peer)
    peer.on('error', () => {})
    peer.once('close', () => peers.delete(peer))
    observed = { origin: req.headers.origin, path: req.url }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    peer.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: agnes-v1\r\n\r\n`,
    )
    peer.write(Buffer.concat([Buffer.from([0x81, 7]), Buffer.from('from B!')]))
  })
  const origin = await listen(upstream)
  const gateway = await createPublishedFrontend({
    publication: { enabled: true, access: 'public-owner', host: '127.0.0.1', port: 0 },
    webOrigin: origin,
    instanceId: 'fixture-B',
    wsUrl: () => origin.replace('http:', 'ws:'),
    current: async () => true,
  })
  const socket = new WebSocket(`${gateway.url.replace('http:', 'ws:')}${REMOTE_FRONTEND_WS}`, ['agnes-v1'])
  try {
    const text = await new Promise((resolve) =>
      socket.addEventListener('message', (event) => resolve(event.data), { once: true }),
    )
    expect(text).toBe('from B!')
    expect(observed).toEqual({ origin, path: '/' })
    const disconnected = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }))
    await gateway.close()
    await disconnected
  } finally {
    socket.close()
    await gateway.close()
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
