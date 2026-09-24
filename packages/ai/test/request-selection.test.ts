import type { InferenceEvent, RequestBody, RouteTable } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createProvider, NullContractStore } from '../src/index.js'
import { resolveSlot } from '../src/route.js'
import { FakeAdapter, fakeModel } from '../testkit/fake-adapter.js'
import { fakeRequest } from '../testkit/index.js'

const options = () => ({ signal: new AbortController().signal, toolNames: [] })
async function collect(stream: AsyncIterable<InferenceEvent>) {
  const events: InferenceEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function assembly() {
  const catalog = {
    a: [fakeModel({ id: 'same', route: 'a', cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })],
    b: [
      fakeModel({ id: 'same', route: 'b', cost: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } }),
      fakeModel({
        id: 'other',
        route: 'b',
        cost: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
      }),
    ],
  }
  const counted: Array<{ route: string; req: RequestBody }> = []
  const adapters = ['a', 'b'].map((route) => {
    const adapter = new FakeAdapter({
      id: route,
      routes: [{ route, api: 'openai-completions', baseUrl: `https://${route}.invalid` }],
      models: catalog,
      script: () => [
        {
          type: 'usage',
          tokens: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 },
          creditSource: 'estimated',
        },
        { type: 'done', reason: 'stop' },
      ],
    })
    adapter.count = async (selectedRoute, req) => {
      counted.push({ route: selectedRoute, req })
      return {
        source: 'provider',
        tokens: route === 'a' ? 100 : req.model === 'same' ? 200 : 300,
        boundHash: req.derivedHash,
      }
    }
    return adapter
  })
  const routes: RouteTable = { primary: { route: 'a', model: 'same' } }
  const provider = createProvider({
    adapters,
    routes,
    contract: new NullContractStore(),
    secrets: () => '',
    clock: () => 0,
  })
  return { provider, adapters, catalog, routes, counted }
}

function check(events: InferenceEvent[], route: string, model: string, credits: number) {
  expect(events).toHaveLength(3)
  expect(events[0]).toMatchObject({ type: 'sent', stamp: { model: { route, id: model } } })
  expect(events[1]).toMatchObject({ type: 'usage', credits, creditSource: 'estimated' })
  expect(events[2]).toEqual({ type: 'done', reason: 'stop' })
}

it('keeps the default resolved request, adapter, stamp, count and default USD pricing aligned', async () => {
  const { provider, adapters, routes, counted } = assembly()
  const selected = resolveSlot(routes, provider.registry, 'primary')
  const req = Object.freeze(fakeRequest({ route: selected.route, model: selected.model.id }))
  check(await collect(provider.infer(req, options())), 'a', 'same', 0.01)
  expect(adapters[0]?.calls).toEqual([{ route: 'a', req }])
  expect(adapters[1]?.calls).toEqual([])
  expect(await provider.count?.(req, options())).toMatchObject({ tokens: 100, boundHash: req.derivedHash })
  expect(counted).toEqual([{ route: 'a', req }])
})

it('honours nondefault route and model with distinct prices without changing another session', async () => {
  const { provider, adapters, routes, counted } = assembly()
  const before = provider.registry.fingerprint()
  const requests = [
    Object.freeze(fakeRequest({ sessionKey: 'session-b', route: 'b', model: 'same' })),
    Object.freeze(fakeRequest({ sessionKey: 'session-a', route: 'a', model: 'same' })),
    Object.freeze(fakeRequest({ sessionKey: 'session-b', route: 'b', model: 'other' })),
  ]
  const events = await Promise.all(requests.map((req) => collect(provider.infer(req, options()))))
  check(events[0] ?? [], 'b', 'same', 0.1)
  check(events[1] ?? [], 'a', 'same', 0.01)
  check(events[2] ?? [], 'b', 'other', 1)
  expect(adapters[0]?.calls.map((call) => call.req.sessionKey)).toEqual(['session-a'])
  expect(adapters[1]?.calls.map((call) => call.req.model)).toEqual(['same', 'other'])
  expect(await Promise.all(requests.map((req) => provider.count?.(req, options())))).toMatchObject([
    { tokens: 200 },
    { tokens: 100 },
    { tokens: 300 },
  ])
  expect(counted.map((call) => call.route)).toEqual(['b', 'a', 'b'])
  expect(routes).toEqual({ primary: { route: 'a', model: 'same' } })
  expect(provider.registry.fingerprint()).toBe(before)
})

it('accepts a resolved request for a slot absent from the startup defaults', async () => {
  const { provider } = assembly()
  check(
    await collect(provider.infer(fakeRequest({ slot: 'video', route: 'b', model: 'same' }), options())),
    'b',
    'same',
    0.1,
  )
})

describe('unavailable selections fail before adapter effects', () => {
  it.each([
    ['missing', 'same', 'NO_ADAPTER'],
    ['b', 'missing', 'NO_MODEL'],
    ['a', 'other', 'NO_MODEL'],
    ['b', 'later', 'NO_MODEL'],
  ])('%s/%s fails infer and count with %s', async (route, model, code) => {
    const { provider, adapters, catalog, counted } = assembly()
    catalog.b.push(fakeModel({ id: 'later', route: 'b' }))
    const req = fakeRequest({ route, model })
    expect(await collect(provider.infer(req, options()))).toEqual([
      expect.objectContaining({ type: 'error', code, retryable: false }),
    ])
    await expect(provider.count?.(req, options())).rejects.toMatchObject({ code })
    expect(adapters.flatMap((adapter) => adapter.calls)).toEqual([])
    expect(counted).toEqual([])
  })
})

it('prices from the sealed catalog even after a live adapter catalog changes', async () => {
  const { provider, catalog } = assembly()
  catalog.b[0] = fakeModel({
    id: 'same',
    route: 'b',
    cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
  })
  check(
    await collect(provider.infer(fakeRequest({ route: 'b', model: 'same' }), options())),
    'b',
    'same',
    0.1,
  )
})
