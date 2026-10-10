import { expect, it, vi } from 'vitest'
import {
  customModelRecord,
  customModelVerified,
  normalizeCustomModel,
  testCustomModel,
} from '../src/configuration-custom.js'
import { fetchModelPricePolicies, normalizeModelPricePolicies } from '../src/configuration-pricing.js'

const custom = {
  api: 'openai-completions' as const,
  contextWindow: 32768,
  maxTokens: 1024,
  input: ['text' as const],
  reasoning: false,
  toolCalls: true,
  maxTokensField: 'max_completion_tokens' as const,
}
it('keeps declarations explicit, unknown pricing and external parser contracts separate', () => {
  expect(normalizeCustomModel(custom)).toEqual(custom)
  expect(normalizeCustomModel({ ...custom, input: ['image'] })).toBeUndefined()
  expect(normalizeCustomModel({ ...custom, maxTokens: 32769 })).toBeUndefined()
  const model = customModelRecord('manual', 'https://custom.example.invalid/v1', custom)
  expect(model).toMatchObject({
    contract_id: null,
    compat: { maxTokensField: 'max_completion_tokens' },
    toolCallFormats: ['native'],
    pricePolicy: { perMillion: { inputUncached: null, output: null } },
  })
  expect(
    customModelRecord('manual', model.baseUrl ?? '', { ...custom, toolCalls: false }).toolCallFormats,
  ).toEqual([])
})

function reply(api: string, model: string): Response {
  const events =
    api === 'openai-responses'
      ? [
          { type: 'response.created', response: { id: 'r', model } },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg', role: 'assistant', content: [] },
          },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
          {
            type: 'response.completed',
            response: {
              id: 'r',
              model,
              status: 'completed',
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]
      : [
          {
            id: 'c',
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

it.each(['openai-completions', 'openai-responses'] as const)(
  'reports selected-model acceptance through %s without granting ordering capabilities',
  async (api) => {
    const sent: Request[] = []
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const wire = new Request(input, init)
      sent.push(wire.clone())
      expect(wire.redirect).toBe('error')
      expect(wire.headers.get('authorization')).toBe('Bearer synthetic-key')
      return reply(api, 'manual')
    })
    const declaration = { ...custom, api }
    const report = await testCustomModel({
      baseUrl: 'https://custom.example.invalid/v1/',
      model: 'manual',
      apiKey: 'synthetic-key',
      custom: declaration,
      request,
    })
    expect(report).toMatchObject({
      model: 'manual',
      api,
      ordering: 'unverified',
      checks: [
        { id: 'inference', status: 'passed' },
        { id: 'mid-conversation-system', status: api === 'openai-completions' ? 'passed' : 'skipped' },
      ],
    })
    expect(customModelVerified(declaration, report)).toBe(true)
    expect(customModelRecord('manual', report.baseUrl, declaration).compat).toMatchObject({
      supportsMidConvoSystemMessages: false,
    })
    expect(sent).toHaveLength(api === 'openai-completions' ? 2 : 1)
    expect(sent[0]?.url).toBe(
      `https://custom.example.invalid/v1/${api === 'openai-responses' ? 'responses' : 'chat/completions'}`,
    )
    expect(await sent[0]?.json()).toMatchObject({ model: 'manual', stream: true })
    if (api === 'openai-completions') {
      const body = await sent[1]?.json()
      expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
        'system',
        'user',
        'assistant',
        'system',
        'user',
      ])
    }
  },
)

it('requires a declared system capability to pass its shape test, separately from ordinary inference', async () => {
  const declaration = { ...custom, supportsMidConvoSystemMessages: true }
  expect(normalizeCustomModel({ ...declaration, api: 'openai-responses' })).toBeUndefined()
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const body = await new Request(input, init).json()
    return body.messages.some(
      (message: { role: string }, index: number) => index > 0 && message.role === 'system',
    )
      ? Response.json({ error: { message: 'synthetic-key upstream body' } }, { status: 400 })
      : reply('openai-completions', 'manual')
  })
  const report = await testCustomModel({
    baseUrl: 'https://custom.example.invalid/v1',
    model: 'manual',
    apiKey: 'synthetic-key',
    custom: declaration,
    request,
  })
  expect(report.checks).toEqual([
    { id: 'inference', status: 'passed' },
    { id: 'mid-conversation-system', status: 'failed', reason: 'endpoint' },
  ])
  expect(customModelVerified(declaration, report)).toBe(false)
  expect(customModelVerified(custom, report)).toBe(true)
  expect(JSON.stringify(report)).not.toContain('synthetic-key')
  expect(JSON.stringify(report)).not.toContain('upstream body')
})

it.each([
  [
    'token rates',
    {
      input_cost_per_token: 3e-7,
      output_cost_per_token: 1.2e-6,
      cache_read_input_token_cost: 6e-9,
      cache_creation_input_token_cost: 0,
    },
    { inputUncached: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  ],
  [
    'missing cache rate',
    { input_cost_per_token: 3e-7 },
    { inputUncached: 0.3, output: null, cacheRead: null, cacheWrite: null },
  ],
  [
    'explicit free',
    { input_cost_per_token: 0, output_cost_per_token: 0 },
    { inputUncached: 0, output: 0, cacheRead: null, cacheWrite: null },
  ],
  ['negative rate', { input_cost_per_token: -1 }, null],
  ['string rate', { input_cost_per_token: '0.3' }, null],
  ['overflow', { input_cost_per_token: Number.MAX_VALUE }, null],
  ['context tier', { input_cost_per_token: 3e-7, input_cost_per_token_above_128k_tokens: 6e-7 }, null],
  ['calendar', { input_cost_per_token: 3e-7, off_peak_pricing: { multiplier: 0.5 } }, null],
  ['discount schedule', { input_cost_per_token: 3e-7, discount_schedule: { multiplier: 0.5 } }, null],
  ['image rate', { input_cost_per_token: 3e-7, input_cost_per_image: 0.1 }, null],
  ['no price', {}, null],
] as const)('imports %s as exact-model estimates without guessing rates', async (_label, info, expected) => {
  const url = 'https://custom.example.invalid/v1/model/info'
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const wire = new Request(input, init)
    expect(wire.url).toBe(url)
    expect(wire.method).toBe('GET')
    expect(wire.redirect).toBe('error')
    expect(wire.headers.get('authorization')).toBe('Bearer synthetic-key')
    return Response.json({
      data: [
        { model_name: 'manual', model_info: info },
        { model_name: 'alias', model_info: { input_cost_per_token: 9 } },
      ],
    })
  })
  const policies = await fetchModelPricePolicies({
    baseUrl: 'https://custom.example.invalid/v1',
    apiKey: 'synthetic-key',
    ids: ['manual'],
    request,
  })
  if (expected === null) expect(policies).toEqual({})
  else {
    expect(policies.manual).toMatchObject({
      currency: 'USD',
      unit: 'per-million-tokens',
      perMillion: expected,
      source: { url },
    })
    expect(Object.keys(policies)).toEqual(['manual'])
    expect(JSON.stringify(policies)).not.toContain('synthetic-key')
    expect(normalizeModelPricePolicies(policies, ['manual'], 'https://custom.example.invalid/v1')).toEqual(
      policies,
    )
    expect(
      normalizeModelPricePolicies(policies, ['other'], 'https://custom.example.invalid/v1'),
    ).toBeUndefined()
    expect(
      normalizeModelPricePolicies(policies, ['manual'], 'https://different.example.invalid/v1'),
    ).toBeUndefined()
    expect(
      normalizeModelPricePolicies(
        { manual: { ...policies.manual, validUntil: 0, validFrom: 1 } },
        ['manual'],
        'https://custom.example.invalid/v1',
      ),
    ).toBeUndefined()
  }
})

it('rejects disagreeing deployments and falls back safely on unsupported or bounded metadata failures', async () => {
  const baseUrl = 'https://custom.example.invalid/v1'
  for (const response of [
    Response.json({}, { status: 403 }),
    Response.json({}, { status: 404 }),
    Response.json({
      data: [
        { model_name: 'manual', model_info: { input_cost_per_token: 1 } },
        { model_name: 'manual', model_info: { input_cost_per_token: 2 } },
      ],
    }),
    Response.json({
      data: [
        { model_name: 'manual', model_info: { input_cost_per_token: 1 } },
        { model_name: 'manual', model_info: { input_cost_per_token: -1 } },
      ],
    }),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response('private upstream body', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }),
    new Response(' '.repeat(1048577), { headers: { 'content-type': 'application/json' } }),
  ]) {
    expect(
      await fetchModelPricePolicies({
        baseUrl,
        apiKey: 'synthetic-key',
        ids: ['manual'],
        request: async () => response,
      }),
    ).toEqual({})
  }
  const request = vi.fn<typeof fetch>(async () => {
    throw new Error('private upstream error')
  })
  expect(
    await fetchModelPricePolicies({ baseUrl, apiKey: 'synthetic-key', ids: ['manual'], request }),
  ).toEqual({})
  for (const invalid of [
    'not-a-url',
    'file:///tmp/',
    'https://user:secret@custom.example.invalid/v1',
    `${baseUrl}?secret=1`,
  ]) {
    request.mockClear()
    expect(
      await fetchModelPricePolicies({ baseUrl: invalid, apiKey: 'synthetic-key', ids: ['manual'], request }),
    ).toEqual({})
    expect(request).not.toHaveBeenCalled()
  }
  let cancelled = false
  const invalidUtf8 = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]))
      },
      cancel() {
        cancelled = true
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  )
  expect(
    await fetchModelPricePolicies({
      baseUrl,
      apiKey: 'synthetic-key',
      ids: ['manual'],
      request: async () => invalidUtf8,
    }),
  ).toEqual({})
  expect(cancelled).toBe(true)
  vi.useFakeTimers()
  try {
    for (const request of [
      async () => new Promise<Response>(() => undefined),
      async () =>
        new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
    ]) {
      const pending = fetchModelPricePolicies({ baseUrl, apiKey: 'synthetic-key', ids: ['manual'], request })
      await vi.advanceTimersByTimeAsync(5001)
      await expect(pending).resolves.toEqual({})
    }
  } finally {
    vi.useRealTimers()
  }
})
