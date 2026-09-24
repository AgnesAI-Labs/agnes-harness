import { createServer, request, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { createWebServer, type WebServer } from '@agnes/web-server'
import { afterEach, expect, it } from 'vitest'
import { createMountProxy } from '../src/surfaces/mount-proxy.js'

// The real Web server in front of the real mount proxy: a mounted Surface's business API is a
// same-origin POST (`POST /api/requests/:id/decision` through `/demo`), and nothing else may start reaching it.

let upstream: Server | undefined
let web: WebServer | undefined
afterEach(async () => {
  upstream?.close()
  await web?.close().catch(() => undefined)
  upstream = undefined
  web = undefined
})

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function boot() {
  const seen: { method: string; path: string; body: string }[] = []
  upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += String(chunk)))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', body })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as { port: number }).port
  const port = await freePort()
  web = await createWebServer({
    root: '/nonexistent-web-root',
    wsUrl: 'ws://127.0.0.1:4312',
    port,
    origin: `http://127.0.0.1:${port}`,
    mountProxy: createMountProxy({
      lookup: (pathname) =>
        pathname === '/demo' || pathname.startsWith('/demo/')
          ? { host: '127.0.0.1', port: upstreamPort, mount: '/demo' }
          : undefined,
    }),
  })
  return { port, origin: `http://127.0.0.1:${port}`, seen }
}

function send(port: number, method: string, path: string, headers: Record<string, string>, body = '') {
  return new Promise<{ status: number; allow: unknown; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += String(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, allow: res.headers.allow, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const decision = JSON.stringify({ decision: 'approved' })

it('forwards a same-origin POST, body included, to the mounted Surface', async () => {
  const { port, origin, seen } = await boot()
  const res = await send(
    port,
    'POST',
    '/demo/api/requests/42/decision',
    { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    decision,
  )
  expect(res.status).toBe(201)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
  expect(seen).toEqual([{ method: 'POST', path: '/api/requests/42/decision', body: decision }])
})

it('refuses a cross-site POST to the mount without reaching the Surface', async () => {
  const { port, seen } = await boot()
  const res = await send(
    port,
    'POST',
    '/demo/api/requests/42/decision',
    { origin: 'http://evil.example' },
    decision,
  )
  expect(res.status).toBe(405)
  expect(seen).toEqual([])
})

it('refuses a POST that carries no Origin header', async () => {
  const { port, seen } = await boot()
  const res = await send(port, 'POST', '/demo/api/requests/42/decision', {}, decision)
  expect(res.status).toBe(405)
  expect(seen).toEqual([])
})

it('refuses a POST whose Fetch Metadata says it is not same-origin', async () => {
  const { port, origin, seen } = await boot()
  const res = await send(
    port,
    'POST',
    '/demo/api/requests/42/decision',
    { origin, 'sec-fetch-site': 'same-site' },
    decision,
  )
  expect(res.status).toBe(405)
  expect(seen).toEqual([])
})

it('still answers 405 with Allow: GET, HEAD for a same-origin POST outside any mount', async () => {
  const { port, origin, seen } = await boot()
  const res = await send(port, 'POST', '/index.html', { origin, 'sec-fetch-site': 'same-origin' }, decision)
  expect(res.status).toBe(405)
  expect(res.allow).toBe('GET, HEAD')
  expect(seen).toEqual([])
})

it('keeps forwarding a GET to the mount', async () => {
  const { port, seen } = await boot()
  const res = await send(port, 'GET', '/demo/api/requests?status=pending', {})
  expect(res.status).toBe(201)
  expect(seen).toEqual([{ method: 'GET', path: '/api/requests?status=pending', body: '' }])
})
