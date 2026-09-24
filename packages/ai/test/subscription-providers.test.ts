import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSubscriptionProvider,
  SUBSCRIPTION_PROVIDER_REGISTRY,
  subscriptionAuth,
  subscriptionCredentialAuth,
  subscriptionModels,
  testSubscriptionCredential,
} from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

it('invalidates only the exact rejected OAuth credential and runs locked refresh on next resolve', async () => {
  let current = {
    type: 'oauth' as const,
    access: 'rejected-access',
    refresh: 'refresh',
    expires: Date.now() + 600_000,
  }
  const store = {
    read: async () => current,
    list: async () => [{ providerId: 'kimi-coding', type: 'oauth' as const }],
    modify: async (
      _providerId: string,
      mutate: (value: typeof current) => Promise<typeof current | undefined>,
    ) => {
      const next = await mutate(current)
      if (next) current = next
      return current
    },
    delete: async () => {},
  }
  const auth = subscriptionAuth('kimi-coding', store)
  const signal = new AbortController().signal
  const rejected = await auth.resolve(signal)
  await expect(auth.recoverRejected(rejected, new AbortController().signal)).resolves.toBe(true)
  expect(current.expires).toBe(1)

  const requests: Request[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init))
    return Response.json({
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      expires_in: 3600,
    })
  })
  await expect(auth.resolve(signal)).resolves.toEqual({
    headers: { Authorization: 'Bearer fresh-access' },
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://auth.kimi.com/api/oauth/token')
  expect(await requests[0]?.text()).toContain('grant_type=refresh_token')
  expect(current).toMatchObject({ access: 'fresh-access', refresh: 'fresh-refresh' })

  const refreshedExpiry = current.expires
  await expect(auth.recoverRejected(rejected, new AbortController().signal)).resolves.toBe(true)
  expect(current).toMatchObject({
    access: 'fresh-access',
    refresh: 'fresh-refresh',
    expires: refreshedExpiry,
  })
})

it('keeps the xAI provider identity and Bearer auth when testing an account route', async () => {
  const access = ['fixture', 'xai', 'access'].join('-')
  const requests: Request[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init))
    const response = {
      id: 'fixture',
      status: 'completed',
      output: [],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    }
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  expect(
    await testSubscriptionCredential('xai', { apiKey: access }, 'grok-4.5', new AbortController().signal),
  ).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://api.x.ai/v1/responses')
  expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${access}`)
  expect(await requests[0]?.json()).toMatchObject({
    model: 'grok-4.5',
    include: ['reasoning.encrypted_content'],
  })
})

it.each([
  [401, 'AUTH'],
  [402, 'QUOTA'],
  [429, 'RATE_LIMIT'],
  [503, 'TRANSPORT'],
])(
  'retains safe failure category for HTTP %s without leaking the upstream response',
  async (status, code) => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('fixture-private-access-token', { status: Number(status) }),
    )
    await expect(
      testSubscriptionCredential(
        'kimi-coding',
        { headers: { Authorization: 'Bearer fixture-access' } },
        'kimi-for-coding',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code, message: 'Subscription inference test failed' })
  },
)

it('sends Kimi header-only OAuth through the real pi-ai HTTP client during the save test', async () => {
  const requests: Request[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'fixture',
          type: 'message',
          role: 'assistant',
          model: 'kimi-for-coding',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  })
  const auth = await subscriptionCredentialAuth('kimi-coding', {
    type: 'oauth',
    access: 'fixture-kimi-access',
    refresh: 'fixture-refresh',
    expires: Date.now() + 60_000,
  })
  const verified = await testSubscriptionCredential(
    'kimi-coding',
    auth,
    'kimi-for-coding',
    new AbortController().signal,
  )
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toContain('https://api.kimi.com/coding/v1/messages')
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer fixture-kimi-access')
  expect(requests[0]?.headers.get('x-api-key')).toBeNull()
  expect(await requests[0]?.json()).toMatchObject({ model: 'kimi-for-coding', stream: true })
  expect(verified).toBe(true)
})

const codexToken = `header.${Buffer.from(
  JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-a' } }),
).toString('base64url')}.signature`

describe('subscription provider registry', () => {
  it('freezes exactly the five pi-ai 0.85.1 subscription providers and their login methods', () => {
    expect(SUBSCRIPTION_PROVIDER_REGISTRY.map(({ id, loginMethods }) => [id, [...loginMethods]])).toEqual([
      ['openai-codex', ['browser', 'device_code']],
      ['anthropic', ['browser']],
      ['github-copilot', ['device_code']],
      ['kimi-coding', ['device_code']],
      ['xai', ['device_code']],
    ])
    for (const entry of SUBSCRIPTION_PROVIDER_REGISTRY) {
      expect(getSubscriptionProvider(entry.id)).toBe(entry)
      expect(entry.models().length).toBeGreaterThan(0)
      expect(entry.models().every((model) => model.baseUrl === entry.baseUrl)).toBe(true)
    }
  })

  it('converts every provider credential into its complete request-local authentication shape', async () => {
    const expires = Date.now() + 3_600_000
    await expect(
      subscriptionCredentialAuth('openai-codex', {
        type: 'oauth',
        access: codexToken,
        refresh: 'refresh',
        expires,
        accountId: 'account-a',
      }),
    ).resolves.toEqual({ apiKey: codexToken })
    await expect(
      subscriptionCredentialAuth('anthropic', { type: 'oauth', access: 'claude', refresh: 'r', expires }),
    ).resolves.toEqual({ apiKey: 'claude' })
    await expect(
      subscriptionCredentialAuth('kimi-coding', { type: 'oauth', access: 'kimi', refresh: 'r', expires }),
    ).resolves.toEqual({ headers: { Authorization: 'Bearer kimi' } })
    await expect(
      subscriptionCredentialAuth('xai', { type: 'oauth', access: 'grok', refresh: 'r', expires }),
    ).resolves.toEqual({ apiKey: 'grok' })
    const copilotModels = subscriptionModels('github-copilot')
      .slice(0, 2)
      .map(({ id }) => id)
    await expect(
      subscriptionCredentialAuth('github-copilot', {
        type: 'oauth',
        access: 'copilot',
        refresh: 'r',
        expires,
        availableModelIds: copilotModels,
      }),
    ).resolves.toEqual({ apiKey: 'copilot', baseUrl: 'https://api.individual.githubcopilot.com' })
    expect(
      subscriptionModels('github-copilot', {
        type: 'oauth',
        access: 'copilot',
        refresh: 'r',
        expires,
        availableModelIds: copilotModels,
      }).map(({ id }) => id),
    ).toEqual(copilotModels)
  })
})
