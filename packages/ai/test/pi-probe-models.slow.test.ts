import { getEventListeners } from 'node:events'
import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { PiAdapter } from '../src/adapters/pi/index.js'
import { probeModelsEndpoint } from '../src/adapters/pi/probe-models.js'
import { fakeModel } from '../testkit/index.js'
import { installLoopbackOnly, restoreLoopbackOnly } from './loopback-only.js'

const hits: Array<{ url: string; auth?: string; apiKey?: string; version?: string }> = []
let baseUrl = ''
const server = createServer((req, res) => {
  hits.push({
    url: req.url ?? '',
    ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
    ...(req.headers['x-api-key'] ? { apiKey: String(req.headers['x-api-key']) } : {}),
    ...(req.headers['anthropic-version'] ? { version: String(req.headers['anthropic-version']) } : {}),
  })
  if (req.url?.startsWith('/redirect')) {
    res.writeHead(302, { location: `${baseUrl}/target/models` })
    res.end()
    return
  }
  if (req.url?.startsWith('/hang')) return
  if (req.url?.startsWith('/slow')) {
    setTimeout(() => {
      res.writeHead(200)
      res.end('{}')
    }, 20_000)
    return
  }
  res.writeHead(req.url?.startsWith('/denied') ? 401 : 200)
  res.end('body is not catalogue evidence')
})
beforeAll(async () => {
  installLoopbackOnly()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  baseUrl = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  restoreLoopbackOnly()
})
const decl = (path = '/v1', api = 'openai-completions') => ({
  route: 'gw',
  api,
  baseUrl: `${baseUrl}${path}`,
  credentialRef: 'secret://doctor',
})
it.each(['openai-completions', 'openai-responses'])(
  'probes declared %s base path using only the bound credential',
  async (api) => {
    const ac = new AbortController()
    const result = await probeModelsEndpoint(decl('/custom/v1/', api), 'test-bound-marker', false, ac.signal)
    expect(result).toEqual({ name: 'models_endpoint', ok: true, detail: 'status=200' })
    expect(hits.at(-1)).toEqual({ url: '/custom/v1/models', auth: 'Bearer test-bound-marker' })
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  },
)
it('reports non-2xx as failed without response body', async () => {
  expect(
    await probeModelsEndpoint(decl('/denied'), 'test-bound-marker', false, new AbortController().signal),
  ).toEqual({ name: 'models_endpoint', ok: false, detail: 'status=401' })
})
it('does not follow redirects with a credential', async () => {
  const before = hits.length
  const result = await probeModelsEndpoint(
    decl('/redirect'),
    'test-bound-marker',
    false,
    new AbortController().signal,
  )
  expect(result.ok).toBe(false)
  expect(hits.slice(before).map((hit) => hit.url)).toEqual(['/redirect/models'])
})
it('does not send unknown, unsupported, unbound or precancelled requests', async () => {
  const before = hits.length,
    signal = new AbortController().signal
  expect((await probeModelsEndpoint(undefined, undefined, false, signal)).ok).toBe(false)
  expect(
    (await probeModelsEndpoint(decl('/v1', 'google-vertex'), 'test-bound-marker', false, signal)).ok,
  ).toBe(false)
  expect((await probeModelsEndpoint(decl(), undefined, true, signal)).ok).toBe(false)
  expect((await probeModelsEndpoint(decl(), 'test-bound-marker', false, AbortSignal.abort())).ok).toBe(false)
  expect(hits).toHaveLength(before)
})
it('allows only explicit keyless routes without credentialRef', async () => {
  const { credentialRef: _ref, ...keyless } = decl()
  expect((await probeModelsEndpoint(keyless, undefined, true, new AbortController().signal)).ok).toBe(true)
  expect(hits.at(-1)).toEqual({ url: '/v1/models' })
})
it('aborts a real pending socket at the default deadline and removes timers/listeners', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const ac = new AbortController()
  try {
    let settled = false
    const arrived = new Promise<void>((resolve) => server.once('request', () => resolve()))
    const result = probeModelsEndpoint(decl('/hang'), 'test-bound-marker', false, ac.signal)
    void result.then(() => {
      settled = true
    })
    await arrived
    expect(hits.at(-1)?.url).toBe('/hang/models')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await result).ok).toBe(false)
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  } finally {
    ac.abort()
    vi.useRealTimers()
  }
})

it('shares the default 30-second deadline across catalogue and inference stages', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const ac = new AbortController()
  try {
    const arrived = new Promise<void>((resolve) => server.once('request', () => resolve()))
    let markStarted = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const adapter = new PiAdapter({
      manualRoutes: [{ ...decl('/slow'), models: [fakeModel({ id: 'flash', route: 'gw' })] }],
      streamImpl: () => {
        markStarted()
        return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
      },
    })
    adapter.bindCredential('gw', 'test-bound-marker')
    const result = adapter.probe('gw', ac.signal)
    let settled = false
    void result.then(() => {
      settled = true
    })
    await arrived
    await vi.advanceTimersByTimeAsync(20_000)
    await started
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect((await result).checks.find((check) => check.name === 'minimal_inference')?.ok).toBe(false)
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  } finally {
    ac.abort()
    vi.useRealTimers()
  }
})

it('uses Anthropic API-key authentication, version, and SDK-relative resource path', async () => {
  const result = await probeModelsEndpoint(
    decl('/gateway', 'anthropic-messages'),
    'test-anthropic-marker',
    false,
    new AbortController().signal,
  )
  expect(result.ok).toBe(true)
  expect(hits.at(-1)).toEqual({
    url: '/gateway/v1/models',
    apiKey: 'test-anthropic-marker',
    version: '2023-06-01',
  })
})
it.each(['oauth', 'copilot'])(
  'does not downgrade the unresolved Anthropic %s authentication variant',
  async (variant) => {
    const before = hits.length
    const route = {
      ...decl('/gateway', 'anthropic-messages'),
      ...(variant === 'copilot' ? { route: 'github-copilot' } : {}),
    }
    const result = await probeModelsEndpoint(
      route,
      variant === 'oauth' ? 'sk-ant-oat-test-marker' : 'test-marker',
      false,
      new AbortController().signal,
    )
    expect(result.ok).toBe(false)
    expect(hits).toHaveLength(before)
  },
)
