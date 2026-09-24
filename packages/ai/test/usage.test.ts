import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createProvider, estimateBilling, estimateCredits, NullContractStore } from '../src/index.js'
import { FakeAdapter, fakeModel, fakeRequest } from '../testkit/index.js'

const routes = [{ route: 'r', api: 'openai-completions', baseUrl: 'https://r.invalid' }]
const priced = (cost: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({
  r: [fakeModel({ id: 'm', route: 'r', cost })],
})
const free = { r: [fakeModel({ id: 'm', route: 'r' })] }
const tokens = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })

type Script = ConstructorParameters<typeof FakeAdapter>[0]['script']
function run(o: {
  models?: Record<string, ReturnType<typeof fakeModel>[]>
  script: Script
  pricing?: { creditsPerUsd: number }
  clock?: () => number
  log?: { warn: (message: string) => void }
}): Promise<InferenceEvent[]> {
  const adapter = new FakeAdapter({
    id: 'f',
    routes,
    models: o.models ?? free,
    ...(o.script ? { script: o.script } : {}),
  })
  const provider = createProvider({
    adapters: [adapter],
    routes: { primary: { route: 'r', model: 'm' } },
    contract: new NullContractStore(),
    secrets: () => 'x',
    clock: o.clock ?? (() => 0),
    ...(o.pricing ? { pricing: o.pricing } : {}),
    ...(o.log ? { log: o.log } : {}),
  })
  return (async () => {
    const out: InferenceEvent[] = []
    for await (const e of provider.infer(fakeRequest({ route: 'r', model: 'm' }), {
      signal: new AbortController().signal,
      toolNames: [],
    }))
      out.push(e)
    return out
  })()
}
const usageOf = (events: InferenceEvent[]) =>
  events.find((e) => e.type === 'usage') as Extract<InferenceEvent, { type: 'usage' }>

describe('estimateCredits', () => {
  it('prices from per-million costs', () => {
    const m = fakeModel({
      id: 'm',
      route: 'r',
      cost: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 1 },
    })
    // (1M x $2 + 100k x $10) / 1M = $3, times 100 credits per dollar
    expect(estimateCredits(m, tokens(1_000_000, 100_000), 100)).toBe(300)
  })

  it('prices the cached halves too, and rounds to six places', () => {
    const m = fakeModel({ id: 'm', route: 'r', cost: { input: 0, output: 0, cacheRead: 3, cacheWrite: 7 } })
    expect(estimateCredits(m, { input: 0, output: 0, cacheRead: 1, cacheWrite: 1 }, 1)).toBe(0.00001)
    expect(estimateCredits(m, { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 }, 1)).toBe(0.000003)
    // finer than six places is not a number anyone can act on, and it rounds away
    expect(estimateCredits(m, { input: 0, output: 0, cacheRead: 0.1, cacheWrite: 0 }, 1)).toBe(0)
  })
})

describe('estimateBilling', () => {
  it('returns integer micro-dollars from trusted per-million-token prices', () => {
    const model = fakeModel({
      id: 'm',
      route: 'r',
      cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
    })
    expect(
      estimateBilling(model, { input: 1_000_000, output: 500_000, cacheRead: 10_000, cacheWrite: 0 }),
    ).toEqual({
      usdMicros: 870_036,
      source: 'estimated',
      subscription: false,
    })
  })

  it.each([
    { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 },
    { input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER, cacheRead: 0, cacheWrite: 0 },
  ])('omits unsafe token arithmetic rather than publishing invalid billing', (usage) => {
    const model = fakeModel({
      id: 'm',
      route: 'r',
      cost: { input: Number.MAX_VALUE, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    expect(estimateBilling(model, usage)).toBeUndefined()
  })
})

describe('the provider completes the usage event', () => {
  it('fills credits and timing from the injected clock', async () => {
    let now = 0
    const events = await run({
      models: priced({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      clock: () => (now += 100),
      pricing: { creditsPerUsd: 10 },
      script: () => [
        { type: 'text_delta', delta: 'x' },
        { type: 'usage', tokens: tokens(500_000, 500_000), creditSource: 'estimated' },
        { type: 'done', reason: 'stop' },
      ],
    })
    const usage = usageOf(events)
    expect(usage.credits).toBe(10) // $1 x 10
    expect(usage.creditSource).toBe('estimated')
    expect(usage.billing).toEqual({ usdMicros: 1_000_000, source: 'estimated', subscription: false })
    expect(usage.timing?.ttftMs).toBeGreaterThan(0)
    expect(usage.timing?.durationMs).toBeGreaterThan(usage.timing?.ttftMs ?? 0)
  })

  // The default path: no `pricing` at all. Every other case here configures around it, and it is the
  // path a host that has no price table takes. Denominating credits in dollars silently shrinks the
  // recorded spend by the deployment's own factor, and a per-request cap is compared against it.
  it('without pricing, one dollar is one credit - and it says so', async () => {
    const warns: string[] = []
    const events = await run({
      models: priced({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      log: { warn: (m) => warns.push(m) },
      script: () => [
        { type: 'usage', tokens: tokens(500_000, 500_000), creditSource: 'estimated' },
        { type: 'done', reason: 'stop' },
      ],
    })
    expect(usageOf(events).credits).toBe(1) // $1 x 1
    expect(warns.join(' ')).toContain('denominated in USD')
  })

  it('says nothing when a price table was configured', async () => {
    const warns: string[] = []
    await run({
      pricing: { creditsPerUsd: 100 },
      log: { warn: (m) => warns.push(m) },
      script: () => [
        { type: 'usage', tokens: tokens(1, 1), creditSource: 'estimated' },
        { type: 'done', reason: 'stop' },
      ],
    })
    expect(warns).toEqual([])
  })

  // A gateway that charged nothing charged nothing. `??` does not treat 0 as absent, and that is the
  // behaviour wanted - asserted so that a later `||` does not quietly turn a free call into an
  // estimated one at nine credits.
  it('keeps a gateway credits of 0 rather than re-estimating it', async () => {
    const events = await run({
      models: priced({ input: 9, output: 9, cacheRead: 0, cacheWrite: 0 }),
      pricing: { creditsPerUsd: 100 },
      script: () => [
        { type: 'usage', tokens: tokens(1_000_000, 0), credits: 0, creditSource: 'gateway' },
        { type: 'done', reason: 'stop' },
      ],
    })
    expect(usageOf(events)).toMatchObject({ credits: 0, creditSource: 'gateway' })
  })

  it('keeps an authoritative gateway figure untouched', async () => {
    const events = await run({
      models: priced({ input: 9, output: 9, cacheRead: 0, cacheWrite: 0 }),
      pricing: { creditsPerUsd: 100 },
      script: () => [
        { type: 'usage', tokens: tokens(1, 1), credits: 42, creditSource: 'gateway' },
        { type: 'done', reason: 'stop' },
      ],
    })
    expect(usageOf(events)).toMatchObject({ credits: 42, creditSource: 'gateway' })
  })

  it('keeps authoritative gateway billing instead of replacing it with catalogue pricing', async () => {
    const events = await run({
      models: priced({ input: 9, output: 9, cacheRead: 0, cacheWrite: 0 }),
      pricing: { creditsPerUsd: 100 },
      script: () => [
        {
          type: 'usage',
          tokens: tokens(1_000_000, 0),
          creditSource: 'gateway',
          billing: { usdMicros: 7, source: 'gateway', subscription: true },
        },
        { type: 'done', reason: 'stop' },
      ],
    })
    expect(usageOf(events).billing).toEqual({ usdMicros: 7, source: 'gateway', subscription: true })
  })

  it('replaces an invalid runtime billing object with a safe catalogue estimate', async () => {
    const events = await run({
      models: priced({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }),
      pricing: { creditsPerUsd: 1 },
      script: () => [
        {
          type: 'usage',
          tokens: tokens(1_000_000, 0),
          creditSource: 'gateway',
          billing: { usdMicros: 1, source: 'gateway', subscription: true, rawCredits: 99 },
        } as unknown as Extract<InferenceEvent, { type: 'usage' }>,
        { type: 'done', reason: 'stop' },
      ],
    })
    expect(usageOf(events).billing).toEqual({
      usdMicros: 1_000_000,
      source: 'estimated',
      subscription: false,
    })
  })

  // A stream that produced no delta has no first token, so ttftMs is absent rather than 0 - a 0 here
  // reads as "instant first token" in every latency chart that consumes this block.
  it('omits ttftMs on a stream that produced nothing', async () => {
    let now = 0
    const events = await run({
      clock: () => (now += 100),
      pricing: { creditsPerUsd: 1 },
      script: () => [
        { type: 'usage', tokens: tokens(1, 0), creditSource: 'estimated' },
        { type: 'done', reason: 'stop' },
      ],
    })
    const usage = usageOf(events)
    expect(usage.timing).toBeDefined()
    expect(usage.timing && 'ttftMs' in usage.timing).toBe(false)
    expect(usage.timing?.durationMs).toBeGreaterThan(0)
  })

  // A recovered call is a first token too: the model produced output, it simply produced it in a
  // shape that had to be read out of prose.
  it('counts a tool call as the first token when no text preceded it', async () => {
    let now = 0
    const events = await run({
      clock: () => (now += 100),
      pricing: { creditsPerUsd: 1 },
      script: () => [
        { type: 'toolcall_end', call: { toolUseId: 'c1', name: 'read', args: {}, ordinal: 0 } },
        { type: 'usage', tokens: tokens(1, 1), creditSource: 'estimated' },
        { type: 'done', reason: 'stop' },
      ],
    })
    expect(usageOf(events).timing?.ttftMs).toBeGreaterThan(0)
  })
})
