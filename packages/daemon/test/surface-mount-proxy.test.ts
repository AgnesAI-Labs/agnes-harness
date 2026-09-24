import { createServer, request, type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createMountProxy } from '../src/surfaces/mount-proxy.js'

let upstream: Server | undefined
let front: Server | undefined
afterEach(() => {
  upstream?.close()
  front?.close()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

async function boot() {
  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, headers: req.headers }))
  })
  const upstreamPort = await listen(upstream)
  const proxy = createMountProxy({
    lookup: (pathname) =>
      pathname === '/demo' || pathname.startsWith('/demo/')
        ? { host: '127.0.0.1', port: upstreamPort, mount: '/demo' }
        : undefined,
  })
  front = createServer((req, res) => {
    if (proxy(req, res)) return
    res.writeHead(404)
    res.end('static fallback')
  })
  return { frontPort: await listen(front) }
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += String(chunk)))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers as Record<string, unknown> }),
        )
      })
      req.on('error', reject)
      req.end()
    },
  )
}

it('forwards a matching mount to the surface endpoint', async () => {
  const { frontPort } = await boot()
  const res = await get(frontPort, '/demo/version')
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body).path).toBe('/version')
})

it('declines a non-matching path so static assets still work', async () => {
  const { frontPort } = await boot()
  expect((await get(frontPort, '/admin/plugins')).body).toBe('static fallback')
})

// These are the real entries in FORGED_IDENTITY_KEYS (packages/daemon/src/surfaces/routes.ts), not the
// placeholder `x-agnes-*` names the plan sketch used -- those placeholders are not in the actual set and
// a test built around them would prove nothing. 'source-auth' is deliberately hyphenated: normalizeKey()
// strips non-alphanumeric characters before matching ('source-auth' -> 'sourceauth', which IS in the
// set), while a naive `key.toLowerCase()` check would leave the hyphen in place and miss it. This
// exercises exactly the case/punctuation nuance the task called out.
it('M5: strips forged identity headers before they reach the surface', async () => {
  const { frontPort } = await boot()
  const res = await get(frontPort, '/demo/', {
    authorization: 'Bearer attacker',
    principal: 'attacker',
    'source-auth': 'attacker',
  })
  const seen = JSON.parse(res.body).headers as Record<string, unknown>
  for (const key of ['authorization', 'principal', 'source-auth']) {
    expect(seen[key]).toBeUndefined()
  }
})

it('forwards headers that are not forged identity keys unchanged', async () => {
  const { frontPort } = await boot()
  const res = await get(frontPort, '/demo/', { 'x-request-id': 'kept-1' })
  const seen = JSON.parse(res.body).headers as Record<string, unknown>
  expect(seen['x-request-id']).toBe('kept-1')
})

it('applies the shared surface security headers to the response', async () => {
  const { frontPort } = await boot()
  const res = await get(frontPort, '/demo/')
  expect(res.headers['content-security-policy']).toBeDefined()
  expect(res.headers['x-frame-options']).toBe('DENY')
})

it('M2: still forwards an ordinary upstream response header through the shared filter', async () => {
  // Regression check for M2's fix: upstream headers now route through surfaceSecurityHeaders(input)
  // (its \r\n\0 filter) instead of being spread into writeHead unfiltered -- an ordinary, well-formed
  // upstream header must still come through, proving the filter isn't dropping legitimate values.
  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-note': 'hello-from-surface' })
    res.end(JSON.stringify({ path: req.url }))
  })
  const upstreamPort = await listen(upstream)
  const proxy = createMountProxy({
    lookup: (pathname) =>
      pathname === '/demo' || pathname.startsWith('/demo/')
        ? { host: '127.0.0.1', port: upstreamPort, mount: '/demo' }
        : undefined,
  })
  front = createServer((req, res) => {
    if (proxy(req, res)) return
    res.writeHead(404)
    res.end('static fallback')
  })
  const frontPort = await listen(front)
  const res = await get(frontPort, '/demo/version')
  expect(res.status).toBe(200)
  expect(res.headers['x-upstream-note']).toBe('hello-from-surface')
})

it('M2: falls back to a safe 502 instead of throwing when writeHead rejects a header value', async () => {
  // The real ERR_INVALID_CHAR path (Node's HTTP parser rejecting a header value writeHead is given)
  // is not reachable through two real Node HTTP stacks in a test -- both the upstream server and this
  // proxy's own outgoing response already validate header values before a caller can hand them
  // malformed bytes. This drives createMountProxy's returned handler directly against a minimal fake
  // `res` whose first writeHead call throws, exactly the shape that call would take in production,
  // and asserts the catch branch's fallback 502 is used instead of the exception propagating out of
  // the response callback (which, uncaught, would crash the request with no response at all).
  upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  const upstreamPort = await listen(upstream)
  const proxy = createMountProxy({
    lookup: () => ({ host: '127.0.0.1', port: upstreamPort, mount: '/demo' }),
  })
  let headersSent = false
  let writeHeadCalls = 0
  const res = {
    get headersSent() {
      return headersSent
    },
    writeHead: vi.fn((..._args: unknown[]) => {
      writeHeadCalls++
      if (writeHeadCalls === 1) throw new Error('ERR_INVALID_CHAR: invalid character in header content')
      headersSent = true
      return res
    }),
    end: vi.fn(() => undefined),
  }
  const req = {
    url: '/demo/version',
    method: 'GET',
    headers: {},
    // A real IncomingMessage.pipe(dest) would forward body bytes and then end `dest` when the
    // source ends; this GET request has no body, so ending `dest` immediately reproduces the same
    // effect and actually sends the outgoing upstream request (a no-op stub here would leave the
    // real `http.ClientRequest` this proxies through open forever, and the upstream would never
    // respond).
    pipe: (dest: { end(): void }) => {
      dest.end()
      return dest
    },
  }
  const claimed = proxy(req as never, res as never)
  expect(claimed).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(writeHeadCalls).toBe(2)
  expect(res.writeHead).toHaveBeenLastCalledWith(502, { 'content-type': 'text/plain' })
  expect(res.end).toHaveBeenCalledWith('surface unavailable')
})
