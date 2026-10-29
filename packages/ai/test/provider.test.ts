import { createHash } from 'node:crypto'
import type { ModelRequestTrace } from '@agnes/extension-api'
import type { InferenceEvent, RequestBody, RouteTable } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { ContractStore, Registry } from '../src/index.js'
import {
  ApiKeyProviderError,
  buildRegistry,
  createProvider,
  getApiKeyProvider,
  JEV_WIRE_API,
  NullContractStore,
  runInference,
  toolSchemaHash,
} from '../src/index.js'
import { FakeAdapter, fakeModel } from '../testkit/fake-adapter.js'

const gwRoute = {
  route: 'gw',
  api: 'openai-completions',
  baseUrl: 'https://gw.invalid',
  credentialRef: 'secret://agnes/gateway',
}

const body = (over: Partial<RequestBody> = {}): RequestBody => ({
  kind: 'inference',
  sessionKey: 'agnes:t:a:cli:dm:x',
  slot: 'primary',
  route: 'gw',
  model: 'flash',
  contractId: null,
  derivedHash: 'a'.repeat(64),
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  ...over,
})

async function collect(it: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const table: RouteTable = { primary: { route: 'gw', model: 'flash' } }

function mk(
  script?: ConstructorParameters<typeof FakeAdapter>[0]['script'],
  over: {
    routes?: RouteTable
    models?: Record<string, ReturnType<typeof fakeModel>[]>
    trace?: ModelRequestTrace
  } = {},
) {
  const adapter = new FakeAdapter({
    id: 'fake',
    routes: [gwRoute],
    models: over.models ?? { gw: [fakeModel({ id: 'flash', route: 'gw' })] },
    ...(script ? { script } : {}),
  })
  const provider = createProvider({
    adapters: [adapter],
    routes: over.routes ?? table,
    contract: new NullContractStore(),
    secrets: () => 'sk',
    clock: () => 1000,
    ...(over.trace ? { trace: over.trace } : {}),
  })
  return { adapter, provider }
}

const run = () => ({ signal: new AbortController().signal, toolNames: [] })

describe('createProvider', () => {
  it.each([false, true])(
    'measures capture, dispatch, visible output and cleanup (capture failure: %s)',
    async (failCapture) => {
      let now = 0
      let finished = false
      class TimedAdapter extends FakeAdapter {
        override async *stream(
          _route: string,
          _req: RequestBody,
          opts: import('../src/adapter.js').AdapterStreamOptions,
        ): AsyncIterable<import('../src/adapter.js').WireEvent> {
          try {
            await opts.reportRequest?.({ synthetic: true })
            opts.reportDispatch?.()
            now += 30
            yield { type: 'text_delta', delta: 'visible' }
            now += 40
            yield {
              type: 'usage',
              tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              creditSource: 'estimated',
            }
            now += 5
            yield { type: 'done', reason: 'stop' }
          } finally {
            now += 11
          }
        }
      }
      const adapter = new TimedAdapter({
        id: 'timed',
        routes: [gwRoute],
        models: { gw: [fakeModel({ id: 'flash', route: 'gw' })] },
      })
      const provider = createProvider({
        adapters: [adapter],
        routes: table,
        contract: new NullContractStore(),
        secrets: () => 'synthetic',
        clock: () => now,
        trace: {
          begin: async () => {
            now += 10
            return {
              id: 'trace',
              event() {},
              wire: async () => {
                now += 7
                if (failCapture) throw new Error('capture')
              },
              finish: async () => {
                now += 13
                finished = true
              },
            }
          },
        },
      })
      const events: InferenceEvent[] = []
      for await (const event of provider.infer(body(), run())) {
        if (event.type === 'usage') expect(finished).toBe(false)
        if (event.type === 'done') expect(finished).toBe(true)
        events.push(event)
      }
      expect(events.map((event) => event.type)).toEqual(['sent', 'text_delta', 'usage', 'done'])
      expect(events.find((event) => event.type === 'usage')).toMatchObject({
        timing: {
          prepareMs: 0,
          dispatchMs: 17,
          firstOutputMs: 47,
          ttftMs: 37,
          durationMs: 77,
        },
      })
      expect(events.find((event) => event.type === 'usage')).not.toHaveProperty('timing.finalizeMs')
      expect(events.at(-1)).toMatchObject({
        timing: {
          prepareMs: 0,
          captureMs: 30,
          dispatchMs: 17,
          firstOutputMs: 47,
          outputMs: 45,
          finalizeMs: 24,
          providerCallMs: 116,
        },
      })
    },
  )

  it('measures overlapping capture waits once and keeps the first dispatch across retries', async () => {
    let now = 0
    let releaseWire!: () => void
    let releaseAttempt!: () => void
    const wire = new Promise<void>((resolve) => {
      releaseWire = resolve
    })
    const attempt = new Promise<void>((resolve) => {
      releaseAttempt = resolve
    })
    const { adapter } = mk()
    adapter.stream = async function* (_route, _request, opts) {
      const first = opts.reportRequest?.({ synthetic: true })
      now = 5
      const second = opts.reportAttempt?.({
        attemptId: 'synthetic',
        index: 0,
        status: 'not-sent',
        adapter: { id: 'synthetic', version: null, api: 'synthetic', endpoint: null },
      })
      now = 10
      releaseWire()
      await first
      now = 20
      releaseAttempt()
      await second
      opts.reportDispatch?.()
      now = 25
      opts.reportDispatch?.()
      now = 30
      yield { type: 'media', kind: 'video_job', jobId: 'synthetic', status: 'running' }
      now = 40
      yield {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      }
      yield { type: 'done', reason: 'stop' }
    }
    const provider = createProvider({
      adapters: [adapter],
      routes: table,
      contract: new NullContractStore(),
      secrets: () => 'synthetic',
      clock: () => now,
      trace: {
        begin: async () => ({
          id: 'trace',
          wire: () => wire,
          attempt: () => attempt,
          event() {},
          finish: async () => {},
        }),
      },
    })
    const events = await collect(provider.infer(body(), run()))
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      timing: { captureMs: 20, dispatchMs: 20, firstOutputMs: 30, outputMs: 10, providerCallMs: 40 },
    })
    // Media is a new visible-output observation, without inventing a legacy text/tool TTFT.
    expect(events.find((event) => event.type === 'usage')).not.toHaveProperty('timing.ttftMs')
  })

  it.each(['none', 'begin', 'event', 'finish'] as const)(
    'emits a complete stream even when passive capture fails at %s',
    async (failure) => {
      const fail = () => {
        throw new Error('capture unavailable')
      }
      const { provider, adapter } = mk(undefined, {
        ...(failure === 'none'
          ? {}
          : {
              trace: {
                begin: async () => {
                  if (failure === 'begin') fail()
                  return {
                    id: '00000000-0000-4000-8000-000000000001',
                    wire: async () => undefined,
                    event: failure === 'event' ? fail : () => undefined,
                    finish: async () => {
                      if (failure === 'finish') fail()
                    },
                  }
                },
              },
            }),
      })
      const events = await collect(provider.infer(body(), run()))
      expect(events.map((e) => e.type)).toEqual(['sent', 'text_delta', 'usage', 'done'])
      const sent = events[0] as Extract<InferenceEvent, { type: 'sent' }>
      expect(sent.stamp.model).toEqual({ route: 'gw', id: 'flash' })
      expect(sent.stamp.derived_hash).toBe('a'.repeat(64))
      expect(sent.stamp.prompt_prefix_hash).toBeNull()
      expect(sent.stamp.tool_schema_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(sent.stamp.contract_id).toBeNull()
      expect(sent.stamp.transforms).toEqual([{ event: 'sent_hash', ext: 'unreported' }])
      expect(adapter.calls[0]?.route).toBe('gw')
    },
  )

  it.each(['sent', 'text_delta'] as const)(
    'closes adapter and trace when the consumer returns after %s',
    async (stop) => {
      let adapterClosed = false
      let traceClosed = false
      const { adapter } = mk()
      adapter.stream = async function* () {
        try {
          yield { type: 'text_delta', delta: 'visible' }
          yield {
            type: 'usage',
            tokens: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
            creditSource: 'gateway',
          }
          yield { type: 'done', reason: 'stop' }
        } finally {
          adapterClosed = true
        }
      }
      const provider = createProvider({
        adapters: [adapter],
        routes: table,
        contract: new NullContractStore(),
        secrets: () => 'synthetic',
        clock: () => 0,
        trace: {
          begin: async () => ({
            id: 'trace',
            wire: async () => {},
            event() {},
            finish: async () => {
              traceClosed = true
            },
          }),
        },
      })
      const seen: string[] = []
      for await (const event of provider.infer(body(), run())) {
        seen.push(event.type)
        if (event.type === stop) break
      }
      expect(adapterClosed).toBe(true)
      expect(traceClosed).toBe(true)
      expect(seen).not.toContain('usage')
      expect(seen).not.toContain('done')
    },
  )

  it('exposes an adapter error before blocked trace cleanup and eventually closes both', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const finishing = new Promise<void>((resolve) => {
      entered = resolve
    })
    let closed = false
    const { provider } = mk(
      () => [{ type: 'error', reason: 'error', code: 'TRANSPORT', message: 'original', retryable: true }],
      {
        trace: {
          begin: async () => ({
            id: 'trace',
            wire: async () => {},
            event() {},
            finish: async () => {
              entered()
              await gate
              closed = true
            },
          }),
        },
      },
    )
    const stream = provider.infer(body(), run())[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toMatchObject({ type: 'sent' })
      const error = (await stream.next()).value
      expect(error).toMatchObject({ type: 'error', message: 'original' })
      expect(error).not.toHaveProperty('timing.finalizeMs')
      if (!stream.return) throw new Error('expected closable provider stream')
      const returned = stream.return()
      await finishing
      expect(closed).toBe(false)
      release()
      await returned
      expect(closed).toBe(true)
    } finally {
      release()
      await stream.return?.()
    }
  })

  // Every failure this facade can hit reaches the caller as an event, because the caller is a
  // kernel step that has to write a turn either way: a throw out of the iterator would leave the
  // ledger with a request and no outcome.
  it('turns an unknown requested model into an in-stream error, never throws', async () => {
    const { provider } = mk()
    const events = await collect(provider.infer(body({ model: 'ghost' }), run()))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'NO_MODEL', retryable: false })
  })

  it('reports an unregistered requested route as NO_ADAPTER', async () => {
    const { provider } = mk(undefined, {
      routes: { primary: { route: 'gw', model: 'flash' }, fast: { route: 'ghost', model: 'flash' } },
    })
    const events = await collect(provider.infer(body({ slot: 'fast', route: 'ghost' }), run()))
    expect(events).toEqual([
      {
        type: 'error',
        reason: 'error',
        code: 'NO_ADAPTER',
        message: 'slot=fast route=ghost',
        retryable: false,
      },
    ])
  })

  it('reports a requested model the route does not serve as NO_MODEL', async () => {
    const { provider } = mk(undefined, { routes: { primary: { route: 'gw', model: 'ghost' } } })
    const events = await collect(provider.infer(body({ model: 'ghost' }), run()))
    expect(events).toEqual([
      {
        type: 'error',
        reason: 'error',
        code: 'NO_MODEL',
        message: 'slot=primary route=gw model=ghost',
        retryable: false,
      },
    ])
  })

  // The request is already resolved by core; a default table cannot replace its selection.
  it('rejects an unknown request selection instead of falling back to the slot default', async () => {
    const { provider, adapter } = mk()
    await collect(provider.infer(body({ route: 'nonsense', model: 'nonsense' }), run()))
    expect(adapter.calls).toEqual([])
  })

  it('models() projects the registry and count is absent when no adapter counts', () => {
    const { provider } = mk()
    expect(provider.models().map((m) => m.id)).toEqual(['flash'])
    expect(provider.count).toBeUndefined()
  })

  it('stops after the adapter reports error and ignores trailing events', async () => {
    const { provider } = mk(() => [
      { type: 'text_delta', delta: 'a' },
      { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'x', retryable: true },
      { type: 'text_delta', delta: 'ghost' },
    ])
    const events = await collect(provider.infer(body(), run()))
    expect(events.map((e) => e.type)).toEqual(['sent', 'text_delta', 'error'])
  })

  // The usage event is not incidental here: a finished turn has to account for itself, and the
  // sequence guard rewrites a `done` that arrives without one. What this case pins is the other
  // half - that nothing the adapter says after a terminal event reaches the caller.
  it('stops after the adapter reports done and ignores trailing events', async () => {
    const { provider } = mk(() => [
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
      { type: 'text_delta', delta: 'ghost' },
    ])
    const events = await collect(provider.infer(body(), run()))
    expect(events.map((e) => e.type)).toEqual(['sent', 'usage', 'done'])
  })

  // An adapter that simply stops is a transport failure, not a successful turn: the caller must
  // never read a truncated stream as a finished answer.
  it.each(['a', '<thi'])(
    'flushes %s and closes a stream without a terminal event as a retryable transport error',
    async (delta) => {
      const { provider } = mk(() => [{ type: 'text_delta', delta }])
      const events = await collect(provider.infer(body(), run()))
      expect(events.map((e) => e.type)).toEqual(['sent', 'text_delta', 'error'])
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        code: 'TRANSPORT',
        retryable: true,
        timing: { firstOutputMs: 0, outputMs: 0 },
      })
    },
  )

  // An adapter that throws mid-stream is the same outcome as one that reported an error, and the
  // message is the error's name only: an adapter's exception text can quote request material.
  it('encodes an adapter throw as a transport error carrying no message text', async () => {
    const { provider } = mk(() => {
      throw new Error('sk-secret-in-the-message')
    })
    const events = await collect(provider.infer(body(), run()))
    expect(events.map((e) => e.type)).toEqual(['sent', 'error'])
    expect(events[1]).toMatchObject({ type: 'error', reason: 'error', code: 'TRANSPORT', retryable: true })
    expect(JSON.stringify(events)).not.toContain('sk-secret-in-the-message')
  })

  it('encodes an abort as a non-retryable ABORTED error', async () => {
    const ac = new AbortController()
    const { provider } = mk(() => {
      ac.abort()
      throw new Error('aborted')
    })
    const events = await collect(provider.infer(body(), { signal: ac.signal, toolNames: [] }))
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      reason: 'aborted',
      code: 'ABORTED',
      retryable: false,
    })
  })

  // The adapter reports the call it read off the wire; only this facade may say how it was
  // recovered, so a native call is tagged here rather than being trusted from below.
  it('tags a tool call from the adapter as native', async () => {
    const { provider } = mk(() => [
      { type: 'toolcall_end', call: { toolUseId: 'c1', name: 'read', args: { path: 'a' }, ordinal: 0 } },
      { type: 'done', reason: 'stop' },
    ])
    const events = await collect(provider.infer(body(), run()))
    expect(events[1]).toEqual({
      type: 'toolcall_end',
      call: { toolUseId: 'c1', name: 'read', args: { path: 'a' }, ordinal: 0 },
      via: 'native',
    })
  })

  // `Registry` is an interface, so an assembly may fit one this package did not build. A registry
  // that resolves a slot and then cannot produce the adapter for it must still leave a turn with an
  // outcome rather than a TypeError out of the iterator.
  it('encodes a registry that stops answering mid-resolution as NO_ADAPTER', async () => {
    const adapter = new FakeAdapter({
      id: 'fake',
      routes: [gwRoute],
      models: { gw: [fakeModel({ id: 'flash', route: 'gw' })] },
    })
    const real = buildRegistry([adapter])
    real.seal()
    let answers = 1
    const flaky: Registry = { ...real, lookup: (route) => (answers-- > 0 ? real.lookup(route) : undefined) }
    const events = await collect(
      runInference(
        {
          registry: flaky,
          routes: table,
          contract: new NullContractStore(),
          clock: () => 0,
          parserVersion: '1',
          creditsPerUsd: 1,
        },
        body(),
        run(),
      ),
    )
    expect(events).toEqual([
      { type: 'error', reason: 'error', code: 'NO_ADAPTER', message: 'route=gw', retryable: false },
    ])
  })

  // The sequence guard is attached by this facade, which is what a host assembles - so an adapter
  // that finished without accounting for the turn is reported as a failure here, while runInference,
  // which tests reach directly with hand-built deps, is left as it is.
  it('guards the sequence it hands out, and leaves runInference unguarded', async () => {
    const script: ConstructorParameters<typeof FakeAdapter>[0]['script'] = () => [
      { type: 'text_delta', delta: 'a' },
      { type: 'done', reason: 'stop' },
    ]
    const { provider } = mk(script)
    const guarded = await collect(provider.infer(body(), run()))
    expect(guarded.map((e) => e.type)).toEqual(['sent', 'text_delta', 'error'])
    expect(guarded.at(-1)).toMatchObject({ code: 'TRANSPORT', message: 'done without usage' })

    const raw = await collect(
      runInference(
        {
          registry: provider.registry,
          routes: table,
          contract: new NullContractStore(),
          clock: () => 0,
          parserVersion: '1',
          creditsPerUsd: 1,
        },
        body(),
        run(),
      ),
    )
    expect(raw.map((e) => e.type)).toEqual(['sent', 'text_delta', 'done'])
  })

  it('binds credentials at assembly', () => {
    const { adapter } = mk()
    expect(adapter.seenCredential('gw')).toBe('sk')
  })

  // Defaults come from the request when it carries them and from this package when it does not,
  // so a caller that says nothing still gets a bounded wait rather than an unbounded one.
  it('passes the request timeouts through, falling back to the package defaults', async () => {
    const seen: Array<{ firstToken: number; total: number }> = []
    const adapter = new FakeAdapter({
      id: 'fake',
      routes: [gwRoute],
      models: { gw: [fakeModel({ id: 'flash', route: 'gw' })] },
    })
    const original = adapter.stream.bind(adapter)
    adapter.stream = (route, req, opts) => {
      seen.push(opts.timeoutMs)
      return original(route, req, opts)
    }
    const provider = createProvider({
      adapters: [adapter],
      routes: table,
      contract: new NullContractStore(),
      secrets: () => 'sk',
      clock: () => 1000,
    })
    await collect(provider.infer(body(), run()))
    await collect(provider.infer(body({ timeoutMs: { firstToken: 5000, total: 9000 } }), run()))
    expect(seen).toEqual([
      { firstToken: 120_000, total: 600_000 },
      { firstToken: 5000, total: 9000 },
    ])
  })

  it('exposes count when any adapter counts, and answers unsupported for a route that does not', async () => {
    const counting = new FakeAdapter({
      id: 'counting',
      routes: [gwRoute],
      models: { gw: [fakeModel({ id: 'flash', route: 'gw' })] },
    })
    counting.count = async () => ({ tokens: 7, source: 'provider', boundHash: 'b'.repeat(64) })
    const plain = new FakeAdapter({
      id: 'plain',
      routes: [{ route: 'other', api: 'openai-completions', baseUrl: 'https://other.invalid' }],
      models: { other: [fakeModel({ id: 'flash', route: 'other' })] },
    })
    const provider = createProvider({
      adapters: [counting, plain],
      routes: table,
      contract: new NullContractStore(),
      secrets: () => 'sk',
      clock: () => 1000,
    })
    expect(await provider.count?.(body(), { signal: new AbortController().signal })).toEqual({
      tokens: 7,
      source: 'provider',
      boundHash: 'b'.repeat(64),
    })
    expect(
      await provider.count?.(body({ route: 'other' }), { signal: new AbortController().signal }),
    ).toEqual({
      source: 'unsupported',
    })
    await expect(
      provider.count?.(body({ route: 'ghost' }), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })
})

// A payload is content only an adapter that reads it can act on. Sending one to any other adapter
// would put a request on the wire that silently drops what the caller meant, so the facade refuses
// it first - before a trace is opened, before `sent`, before the adapter is called.
describe('the payload gate', () => {
  class PayloadAdapter extends FakeAdapter {
    override readonly acceptsPayload = true
  }
  const payload = { state: { step: 2 }, questions: { q1: ['a', 'b'] } }
  const setup = (Adapter: typeof FakeAdapter, begin?: () => void) => {
    const adapter = new Adapter({
      id: 'fake',
      routes: [gwRoute],
      models: { gw: [fakeModel({ id: 'flash', route: 'gw' })] },
    })
    const provider = createProvider({
      adapters: [adapter],
      routes: table,
      contract: new NullContractStore(),
      secrets: () => 'sk',
      clock: () => 1000,
      ...(begin
        ? {
            trace: {
              begin: async () => {
                begin()
                return { id: 'trace', event() {}, wire: async () => {}, finish: async () => {} }
              },
            },
          }
        : {}),
    })
    return { adapter, provider }
  }

  it.each([payload, null, false])(
    'refuses a payload of %j before sending when the adapter does not accept one',
    async (value) => {
      let traced = 0
      const { adapter, provider } = setup(FakeAdapter, () => traced++)
      const events = await collect(provider.infer(body({ payload: value }), run()))
      expect(events.map((e) => e.type)).toEqual(['error'])
      expect(events[0]).toMatchObject({
        type: 'error',
        reason: 'error',
        code: 'CONTRACT_MISMATCH',
        retryable: false,
      })
      expect(adapter.calls).toEqual([])
      expect(traced).toBe(0)
    },
  )

  it('hands the payload to an adapter that accepts one', async () => {
    const { adapter, provider } = setup(PayloadAdapter)
    const events = await collect(provider.infer(body({ payload }), run()))
    expect(events.map((e) => e.type)).toEqual(['sent', 'text_delta', 'usage', 'done'])
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]?.req.payload).toEqual(payload)
  })

  it.each([
    ['an adapter without the capability', FakeAdapter],
    ['an adapter with it', PayloadAdapter],
  ] as const)('leaves a request without a payload untouched for %s', async (_name, Adapter) => {
    const { adapter, provider } = setup(Adapter)
    const events = await collect(provider.infer(body(), run()))
    expect(events.map((e) => e.type)).toEqual(['sent', 'text_delta', 'usage', 'done'])
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]?.req).not.toHaveProperty('payload')
  })
})

describe('describeRoute', () => {
  const canonicalDigest = (text: string) => createHash('sha256').update(text).digest('hex')
  class VersionedAdapter extends FakeAdapter {
    constructor(
      cfg: ConstructorParameters<typeof FakeAdapter>[0],
      override readonly version: string,
    ) {
      super(cfg)
    }
  }
  const providerFor = (baseUrl: string, version?: string) => {
    const cfg = {
      id: 'fake',
      routes: [{ ...gwRoute, baseUrl }],
      models: { gw: [fakeModel({ id: 'flash', route: 'gw' })] },
    }
    return createProvider({
      adapters: [version === undefined ? new FakeAdapter(cfg) : new VersionedAdapter(cfg, version)],
      routes: table,
      contract: new NullContractStore(),
      secrets: () => 'sk',
      clock: () => 1000,
    })
  }

  it('names the adapter, the wire api and the endpoint host, and nothing more specific than the host', () => {
    const described = providerFor('https://user:hunter2@gw.invalid:8443/team-a/v1?key=abc').describeRoute?.(
      'gw',
      'flash',
    )
    expect(described).toMatchObject({
      adapter: { id: 'fake', version: null },
      api: 'openai-completions',
      endpointHost: 'gw.invalid:8443',
    })
    // Neither the full URL nor any part of it that is not the host may leave the facade.
    const serialized = JSON.stringify(described)
    for (const secret of ['hunter2', 'user', 'team-a', 'key=abc', 'https://'])
      expect(serialized).not.toContain(secret)
    expect(described?.routeDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports the adapter version when it has one', () => {
    expect(providerFor('https://gw.invalid/v1', '2.1.0').describeRoute?.('gw', 'flash')).toMatchObject({
      adapter: { id: 'fake', version: '2.1.0' },
    })
  })

  it('digests the canonical form of the full routing configuration', () => {
    const described = providerFor('https://gw.invalid/team-a/v1').describeRoute?.('gw', 'flash')
    expect(described?.routeDigest).toBe(
      canonicalDigest(
        '{"adapter":{"id":"fake","version":null},"api":"openai-completions","baseUrl":"https://gw.invalid/team-a/v1","model":"flash"}',
      ),
    )
  })

  it('gives the same digest to the same configuration and a different one when any part of it differs', () => {
    const digest = (provider: ReturnType<typeof providerFor>, model = 'flash') =>
      provider.describeRoute?.('gw', model)?.routeDigest
    const base = digest(providerFor('https://gw.invalid/team-a/v1'))
    expect(digest(providerFor('https://gw.invalid/team-a/v1'))).toBe(base)
    // Two routes on one host are told apart by their path, though a reader of the host cannot.
    const otherPath = providerFor('https://gw.invalid/team-b/v1')
    expect(otherPath.describeRoute?.('gw', 'flash')?.endpointHost).toBe('gw.invalid')
    expect(digest(otherPath)).not.toBe(base)
    expect(digest(providerFor('https://gw.invalid/team-a/v1?region=eu'))).not.toBe(base)
    expect(digest(providerFor('https://gw.invalid/team-a/v1'), 'pro')).not.toBe(base)
    expect(digest(providerFor('https://gw.invalid/team-a/v1', '2.1.0'))).not.toBe(base)
  })

  it('has no host for a base URL that does not parse, and nothing for a route it does not serve', () => {
    const provider = providerFor('not a url')
    expect(provider.describeRoute?.('gw', 'flash')).toMatchObject({ endpointHost: null })
    expect(provider.describeRoute?.('ghost', 'flash')).toBeUndefined()
  })
})

// The hash a host records for an assembled session must not depend on when it is read. Sealing at
// assembly is what makes that true inside this package instead of leaving it as an obligation on
// the caller ("read it after the last refresh"), which nothing could enforce.
describe('the assembled registry is sealed', () => {
  it('exposes a fingerprint that is readable straight after assembly', () => {
    const { provider } = mk()
    expect(provider.registry.fingerprint()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps the fingerprint fixed when an adapter catalogue grows afterwards', () => {
    const models: Record<string, ReturnType<typeof fakeModel>[]> = {
      gw: [fakeModel({ id: 'flash', route: 'gw' })],
    }
    const { provider } = mk(undefined, { models })
    const before = provider.registry.fingerprint()
    models.gw = [fakeModel({ id: 'flash', route: 'gw' }), fakeModel({ id: 'later', route: 'gw' })]
    expect(provider.registry.fingerprint()).toBe(before)
    expect(provider.registry.models().map((m) => m.id)).toEqual(['flash'])
  })
})

// The stamp is what a later reader uses to tell whether two turns ran under the same conditions,
// so the contract it names and the prefix that contract fixed both have to reach it.
describe('the stamp carries the contract in force', () => {
  it('echoes the contract id and the prefix hash the store reports for it', async () => {
    const store: ContractStore = {
      prefixHash: (id) => (id === 'minimal-rl@1' ? 'c'.repeat(64) : null),
      prefixBytes: () => new Uint8Array(),
      tools: () => [],
      syntax: () => ({ toolCallFormats: ['native'] }),
    }
    const adapter = new FakeAdapter({
      id: 'fake',
      routes: [gwRoute],
      models: { gw: [fakeModel({ id: 'flash', route: 'gw', contract_id: 'minimal-rl@1' })] },
    })
    const provider = createProvider({
      adapters: [adapter],
      routes: table,
      contract: store,
      secrets: () => 'sk',
      clock: () => 1000,
    })
    const under = await collect(provider.infer(body({ contractId: 'minimal-rl@1' }), run()))
    const stamp = (under[0] as Extract<InferenceEvent, { type: 'sent' }>).stamp
    expect(stamp.contract_id).toBe('minimal-rl@1')
    expect(stamp.prompt_prefix_hash).toBe('c'.repeat(64))
    const without = await collect(provider.infer(body({ contractId: 'other@1' }), run()))
    expect(without).toEqual([expect.objectContaining({ type: 'error', code: 'CONTRACT_MISMATCH' })])
  })

  // The hash of the request as it was handed over must move with the request, or two different
  // turns would be stamped as the same bytes.
  it('falls back to the caller derived hash when bytes are unreported', async () => {
    const { provider } = mk()
    const first = await collect(provider.infer(body(), run()))
    const second = await collect(
      provider.infer(
        body({
          derivedHash: 'b'.repeat(64),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'other' }] }],
        }),
        run(),
      ),
    )
    const hashOf = (e: InferenceEvent[]) =>
      (e[0] as Extract<InferenceEvent, { type: 'sent' }>).stamp.sent_hash
    expect(hashOf(first)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashOf(first)).not.toBe(hashOf(second))
  })
})

describe('NullContractStore', () => {
  it('has no prefix hash for any contract id and refuses to hand out prefix bytes', () => {
    const store = new NullContractStore()
    expect(store.prefixHash(null)).toBeNull()
    expect(store.prefixHash('minimal-rl@1')).toBeNull()
    expect(() => store.prefixBytes('minimal-rl@1')).toThrow(/minimal-rl@1/)
  })
})

describe('toolSchemaHash', () => {
  it('is stable under key order and sensitive to every disclosed field', () => {
    const tool = (over: Record<string, unknown> = {}) => ({
      name: 'read',
      description: 'reads',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      ...over,
    })
    const reordered = {
      description: 'reads',
      parameters: { properties: { path: { type: 'string' } }, type: 'object' },
      name: 'read',
    }
    expect(toolSchemaHash([tool()])).toBe(toolSchemaHash([reordered]))
    expect(toolSchemaHash([tool()])).not.toBe(toolSchemaHash([tool({ description: 'other' })]))
    expect(toolSchemaHash([tool()])).not.toBe(toolSchemaHash([tool({ name: 'write' })]))
    expect(toolSchemaHash([tool()])).not.toBe(toolSchemaHash([tool({ parameters: { type: 'string' } })]))
    // order is part of what was disclosed to the model, so it is not sorted away
    expect(toolSchemaHash([tool(), tool({ name: 'write' })])).not.toBe(
      toolSchemaHash([tool({ name: 'write' }), tool()]),
    )
  })

  // The same disclosed text can arrive in two Unicode spellings; hashing the bytes as they came
  // would make one disclosure look like a different one from an identical disclosure.
  it('normalises the disclosed text so two spellings of one description hash alike', () => {
    const composed = { name: 'read', description: 'café', parameters: {} }
    const decomposed = { name: 'read', description: 'café', parameters: {} }
    expect(composed.description).not.toBe(decomposed.description)
    expect(toolSchemaHash([composed])).toBe(toolSchemaHash([decomposed]))
  })
})

describe('runInference', () => {
  // The facade is a one-line wrapper over this, so tests that need to vary the deps hit it directly.
  it('is reachable with hand-built deps and honours the parser version it is given', async () => {
    const adapter = new FakeAdapter({
      id: 'fake',
      routes: [gwRoute],
      models: { gw: [fakeModel({ id: 'flash', route: 'gw' })] },
    })
    const provider = createProvider({
      adapters: [adapter],
      routes: table,
      contract: new NullContractStore(),
      secrets: () => 'sk',
      clock: () => 1000,
      parserVersion: 'test-parser',
    })
    const events = await collect(
      runInference(
        {
          registry: provider.registry,
          routes: table,
          contract: new NullContractStore(),
          clock: () => 1000,
          parserVersion: 'test-parser',
          creditsPerUsd: 1,
        },
        body(),
        run(),
      ),
    )
    const sent = events[0] as Extract<InferenceEvent, { type: 'sent' }>
    expect(sent.stamp.parser_version).toBe('test-parser')
  })
})

// The decode chain runs here, not in each adapter, so an answer that spelled its reasoning or its
// call into the text stream is read the same way whichever wire protocol carried it.
describe('the decode chain sits between the adapter and the caller', () => {
  it('routes adapter text through the chain and shares the ordinal sequence with native calls', async () => {
    const { provider } = mk(() => [
      { type: 'text_delta', delta: 'A<think>t</think>B' },
      { type: 'toolcall_end', call: { toolUseId: 'c1', name: 'read', args: {}, ordinal: 99 } },
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'toolUse' },
    ])
    const events = await collect(
      provider.infer(body(), { signal: new AbortController().signal, toolNames: ['read'] }),
    )
    expect(events.map((e) => e.type)).toEqual([
      'sent',
      'text_delta',
      'thinking_delta',
      'text_delta',
      'toolcall_end',
      'usage',
      'done',
    ])
    expect(events[4]).toMatchObject({ type: 'toolcall_end', via: 'native', call: { ordinal: 0 } })
  })

  it('recovers a call from the text of a model that opted into the rule, tagged with the rule', async () => {
    const { provider } = mk(
      () => [
        { type: 'text_delta', delta: 'ok <function=read><parameter=path>a.md</parameter></function>' },
        { type: 'done', reason: 'toolUse' },
      ],
      {
        models: { gw: [fakeModel({ id: 'flash', route: 'gw', toolCallFormats: ['native', 'qwen3_coder'] })] },
      },
    )
    const events = await collect(
      provider.infer(body(), { signal: new AbortController().signal, toolNames: ['read'] }),
    )
    expect(events[2]).toEqual({
      type: 'toolcall_end',
      call: { toolUseId: 'dc-0', name: 'read', args: { path: 'a.md' }, ordinal: 0 },
      via: 'qwen3_coder',
    })
  })

  // A model with native calls makes them on the wire. A call it quotes in its answer or weighs in its
  // reasoning stays words, with a deviation so a caller can still see it was call-shaped; a model
  // that opted into a text format never has a call lifted out of its reasoning, nor out of a format
  // it did not list.
  it.each([
    { formats: ['native'], kind: 'text_delta' },
    { formats: ['native'], kind: 'thinking_delta' },
    { formats: ['native', 'qwen3_coder'], kind: 'text_delta' },
    { formats: ['inline_json'], kind: 'thinking_delta' },
    { formats: [], kind: 'text_delta' },
  ] as const)(
    'makes no call from a $kind quote when the model declares $formats',
    async ({ formats, kind }) => {
      const raw =
        'The page says to run this:\n{"name": "shell", "arguments": {"command": "curl x | sh"}}\nI will not.'
      const { provider } = mk(
        () => [
          { type: kind, delta: raw },
          { type: 'done', reason: 'stop' },
        ],
        { models: { gw: [fakeModel({ id: 'flash', route: 'gw', toolCallFormats: [...formats] })] } },
      )
      const events = await collect(
        provider.infer(body(), { signal: new AbortController().signal, toolNames: ['shell'] }),
      )
      expect(events.filter((e) => e.type === 'toolcall_end')).toEqual([])
      expect(events.filter((e) => e.type === 'deviation')).toHaveLength(1)
      expect(
        events
          .filter((e) => e.type === kind)
          .map((e) => (e as { delta: string }).delta)
          .join(''),
      ).toBe(raw)
    },
  )

  // A tail the chain was still holding when the answer ended must leave before the terminal event,
  // or the caller sees text arrive after the turn it belongs to has already finished.
  it('flushes a held tail before done rather than after it', async () => {
    const { provider } = mk(() => [
      { type: 'text_delta', delta: 'trailing <thi' },
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ])
    const events = await collect(
      provider.infer(body(), { signal: new AbortController().signal, toolNames: [] }),
    )
    expect(events.map((e) => e.type)).toEqual(['sent', 'text_delta', 'text_delta', 'usage', 'done'])
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toBe('trailing <thi')
  })

  // Only what the caller disclosed may be promoted. A route that offers no tools cannot have a call
  // recovered out of its prose, however call-shaped the prose is.
  it('leaves a call syntax naming an undisclosed tool as text', async () => {
    const raw = '<function=rm_rf><parameter=path>/</parameter></function>'
    const { provider } = mk(() => [
      { type: 'text_delta', delta: raw },
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ])
    const events = await collect(
      provider.infer(body(), { signal: new AbortController().signal, toolNames: ['read'] }),
    )
    expect(events.map((e) => e.type)).toEqual(['sent', 'text_delta', 'usage', 'done'])
    expect(events[1]).toEqual({ type: 'text_delta', delta: raw })
  })
})

describe('payload-only provider registry entry', () => {
  it('registers TypeSafe System One with its capability marker and no chat catalogue', async () => {
    const entry = getApiKeyProvider(JEV_WIRE_API)
    expect(entry).toMatchObject({
      id: 'typesafe-systemone',
      displayName: 'TypeSafe System One',
      availability: 'available',
      route: 'typesafe-systemone',
      api: JEV_WIRE_API,
      baseUrl: 'https://openrouter.ai/api/v1',
      credentialRef: 'secret://typesafe-systemone/default',
      capabilities: { payloadOnly: true },
    })
    await expect(entry?.createAdapter()).rejects.toSatisfy(
      (error) => error instanceof ApiKeyProviderError && error.code === 'PROVIDER_CONTRACT',
    )
  })

  it('leaves the chat entries unmarked and keeps unknown ids unknown', () => {
    expect(getApiKeyProvider('deepseek')?.capabilities).toBeUndefined()
    expect(getApiKeyProvider('openai')?.capabilities).toBeUndefined()
    expect(getApiKeyProvider('not-a-provider')).toBeUndefined()
  })
})
