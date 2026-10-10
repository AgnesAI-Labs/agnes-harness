import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
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
const { kBodyTimeout, kDispatch } = require('undici/lib/core/symbols.js') as {
  kBodyTimeout: symbol
  kDispatch: symbol
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
