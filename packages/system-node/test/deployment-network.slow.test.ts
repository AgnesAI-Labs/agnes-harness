import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { Client } from 'undici'
import { afterEach, expect, it } from 'vitest'
import {
  createDeploymentFetch,
  deploymentProxyHosts,
  ensureDeploymentProxy,
} from '../src/deployment-network.js'

const servers: Server[] = []
const sockets = new Set<import('node:stream').Duplex>()
const clients: ReturnType<typeof createDeploymentFetch>[] = []
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  return `http://127.0.0.1:${address.port}`
}
it('uses an environment CONNECT proxy, bypasses NO_PROXY, and never exposes proxy credentials in doctor data', async () => {
  const endpoint = await listen(createServer((_request, response) => response.end('target')))
  let tunnels = 0
  const proxy = createServer()
  proxy.on('connect', (request, downstream, head) => {
    tunnels++
    const target = new URL(`http://${request.url}`)
    const upstream = connect(Number(target.port), target.hostname, () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(downstream)
      downstream.pipe(upstream)
    })
    sockets.add(upstream)
    sockets.add(downstream)
    upstream.on('error', () => downstream.destroy())
  })
  const proxyUrl = await listen(proxy)
  const env = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '' }
  const proxied = createDeploymentFetch({}, env)
  clients.push(proxied)
  expect(await (await proxied.fetch(endpoint)).text()).toBe('target')
  expect(tunnels).toBe(1)
  ensureDeploymentProxy()
  expect(await (await proxied.run(() => fetch(endpoint))).text()).toBe('target')
  expect(tunnels).toBe(2)
  const direct = createDeploymentFetch({}, { ...env, NO_PROXY: '127.0.0.1' })
  clients.push(direct)
  expect(await (await direct.fetch(endpoint)).text()).toBe('target')
  expect(tunnels).toBe(2)
  expect(
    deploymentProxyHosts({ HTTP_PROXY: 'http://user:secret@proxy.example:8080/private?token=hidden' }),
  ).toEqual({ http: 'proxy.example:8080', https: 'proxy.example:8080', exclusionsConfigured: false })
  expect(deploymentProxyHosts({ HTTP_PROXY: 'malformed' }).http).toBe('invalid')
})
it.each(['request', 'idle', 'abort', 'cancel'] as const)(
  'bounds the %s lifetime and closes stalled response bodies',
  async (kind) => {
    const endpoint = await listen(
      createServer((_request, response) => {
        if (kind !== 'request') {
          response.writeHead(200)
          response.write('first')
        }
      }),
    )
    const client = createDeploymentFetch({ requestMs: kind === 'request' ? 30 : 1000, streamIdleMs: 30 }, {})
    clients.push(client)
    const controller = new AbortController()
    const work = client
      .fetch(endpoint, { signal: controller.signal })
      .then(async (response) => (kind === 'cancel' ? await response.body?.cancel() : await response.text()))
    if (kind === 'abort') controller.abort()
    if (kind === 'cancel') await expect(work).resolves.toBeUndefined()
    else await expect(work).rejects.toThrow()
  },
)

const require = createRequire(new URL('../package.json', import.meta.url))
const { kBodyTimeout, kDispatch, kKeepAliveDefaultTimeout } = require('undici/lib/core/symbols.js') as {
  kBodyTimeout: symbol
  kDispatch: symbol
  kKeepAliveDefaultTimeout: symbol
}
type Dispatch = (this: object, options: unknown, handler: unknown) => boolean
const UndiciClient = require('undici/lib/dispatcher/client.js') as {
  prototype: Record<symbol, Dispatch>
}

it('builds direct and proxy deployment clients with undici bodyTimeout 0', async () => {
  const seen: number[] = []
  const prototype = UndiciClient.prototype
  const original = prototype[kDispatch]
  if (!original) throw new Error('undici Client dispatch is missing')
  prototype[kDispatch] = function (this: object, options, handler) {
    const timeout = (this as Record<symbol, number>)[kBodyTimeout]
    if (timeout === undefined) throw new Error('undici body timeout is missing')
    seen.push(timeout)
    return original.call(this, options, handler)
  }
  try {
    const directEndpoint = await listen(createServer((_request, response) => response.end('direct')))
    const direct = createDeploymentFetch({ connectMs: 5_000 }, {})
    clients.push(direct)
    expect(await (await direct.fetch(directEndpoint)).text()).toBe('direct')
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set([0]))

    seen.length = 0
    const target = await listen(createServer((_request, response) => response.end('proxied')))
    const proxy = createServer()
    proxy.on('connect', (request, downstream, head) => {
      const url = new URL(`http://${request.url}`)
      const upstream = connect(Number(url.port), url.hostname, () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(downstream)
        downstream.pipe(upstream)
      })
      sockets.add(upstream)
      sockets.add(downstream)
      upstream.on('error', () => downstream.destroy())
    })
    const proxyUrl = await listen(proxy)
    const proxied = createDeploymentFetch(
      { connectMs: 5_000 },
      { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '' },
    )
    clients.push(proxied)
    expect(await (await proxied.fetch(target)).text()).toBe('proxied')
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen)).toEqual(new Set([0]))
  } finally {
    prototype[kDispatch] = original
  }
})

it('still stops a quiet non-SSE body at the app idle timer', async () => {
  const endpoint = await listen(
    createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.write('first')
    }),
  )
  const client = createDeploymentFetch({ streamIdleMs: 30, requestMs: 5_000 }, {})
  clients.push(client)
  await expect(client.fetch(endpoint).then((response) => response.text())).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'Stream idle timeout',
  })
})

it.each([
  [{ streamIdleMs: 30, firstByteMs: 5_000 }, 'late'],
  [{ streamIdleMs: 30 }, 'Stream idle timeout'],
] as const)('bounds the wait for the first body chunk by firstByteMs %j', async (timeouts, outcome) => {
  const endpoint = await listen(
    createServer((_request, response) => {
      // Headers go out at once; the body follows only when the whole reply is ready.
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.flushHeaders()
      setTimeout(() => response.end('late'), 150)
    }),
  )
  const client = createDeploymentFetch({ ...timeouts, requestMs: 5_000 }, {})
  clients.push(client)
  const body = client.fetch(endpoint, { method: 'POST' }).then((response) => response.text())
  if (outcome === 'late') expect(await body).toBe('late')
  else await expect(body).rejects.toMatchObject({ name: 'TimeoutError', message: outcome })
})

it('enforces the connection deadline during proxied TLS negotiation', async () => {
  const proxy = createServer()
  proxy.on('connect', (_request, socket) => {
    sockets.add(socket)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  const proxyUrl = await listen(proxy)
  const client = createDeploymentFetch({ connectMs: 30, requestMs: 3000 }, { HTTPS_PROXY: proxyUrl })
  clients.push(client)
  await expect(client.fetch('https://target.invalid')).rejects.toMatchObject({
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
  })
})

// A fixture that sends no `Keep-Alive: timeout=N` hint and never closes idle sockets itself, so the
// only idle limit left is the one the client was configured with (undici prefers a server hint).
async function listenCountingConnections() {
  const server = createServer((_request, response) => response.end('ok'))
  server.keepAliveTimeout = 0
  let connections = 0
  server.on('connection', () => connections++)
  const endpoint = await listen(server)
  return { endpoint, connections: () => connections }
}
function listenTunnelProxy() {
  let tunnels = 0
  const proxy = createServer()
  proxy.on('connect', (request, downstream, head) => {
    tunnels++
    const target = new URL(`http://${request.url}`)
    const upstream = connect(Number(target.port), target.hostname, () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(downstream)
      downstream.pipe(upstream)
    })
    sockets.add(upstream)
    sockets.add(downstream)
    upstream.on('error', () => downstream.destroy())
  })
  return listen(proxy).then((proxyUrl) => ({ proxyUrl, tunnels: () => tunnels }))
}

it('reuses direct and tunneled connections after six idle seconds when keepAliveTimeoutMs is set', async () => {
  const direct = await listenCountingConnections()
  const target = await listenCountingConnections()
  const proxy = await listenTunnelProxy()
  const directClient = createDeploymentFetch({ keepAliveTimeoutMs: 30_000 }, {})
  const proxiedClient = createDeploymentFetch(
    { keepAliveTimeoutMs: 30_000 },
    { HTTP_PROXY: proxy.proxyUrl, HTTPS_PROXY: proxy.proxyUrl, NO_PROXY: '' },
  )
  clients.push(directClient, proxiedClient)
  const call = async () =>
    expect(
      await Promise.all([
        directClient.fetch(direct.endpoint).then((response) => response.text()),
        proxiedClient.fetch(target.endpoint).then((response) => response.text()),
      ]),
    ).toEqual(['ok', 'ok'])
  await call()
  await new Promise((resolve) => setTimeout(resolve, 6_000))
  await call()
  expect(direct.connections()).toBe(1)
  expect(proxy.tunnels()).toBe(1)
  expect(target.connections()).toBe(1)
}, 30_000)

it('leaves undici keep-alive handling untouched when keepAliveTimeoutMs is omitted', async () => {
  const baseline = new Client('http://127.0.0.1:1')
  const undiciDefault = (baseline as unknown as Record<symbol, number>)[kKeepAliveDefaultTimeout]
  await baseline.close()
  expect(undiciDefault).toBeGreaterThan(0)
  const seen: number[] = []
  const prototype = UndiciClient.prototype
  const original = prototype[kDispatch]
  if (!original) throw new Error('undici Client dispatch is missing')
  prototype[kDispatch] = function (this: object, options, handler) {
    seen.push((this as Record<symbol, number>)[kKeepAliveDefaultTimeout] as number)
    return original.call(this, options, handler)
  }
  try {
    const direct = await listenCountingConnections()
    const target = await listenCountingConnections()
    const proxy = await listenTunnelProxy()
    const directClient = createDeploymentFetch({}, {})
    const proxiedClient = createDeploymentFetch(
      {},
      { HTTP_PROXY: proxy.proxyUrl, HTTPS_PROXY: proxy.proxyUrl, NO_PROXY: '' },
    )
    clients.push(directClient, proxiedClient)
    expect(await (await directClient.fetch(direct.endpoint)).text()).toBe('ok')
    const directSeen = seen.length
    expect(directSeen).toBeGreaterThan(0)
    expect(await (await proxiedClient.fetch(target.endpoint)).text()).toBe('ok')
    expect(seen.length).toBeGreaterThan(directSeen)
    expect(new Set(seen)).toEqual(new Set([undiciDefault]))
  } finally {
    prototype[kDispatch] = original
  }
})

it('accepts keepAliveTimeoutMs from 1 to 600000 and rejects anything else when the client is built', () => {
  for (const value of [1, 600_000]) clients.push(createDeploymentFetch({ keepAliveTimeoutMs: value }, {}))
  for (const value of [0, -1, 600_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000' as never])
    expect(() => createDeploymentFetch({ keepAliveTimeoutMs: value }, {})).toThrow(
      new TypeError('Keep-alive timeout must be an integer from 1 to 600000 milliseconds'),
    )
})
