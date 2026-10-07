import type { ModelAdapter } from '@agnes/extension-api'
import { validateModelRecord } from '@agnes/protocol'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderStreamOptions,
} from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { modelRecord } from '../src/adapters/pi/api-key-providers.js'
import {
  API_KEY_CREDENTIAL_REFS,
  API_KEY_PROVIDER_REGISTRY,
  createApiKeyProviderAdapters,
  createApiKeyProviderConfigs,
  createProvider,
  getApiKeyProvider,
  NullContractStore,
} from '../src/index.js'
import { modelAdaptersPlugin } from '../src/model-adapters.js'
import { fakeRequest } from '../testkit/index.js'

const expected = [
  ['deepseek', 'DeepSeek'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic / Claude'],
  ['google', 'Google / Gemini'],
  ['qwen', 'Qwen'],
  ['moonshot', 'Moonshot / Kimi'],
  ['kimi-coding', 'Kimi Coding Plan'],
  ['zai', 'Z.ai / GLM'],
  ['openrouter', 'OpenRouter'],
  ['minimax', 'MiniMax'],
  ['xai', 'xAI'],
  ['agnes-ai', 'Agnes AI'],
] as const

function assistant(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    stopReason: 'stop',
    timestamp: 0,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of it) events.push(event)
  return events
}

const streamOptions = () => ({
  signal: new AbortController().signal,
  toolNames: [],
  sessionKey: 'agnes:t:a:cli:dm:registry',
  timeoutMs: { firstToken: 1000, total: 5000 },
})

describe('API-key provider registry', () => {
  it('publishes exactly the twelve first-screen providers with stable friendly names', () => {
    expect(API_KEY_PROVIDER_REGISTRY.map(({ id, displayName }) => [id, displayName])).toEqual(expected)
    expect(new Set(API_KEY_PROVIDER_REGISTRY.map((entry) => entry.id)).size).toBe(12)
    expect(API_KEY_PROVIDER_REGISTRY.every((entry) => entry.availability === 'available')).toBe(true)
  })

  it.each(['api-key', 'oauth'] as const)(
    'constructs official %s adapters through the public factory and credential path',
    async (mode) => {
      const definitions: ModelAdapter[] = []
      modelAdaptersPlugin.apply({ modelAdapters: { register: (adapter) => definitions.push(adapter) } })
      const configs = await createApiKeyProviderConfigs()
      const legacy = await createApiKeyProviderAdapters()
      expect(configs.map((config) => ({ id: config.id, routes: config.routes }))).toEqual(
        legacy.map((adapter) => ({
          id: adapter.id,
          routes: adapter.routes().map((route) => ({ ...route, models: adapter.models(route.route) })),
        })),
      )
      const config = configs.find((entry) => entry.id === 'deepseek')!
      const definition = definitions.find((entry) => entry.id === config.routes[0]?.api)!
      let resolveCalls = 0
      const credentials =
        mode === 'oauth'
          ? {
              async resolve(_route: string, signal: AbortSignal) {
                signal.throwIfAborted()
                resolveCalls++
                return { apiKey: 'synthetic-live-auth' }
              },
            }
          : undefined
      const adapter = await definition.create({ ...config, ...(credentials ? { credentials } : {}) })
      expect(adapter.id).toBe('deepseek')
      if (mode === 'api-key') adapter.bindCredential?.('deepseek', 'synthetic-live-auth')
      const auth: (string | null)[] = []
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        auth.push(new Request(input, init).headers.get('authorization'))
        return new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      })
      try {
        for (let request = 0; request < 2; request++) {
          const events = await collect(
            adapter.stream(
              'deepseek',
              fakeRequest({ route: 'deepseek', model: 'deepseek-v4-pro' }),
              streamOptions(),
            ),
          )
          expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
        }
        expect(auth).toEqual(['Bearer synthetic-live-auth', 'Bearer synthetic-live-auth'])
        expect(resolveCalls).toBe(mode === 'oauth' ? 2 : 0)
      } finally {
        fetch.mockRestore()
        await adapter.dispose?.()
      }
    },
  )
  it('pre-registers all twelve providers without keys, then fails closed with AUTH only on selection', async () => {
    const adapters = await createApiKeyProviderAdapters({
      adapters: {
        deepseek: { modelIds: ['deepseek-v4-pro'] },
      },
    })
    expect(adapters.map((adapter) => adapter.id)).toEqual(expected.map(([id]) => id))
    expect([...API_KEY_CREDENTIAL_REFS]).toEqual(expected.map(([id]) => `secret://${id}/default`))

    const requested: string[] = []
    const provider = createProvider({
      adapters: [...adapters],
      routes: { primary: { route: 'deepseek', model: 'deepseek-v4-pro' } },
      contract: new NullContractStore(),
      secrets: (ref) => {
        requested.push(ref)
        throw new Error('not configured')
      },
      optionalCredentialRefs: API_KEY_CREDENTIAL_REFS,
      clock: () => 0,
    })

    // All eleven lookups were attempted, but none prevented route-table assembly.
    expect(requested).toEqual(expected.map(([id]) => `secret://${id}/default`))
    expect(provider.models().map((model) => model.route)).toContain('deepseek')
    const events = await collect(
      provider.infer(fakeRequest({ route: 'deepseek', model: 'deepseek-v4-pro' }), {
        signal: new AbortController().signal,
        toolNames: [],
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'AUTH', retryable: false })
  })

  it.each(expected.map(([id]) => id))(
    '%s is backed by a schema-valid pi catalogue and a fixed Agnes route',
    async (id) => {
      const entry = getApiKeyProvider(id)
      expect(entry?.availability).toBe('available')
      let boundKey: string | undefined
      const adapter = await entry?.createAdapter({
        streamImpl: (_model, _context, options) => {
          boundKey = options?.apiKey
          return (async function* (): AsyncIterable<AssistantMessageEvent> {
            yield { type: 'done', reason: 'stop', message: assistant() }
          })()
        },
      })
      expect(adapter).toBeDefined()
      const route = adapter?.routes()[0]
      expect(route).toMatchObject({
        route: id,
        api: entry?.api,
        baseUrl: entry?.baseUrl,
        credentialRef: `secret://${id}/default`,
      })
      const models = adapter?.models(id) ?? []
      expect(models.length).toBeGreaterThan(0)
      expect(models.every((model) => model.route === id && model.baseUrl === entry?.baseUrl)).toBe(true)
      expect(models.every((model) => validateModelRecord(model).ok)).toBe(true)
      const first = models[0]
      if (!adapter || !first) throw new Error(`missing ${id} adapter catalogue`)
      adapter.bindCredential(id, `${id}-explicit-key`)
      await collect(adapter.stream(id, fakeRequest({ route: id, model: first.id }), streamOptions()))
      expect(boundKey).toBe(`${id}-explicit-key`)
    },
  )

  it('keeps the DeepSeek key on the explicit credential seam and pins its destination', async () => {
    const seen: Array<{
      model: Model<Api>
      context: Context
      options: ProviderStreamOptions | undefined
    }> = []
    const streamImpl = (model: Model<Api>, context: Context, options?: ProviderStreamOptions) => {
      seen.push({ model, context, options })
      return (async function* (): AsyncIterable<AssistantMessageEvent> {
        yield { type: 'done', reason: 'stop', message: assistant() }
      })()
    }
    const entry = getApiKeyProvider('deepseek')
    const adapter = await entry?.createAdapter({ streamImpl, modelIds: ['deepseek-v4-pro'] })
    if (!adapter) throw new Error('missing DeepSeek adapter')
    const refs: string[] = []
    const provider = createProvider({
      adapters: [adapter],
      routes: { primary: { route: 'deepseek', model: 'deepseek-v4-pro' } },
      contract: new NullContractStore(),
      secrets: (ref) => {
        refs.push(ref)
        return 'direct-key-marker'
      },
      clock: () => 0,
    })

    await collect(
      provider.infer(
        fakeRequest({
          route: 'deepseek',
          model: 'deepseek-v4-pro',
          sampling: { thinking: 'high' },
        }),
        { signal: new AbortController().signal, toolNames: [] },
      ),
    )

    expect(refs).toEqual(['secret://deepseek/default'])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.model).toMatchObject({
      provider: 'deepseek',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(seen[0]?.options).toMatchObject({ apiKey: 'direct-key-marker', reasoningEffort: 'high' })
    expect(JSON.stringify(adapter)).not.toContain('direct-key-marker')
  })

  it('uses DeepSeek chat/completions and carries supported high thinking onto the real wire body', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      calls.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
      })
      throw new Error('test blocked network')
    }) as typeof globalThis.fetch
    try {
      const entry = getApiKeyProvider('deepseek')
      const adapter = await entry?.createAdapter({ modelIds: ['deepseek-v4-pro'], maxRetries: 0 })
      if (!adapter) throw new Error('missing DeepSeek adapter')
      adapter.bindCredential('deepseek', 'direct-key-marker')
      await collect(
        adapter.stream(
          'deepseek',
          fakeRequest({
            route: 'deepseek',
            model: 'deepseek-v4-pro',
            sampling: { thinking: 'high' },
          }),
          streamOptions(),
        ),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://api.deepseek.com/chat/completions',
      authorization: 'Bearer direct-key-marker',
      body: { reasoning_effort: 'high', thinking: { type: 'enabled' } },
    })
  })

  it('carries the corrected max thinking level onto the real DeepSeek wire body', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      calls.push({ body: JSON.parse(await request.clone().text()) as Record<string, unknown> })
      throw new Error('test blocked network')
    }) as typeof globalThis.fetch
    try {
      const entry = getApiKeyProvider('deepseek')
      const adapter = await entry?.createAdapter({ modelIds: ['deepseek-v4-pro'], maxRetries: 0 })
      if (!adapter) throw new Error('missing DeepSeek adapter')
      adapter.bindCredential('deepseek', 'direct-key-marker')
      await collect(
        adapter.stream(
          'deepseek',
          fakeRequest({ route: 'deepseek', model: 'deepseek-v4-pro', sampling: { thinking: 'max' } }),
          streamOptions(),
        ),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ body: { reasoning_effort: 'max' } })
  })

  it('filters the trusted pi catalogue by the key-specific DeepSeek /models result', async () => {
    const entry = getApiKeyProvider('deepseek')
    const adapter = await entry?.createAdapter({ modelIds: ['deepseek-v4-pro', 'invented-model'] })
    expect(adapter?.models('deepseek').map((model) => model.id)).toEqual(['deepseek-v4-pro'])
  })

  it('offers current DeepSeek Flash and preserves the corrected Pro thinking levels', async () => {
    const entry = getApiKeyProvider('deepseek')
    const adapter = await entry?.createAdapter({
      modelIds: ['deepseek-v4-pro', 'deepseek-flash'],
    })
    const models = adapter?.models('deepseek') ?? []
    const byId = new Map(models.map((model) => [model.id, model]))
    expect(byId.get('deepseek-v4-pro')?.thinkingLevelMap).toEqual({ low: 'low', high: 'high', max: 'max' })
    // V4.1 Flash uses the new upstream id and capabilities, not the retired V4 correction.
    expect(byId.get('deepseek-flash')).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { off: 'off', low: 'low', high: 'high', max: 'max' },
    })
  })

  it('preserves verified Agnes modalities and sends each model output allowance on the wire', async () => {
    const adapter = await getApiKeyProvider('agnes-ai')?.createAdapter()
    const inputs = Object.fromEntries(
      (adapter?.models('agnes-ai') ?? []).map((model) => [model.id, model.input]),
    )
    expect(inputs).toEqual({
      'agnes-3.0-flash': ['text', 'image'],
      'agnes-2.5-pro': ['text'],
      'agnes-2.5-pro-alpha': ['text'],
      'agnes-2.5-pro-beta': ['text'],
      'agnes-2.5-flash': ['text', 'image'],
      'agnes-2.0-flash': ['text', 'image'],
    })
    if (!adapter) throw new Error('missing Agnes adapter')
    for (const record of adapter.models('agnes-ai'))
      expect(record.inputLimits?.images?.maxPerRequest).toBe(record.input.includes('image') ? 4 : undefined)
    adapter.bindCredential('agnes-ai', 'fixture-output-limit-key')
    const bodies: Array<Record<string, unknown>> = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      bodies.push((await new Request(input, init).json()) as Record<string, unknown>)
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    try {
      for (const model of Object.keys(inputs)) {
        expect(adapter.models('agnes-ai').find((entry) => entry.id === model)?.maxTokens).toBe(65536)
        for (const maxTokens of [undefined, 512, 32768]) {
          const events = await collect(
            adapter.stream(
              'agnes-ai',
              fakeRequest({
                route: 'agnes-ai',
                model,
                ...(maxTokens === undefined ? {} : { sampling: { maxTokens } }),
              }),
              streamOptions(),
            ),
          )
          expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
          expect(bodies.at(-1)?.model).toBe(model)
          expect(bodies.at(-1)?.max_tokens).toBe(maxTokens ?? 65536)
          expect(bodies.at(-1)?.max_completion_tokens).toBeUndefined()
        }
      }
    } finally {
      fetch.mockRestore()
    }
  })

  it('fails closed when a requested thinking level is not supported by the selected model', async () => {
    let called = false
    const entry = getApiKeyProvider('deepseek')
    const adapter = await entry?.createAdapter({
      modelIds: ['deepseek-v4-pro'],
      streamImpl: () => {
        called = true
        return (async function* (): AsyncIterable<AssistantMessageEvent> {})()
      },
    })
    if (!adapter) throw new Error('missing DeepSeek adapter')
    adapter.bindCredential('deepseek', 'direct-key-marker')
    const events = await collect(
      adapter.stream(
        'deepseek',
        fakeRequest({ route: 'deepseek', model: 'deepseek-v4-pro', sampling: { thinking: 'medium' } }),
        streamOptions(),
      ),
    )
    expect(called).toBe(false)
    expect(events).toEqual([
      {
        type: 'error',
        reason: 'error',
        code: 'FORMAT',
        message: 'route=deepseek model=deepseek-v4-pro thinking=medium unsupported',
        retryable: false,
      },
    ])
  })
})

it('retains pi image input limits in the public model catalogue', () => {
  const inputLimits = {
    maxRequestBytes: 2048,
    images: {
      maxPerMessage: 2,
      maxPerRequest: 3,
      resize: { maxWidth: 100, maxBytes: 1000, jpegQuality: 80 },
    },
  }
  const source = {
    id: 'vision',
    name: 'Vision',
    api: 'openai-completions',
    provider: 'gw',
    baseUrl: 'https://gw.invalid',
    input: ['text', 'image'],
    inputLimits,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10000,
    maxTokens: 1000,
  } as Model<Api>
  const record = modelRecord({ id: 'gw', api: source.api, baseUrl: source.baseUrl }, source)
  expect(record.inputLimits).toEqual(inputLimits)
  expect(validateModelRecord(record).ok).toBe(true)
  inputLimits.images.maxPerMessage = 9
  expect(record.inputLimits?.images?.maxPerMessage).toBe(2)
})
