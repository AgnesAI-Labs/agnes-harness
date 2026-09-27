import type {
  DecisionModelRecord,
  DecisionWireRequest,
  InferenceEvent,
  RouteDecl,
  RouteTable,
} from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { DecisionAdapter, type DecisionAdapterAnswer, DecisionAdapterError } from '../src/adapter.js'
import { NullContractStore } from '../src/contract-store.js'
import { createProvider, DecisionError } from '../src/provider.js'
import { runDoctor } from '../src/quality/doctor.js'
import { FakeAdapter, fakeModel } from '../testkit/fake-adapter.js'
import { fakeRequest } from '../testkit/faux-provider.js'

const jevModel: DecisionModelRecord = {
  id: 'jev-1.13.0',
  name: 'Jev 1.13.0',
  api: 'typesafe-systemone',
  route: 'jev',
  baseUrl: 'https://decision.invalid/v1',
  kind: 'decision',
  contextWindow: 64000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const jevDecl: RouteDecl = {
  route: 'jev',
  api: 'typesafe-systemone',
  baseUrl: 'https://decision.invalid/v1',
  models: [jevModel],
}
const REQ: DecisionWireRequest = {
  slot: 'decision',
  route: 'jev',
  model: 'jev-1.13.0',
  state: 'the working tree is clean',
  questions: { done: { type: 'noul', instructions: 'Is the task finished?' } },
  timeoutMs: 1000,
}
// The chat table only: the decision target travels in each request, not in the assembly's table.
const ROUTES: RouteTable = { primary: { route: 'gw', model: 'm' } }
const ANSWERS = { done: { type: 'noul' as const, noul: 0.2 } }

class Scripted extends DecisionAdapter {
  readonly id: string
  readonly calls: Array<{ route: string; req: DecisionWireRequest }> = []
  constructor(
    private readonly answer: (signal: AbortSignal) => Promise<DecisionAdapterAnswer>,
    private readonly served: readonly DecisionModelRecord[] = [jevModel],
  ) {
    super()
    this.id = `scripted-${served[0]?.route ?? 'none'}`
  }
  routes(): readonly string[] {
    return [...new Set(this.served.map((m) => m.route))]
  }
  models(route: string): readonly DecisionModelRecord[] {
    return this.served.filter((m) => m.route === route)
  }
  credentialDecls() {
    return this.routes().map((route) => ({ route }))
  }
  decide(route: string, req: DecisionWireRequest, opts: { signal: AbortSignal }) {
    this.calls.push({ route, req })
    return this.answer(opts.signal)
  }
}

const chat = () =>
  new FakeAdapter({
    id: 'chat',
    routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid' }],
    models: { gw: [fakeModel({ id: 'm', route: 'gw' })] },
  })

function build(adapter: DecisionAdapter | undefined, decls: readonly RouteDecl[] = [jevDecl]) {
  return buildWith(adapter ? [adapter] : undefined, decls)
}
function buildWith(adapters: readonly DecisionAdapter[] | undefined, decls: readonly RouteDecl[]) {
  return createProvider({
    adapters: [chat()],
    ...(adapters ? { decision: { adapters, routes: decls } } : {}),
    routes: ROUTES,
    contract: new NullContractStore(),
    secrets: () => {
      throw new Error('no secrets in this test')
    },
    clock: () => 0,
    pricing: { creditsPerUsd: 100 },
  })
}
function decideOf(p: ReturnType<typeof build>) {
  const decide = p.decide
  if (!decide) throw new Error('provider has no decide')
  return decide
}
// Overrides are untyped on purpose: several cases hand the facade shapes the adapter type forbids.
const ok = (answer: Record<string, unknown> = {}) =>
  new Scripted(
    async () =>
      ({
        answers: ANSWERS,
        model: 'jev-1.13.0',
        usage: { inputTokens: 0, outputTokens: 0 },
        ...answer,
      }) as DecisionAdapterAnswer,
  )
const hangUntilAbort = () =>
  new Scripted(
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DecisionAdapterError('ABORTED')), { once: true })
      }),
  )
const signal = () => new AbortController().signal

describe('createProvider without decision adapters', () => {
  it('has no decide, no decision catalogue and no decision registry', () => {
    const p = build(undefined)
    expect(p.decide).toBeUndefined()
    expect(p.decisionModels).toBeUndefined()
    expect(p.decisionRegistry).toBeUndefined()
  })
})

describe('provider.decisionModels', () => {
  it('lists the decision catalogue while models() stays chat-only', () => {
    const p = build(ok())
    expect(p.decisionModels?.()).toEqual([jevModel])
    expect(p.models().map((m) => m.route)).toEqual(['gw'])
  })
})

describe('provider.decide resolves the target each request names', () => {
  it('two requests naming different routes and models reach different adapters and models', async () => {
    const other: DecisionModelRecord = { ...jevModel, id: 'jev-1.14.0', route: 'jev-next' }
    const otherSame: DecisionModelRecord = { ...jevModel, id: 'jev-1.13.1' }
    const first = new Scripted(
      async () => ({ answers: ANSWERS, model: 'jev-1.13.0', usage: {} }),
      [jevModel, otherSame],
    )
    const second = new Scripted(async () => ({ answers: ANSWERS, model: 'jev-1.14.0', usage: {} }), [other])
    const p = buildWith(
      [first, second],
      [
        { ...jevDecl, models: [jevModel, otherSame] },
        { ...jevDecl, route: 'jev-next', models: [other] },
      ],
    )
    const decide = decideOf(p)
    await decide(REQ, { signal: signal() })
    await decide({ ...REQ, route: 'jev-next', model: 'jev-1.14.0' }, { signal: signal() })
    await decide({ ...REQ, model: 'jev-1.13.1' }, { signal: signal() })
    expect(first.calls.map((c) => [c.route, c.req.model])).toEqual([
      ['jev', 'jev-1.13.0'],
      ['jev', 'jev-1.13.1'],
    ])
    expect(second.calls.map((c) => [c.route, c.req.model])).toEqual([['jev-next', 'jev-1.14.0']])
  })

  it('prices each call from the model the request named', async () => {
    const cheap: DecisionModelRecord = {
      ...jevModel,
      id: 'jev-cheap',
      cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const adapter = new Scripted(
      async () => ({ answers: ANSWERS, model: 'jev-cheap', usage: { inputTokens: 1_000_000 } }),
      [jevModel, cheap],
    )
    const p = build(adapter, [{ ...jevDecl, models: [jevModel, cheap] }])
    const r = await decideOf(p)({ ...REQ, model: 'jev-cheap' }, { signal: signal() })
    expect(r.credits).toBe(0.1)
  })
})

describe('provider.decide pricing', () => {
  it('prices from the catalogue when the adapter reports no cost', async () => {
    const adapter = ok({ usage: { inputTokens: 1_000_000, outputTokens: 7 } })
    const r = await decideOf(build(adapter))(REQ, { signal: signal() })
    expect(r).toEqual({
      answers: ANSWERS,
      model: 'jev-1.13.0',
      route: 'jev',
      usage: { inputTokens: 1_000_000, outputTokens: 7 },
      credits: 4.2,
      creditSource: 'estimated',
    })
    expect(adapter.calls).toEqual([{ route: 'jev', req: REQ }])
  })

  it('takes a reported cost as the gateway figure', async () => {
    const r = await decideOf(build(ok({ usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.0125 } })))(
      REQ,
      {
        signal: signal(),
      },
    )
    expect(r.credits).toBe(1.25)
    expect(r.creditSource).toBe('gateway')
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 0, costUsd: 0.0125 })
  })

  it('ignores a cost that is not a price', async () => {
    const r = await decideOf(build(ok({ usage: { inputTokens: 10, outputTokens: 0, costUsd: Number.NaN } })))(
      REQ,
      {
        signal: signal(),
      },
    )
    expect(r.creditSource).toBe('estimated')
  })

  it('returns the version that actually answered', async () => {
    const r = await decideOf(build(ok({ model: 'jev-1.14.0' })))(REQ, { signal: signal() })
    expect(r.model).toBe('jev-1.14.0')
  })
})

describe('provider.decide failure classes', () => {
  it.each([
    ['AUTH', 'unavailable'],
    ['RATE_LIMIT', 'unavailable'],
    ['TRANSPORT', 'unavailable'],
    ['NO_MODEL', 'unavailable'],
    ['FORMAT', 'invalid'],
    ['CONTRACT_MISMATCH', 'invalid'],
  ] as const)('%s is %s', async (code, kind) => {
    const adapter = new Scripted(async () => {
      throw new DecisionAdapterError(code)
    })
    const failure = decideOf(build(adapter))(REQ, { signal: signal() })
    await expect(failure).rejects.toBeInstanceOf(DecisionError)
    await expect(failure).rejects.toMatchObject({ kind, code, route: 'jev' })
  })

  it('treats anything else an adapter throws as a transport failure', async () => {
    const adapter = new Scripted(async () => {
      throw new Error('socket hang up: secret-looking text')
    })
    const failure = decideOf(build(adapter))(REQ, { signal: signal() })
    await expect(failure).rejects.toMatchObject({ kind: 'unavailable', code: 'TRANSPORT' })
    await expect(failure).rejects.not.toThrow(/secret-looking/)
  })

  it('times out an adapter that never settles and ignores its signal', async () => {
    const started = Date.now()
    const adapter = new Scripted(() => new Promise<never>(() => undefined))
    await expect(
      decideOf(build(adapter))({ ...REQ, timeoutMs: 100 }, { signal: signal() }),
    ).rejects.toMatchObject({
      kind: 'timeout',
      code: 'TIMEOUT',
    })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('times out an adapter that honours its signal', async () => {
    await expect(
      decideOf(build(hangUntilAbort()))({ ...REQ, timeoutMs: 100 }, { signal: signal() }),
    ).rejects.toMatchObject({ kind: 'timeout', code: 'TIMEOUT' })
  })

  it('reports a caller abort as ABORTED, not as a timeout', async () => {
    const ac = new AbortController()
    const failure = decideOf(build(hangUntilAbort()))(REQ, { signal: ac.signal })
    ac.abort()
    await expect(failure).rejects.toMatchObject({ kind: 'unavailable', code: 'ABORTED' })
  })
})

describe('provider.decide envelope', () => {
  it.each([
    ['answers null', { answers: null }],
    ['answers an array', { answers: [] }],
    ['an empty model', { model: '' }],
    ['a model longer than 256', { model: 'm'.repeat(257) }],
    ['no usage', { usage: undefined }],
    ['a negative token count', { usage: { inputTokens: -1, outputTokens: 0 } }],
    ['a fractional token count', { usage: { inputTokens: 1, outputTokens: 1.5 } }],
  ])('%s is invalid', async (_name, over) => {
    await expect(decideOf(build(ok(over)))(REQ, { signal: signal() })).rejects.toMatchObject({
      kind: 'invalid',
      code: 'FORMAT',
    })
  })

  it('passes odd answers through untouched for the caller to judge', async () => {
    const odd = { done: { type: 'noul', noul: '0.5', extra: true } }
    const r = await decideOf(build(ok({ answers: odd })))(REQ, { signal: signal() })
    expect(r.answers).toEqual(odd)
  })
})

describe('slot kind in the facade', () => {
  it('decide refuses a request that names a chat route and model', async () => {
    const failure = decideOf(build(ok()))({ ...REQ, route: 'gw', model: 'm' }, { signal: signal() })
    await expect(failure).rejects.toMatchObject({ kind: 'unavailable', code: 'NO_ADAPTER' })
    await expect(failure).rejects.toThrow(/slot-kind/)
  })

  it('decide is unavailable for a route no registry serves or a model the route does not offer', async () => {
    const unserved = decideOf(build(ok()))({ ...REQ, route: 'nowhere' }, { signal: signal() })
    await expect(unserved).rejects.toMatchObject({
      kind: 'unavailable',
      code: 'NO_ADAPTER',
      route: 'nowhere',
    })
    await expect(unserved).rejects.not.toThrow(/slot-kind/)
    await expect(
      decideOf(build(ok()))({ ...REQ, model: 'jev-9' }, { signal: signal() }),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      code: 'NO_MODEL',
    })
  })

  it.each([
    ['a decision route on a chat slot', fakeRequest({ slot: 'primary', route: 'jev', model: 'jev-1.13.0' })],
    ['the decision slot', fakeRequest({ slot: 'decision' as never, route: 'gw', model: 'm' })],
  ])('infer refuses %s', async (_name, req) => {
    const events: InferenceEvent[] = []
    for await (const e of build(ok()).infer(req, { signal: signal(), toolNames: [] })) events.push(e)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'NO_MODEL', retryable: false })
    expect((events[0] as { message: string }).message).toContain('slot-kind')
  })
})

describe('protected consumers see chat models only', () => {
  it('models(), the sealed registry and the doctor never list a decision model', async () => {
    const p = build(ok())
    expect(p.models().map((m) => m.route)).toEqual(['gw'])
    expect(p.registry.models().map((m) => m.route)).toEqual(['gw'])
    const report = await runDoctor(p.registry, { signal: signal(), timeoutMs: 1000 })
    expect(report.routes.map((r) => r.route)).toEqual(['gw'])
    expect(report.models.map((m) => m.route)).toEqual(['gw'])
    expect(p.decisionRegistry?.models()).toEqual([jevModel])
  })
})
