import type { RequestBody } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { AGNES_SYS1_WIRE_API, AgnesSys1Adapter, validateModelBaseUrl, type WireEvent } from '../src/index.js'

const route = 'sys1'
const api = AGNES_SYS1_WIRE_API
const model = 'agnes-sys1-1.0'
const domestic = 'https://litellm-sa.agnes-ai.cn/sys1/v1'
const international = 'https://agrouter-sg.agnes-ai.com/sa/sys1/v1'
const payload = {
  state: 'A customer wants a billing error checked quickly.',
  questions: {
    route: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Billing', sales: 'Sales' } },
    urgent: { type: 'noul', instructions: 'Did the customer ask for quick handling?' },
  },
}
const answers = {
  route: {
    type: 'choice',
    choice: 'billing',
    probabilities: { billing: 0.998, sales: 0.002 },
    confidence: 0.997,
  },
  urgent: { type: 'noul', noul: 0.999 },
}
const request: RequestBody = {
  kind: 'inference',
  sessionKey: 'agnes:sys1:test',
  slot: 'primary',
  route,
  model,
  contractId: null,
  derivedHash: 'a'.repeat(64),
  system: '',
  messages: [],
  tools: [],
  payload,
}

async function run(
  baseUrl: string,
  fetch: typeof globalThis.fetch,
  credential = 'test-key',
  signal = new AbortController().signal,
) {
  const adapter = new AgnesSys1Adapter({
    routes: [{ api, route, baseUrl, models: [] }],
    network: () => ({ fetch, close: async () => {} }),
  })
  try {
    if (credential) adapter.bindCredential(route, credential)
    const events: WireEvent[] = []
    for await (const event of adapter.stream(route, request, {
      sessionKey: request.sessionKey,
      toolNames: [],
      signal,
      timeoutMs: { firstToken: 5_000, total: 5_000 },
    })) {
      events.push(event)
    }
    return events
  } finally {
    await adapter.dispose()
  }
}

it.each([domestic, international])('posts typed judgments to the configured gateway %s', async (baseUrl) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ model, answers, usage: { input_tokens: 164, output_tokens: 0 } }),
  )
  const events = await run(baseUrl, fetch)
  const [url, init] = fetch.mock.calls[0] ?? []
  expect(url).toBe(`${baseUrl}/systemone`)
  expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key')
  expect(JSON.parse(String(init?.body))).toEqual({ model, ...payload })
  expect(events[0]).toEqual({ type: 'text_delta', delta: JSON.stringify(answers) })
  expect(events[1]).toMatchObject({ type: 'usage', tokens: { input: 164, output: 0 } })
  expect(events[1]).not.toHaveProperty('billing')
  expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
})

it('refuses non-loopback cleartext and stops before sending when auth is missing', async () => {
  expect(() => validateModelBaseUrl({ api, route, baseUrl: 'http://192.0.2.1/sys1/v1' })).toThrow()
  const fetch = vi.fn<typeof globalThis.fetch>()
  expect((await run(domestic, fetch, '')).at(-1)).toMatchObject({ type: 'error', code: 'AUTH' })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  { body: 'unauthorized', status: 401, code: 'AUTH' },
  { body: '{}', status: 200, code: 'FORMAT' },
  { body: 'x'.repeat(1024 * 1024 + 1), status: 200, code: 'FORMAT' },
])('rejects an unusable response with $code', async ({ body, status, code }) => {
  const events = await run(domestic, async () => new Response(body, { status }))
  expect(events.at(-1)).toMatchObject({ type: 'error', code })
  expect(events.some((event) => event.type === 'text_delta')).toBe(false)
})
