import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiAdapter, probeCustomModel } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'

const baseUrl = 'https://synthetic.invalid/v1'
const model = 'synthetic-model'
const apiKey = 'synthetic-key'
const record = fakeModel({
  id: model,
  route: 'custom-openai',
  api: 'openai-completions',
  baseUrl,
  reasoning: false,
  compat: { supportsMidConvoSystemMessages: false, supportsDeveloperRole: false, supportsStore: false },
})
const encoder = new TextEncoder()
const sse = (events: unknown[]): Response =>
  new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
function completion(options: { model?: string | null; text?: string; reason?: string } = {}): Response {
  const responseModel = options.model === null ? {} : { model: options.model ?? model }
  return sse([
    {
      id: 'synthetic',
      object: 'chat.completion.chunk',
      ...responseModel,
      choices: [{ index: 0, delta: { content: options.text ?? 'Synthetic response' }, finish_reason: null }],
    },
    {
      id: 'synthetic',
      object: 'chat.completion.chunk',
      ...responseModel,
      choices: [{ index: 0, delta: {}, finish_reason: options.reason ?? 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    },
  ])
}
function responses(): Response {
  const message = {
    id: 'message',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Synthetic response', annotations: [] }],
  }
  return sse([
    { type: 'response.created', response: { id: 'response', model, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
    {
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      item_id: 'message',
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      item_id: 'message',
      delta: 'Synthetic response',
    },
    { type: 'response.output_item.done', output_index: 0, item: message },
    {
      type: 'response.completed',
      response: {
        id: 'response',
        model,
        status: 'completed',
        output: [message],
        usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
      },
    },
  ])
}
const probe = (request: typeof fetch, selected = record) =>
  probeCustomModel({ baseUrl, model, record: selected, apiKey, request })
afterEach(() => vi.useRealTimers())

describe('custom model inference verification through the actual serializer', () => {
  it('sends both Completions probes with chronological system roles without changing the model declaration', async () => {
    const original = structuredClone(record)
    const originalFetch = globalThis.fetch
    const requests: Array<{ request: Request; body: Record<string, unknown> }> = []
    const result = await probe(async (input, init) => {
      const request = new Request(input, init)
      requests.push({ request, body: JSON.parse(await request.text()) })
      return completion()
    })
    expect(result).toEqual({
      baseUrl,
      model,
      api: 'openai-completions',
      ordering: 'unverified',
      checks: [
        { id: 'inference', status: 'passed' },
        { id: 'mid-conversation-system', status: 'passed' },
      ],
    })
    expect(
      requests.map(({ request }) => [
        request.url,
        request.method,
        request.redirect,
        request.headers.get('authorization'),
      ]),
    ).toEqual([
      [`${baseUrl}/chat/completions`, 'POST', 'error', `Bearer ${apiKey}`],
      [`${baseUrl}/chat/completions`, 'POST', 'error', `Bearer ${apiKey}`],
    ])
    expect(requests.map(({ body }) => body.stream)).toEqual([true, true])
    const messages = requests[1]?.body.messages as Array<{
      role: string
      content: string | Array<{ text: string }>
    }>
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'system', 'user'])
    expect(
      messages.map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.text).join(''),
      ),
    ).toEqual([
      'This is a synthetic connectivity test. Reply briefly.',
      'Reply briefly to this synthetic connectivity test.',
      'Acknowledged the earlier synthetic test.',
      'Additional synthetic test instruction: reply briefly.',
      'Reply briefly to the current synthetic test.',
    ])
    expect(record).toEqual(original)
    expect(globalThis.fetch).toBe(originalFetch)
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })

  it('keeps ordinary inference success separate from a rejected mid-conversation request', async () => {
    const result = await probe(async (input, init) => {
      const body = JSON.parse(await new Request(input, init).text())
      return body.messages.length > 2 ? new Response('Private gateway data', { status: 400 }) : completion()
    })
    expect(result.checks).toEqual([
      { id: 'inference', status: 'passed' },
      { id: 'mid-conversation-system', status: 'failed', reason: 'endpoint' },
    ])
    expect(result.ordering).toBe('unverified')
  })

  it('uses real Responses streaming and reports mid-conversation systems as unsupported', async () => {
    const requests: string[] = []
    const result = await probe(
      async (input, init) => {
        const request = new Request(input, init)
        requests.push(request.url)
        expect(JSON.parse(await request.text())).toMatchObject({ model, stream: true })
        return responses()
      },
      { ...record, api: 'openai-responses' },
    )
    expect(requests).toEqual([`${baseUrl}/responses`])
    expect(result.checks).toEqual([
      { id: 'inference', status: 'passed' },
      { id: 'mid-conversation-system', status: 'skipped', reason: 'unsupported-api' },
    ])
  })

  it.each([401, 403])(
    'reports authentication refusal (%s) without retrying or echoing vendor data',
    async (status) => {
      const request = vi.fn<typeof fetch>(async () => new Response(`Sensitive ${apiKey}`, { status }))
      const result = await probe(request)
      expect(request).toHaveBeenCalledTimes(1)
      expect(result.checks).toEqual([
        { id: 'inference', status: 'failed', reason: 'authentication' },
        { id: 'mid-conversation-system', status: 'skipped', reason: 'authentication' },
      ])
      expect(JSON.stringify(result)).not.toContain(apiKey)
    },
  )

  it.each([
    [
      'non-stream JSON',
      () =>
        new Response('{"choices":[{"message":{"content":"OK"}}]}', {
          headers: { 'content-type': 'application/json' },
        }),
      'invalid-response',
    ],
    [
      'malformed SSE',
      () => new Response('data: {malformed}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      'invalid-response',
    ],
    ['empty text', () => completion({ text: ' ' }), 'invalid-response'],
    ['unfinished generation', () => completion({ reason: 'length' }), 'invalid-response'],
    [
      'network refusal',
      () => {
        throw new Error(`Sensitive network error ${apiKey}`)
      },
      'network',
    ],
  ] as const)('fails closed on %s', async (_name, response, reason) => {
    const request = vi.fn<typeof fetch>(async () => response())
    const result = await probe(request)
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.checks.map((check) => [check.status, check.reason])).toEqual([
      ['failed', reason],
      ['failed', reason],
    ])
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })

  it('allows an omitted response model without claiming ordering or model identity verification', async () => {
    const result = await probe(async () => completion({ model: null }))
    expect(result.checks.map((check) => check.status)).toEqual(['passed', 'passed'])
    expect(result.ordering).toBe('unverified')
  })

  it('accepts a gateway-resolved model alias while keeping the tested request model unchanged', async () => {
    const original = structuredClone(record)
    const result = await probe(async () => completion({ model: 'resolved-model' }))
    expect(result.checks.map((check) => check.status)).toEqual(['passed', 'passed'])
    expect(result.model).toBe(model)
    expect(record).toEqual(original)
    expect(JSON.stringify(result)).not.toContain('resolved-model')
  })

  it('handles valid SSE split across JSON frames and UTF-8 characters', async () => {
    const result = await probe(async () => {
      const bytes = new Uint8Array(await completion({ text: '测试回复' }).arrayBuffer())
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7)
              controller.enqueue(bytes.slice(offset, offset + 7))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      )
    })
    expect(result.checks.map((check) => check.status)).toEqual(['passed', 'passed'])
  })

  it.each([
    `data: {${apiKey}}\n\n`,
    `:comment\rdata: {${apiKey}}\r\r`,
    `event: ${apiKey}\n\n`,
    `:${apiKey}\ndata\n\n`,
    'data:\n\n',
    `\uFEFFdata: {${apiKey}}\n\n`,
    `:comment\n\uFEFFdata: {${apiKey}}\n\n`,
    `:comment\n\uFEFF\uFEFFdata: {"valid":true}\nevent: ${apiKey}\n\n`,
  ])('rejects malformed gateway frames before the SDK can log their private contents (%s)', async (frame) => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await probe(
        async () =>
          new Response(frame, {
            headers: { 'content-type': 'text/event-stream' },
          }),
      )
      expect(result.checks.map((check) => check.reason)).toEqual(['invalid-response', 'invalid-response'])
      expect(logger).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain(apiKey)
    } finally {
      logger.mockRestore()
    }
  })

  it('bounds response bytes and cancels the response instead of consuming unbounded data', async () => {
    const cancelled = vi.fn()
    const result = await probe(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('x'.repeat(1024 * 1024 + 1)))
            },
            cancel: cancelled,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    expect(cancelled).toHaveBeenCalled()
    expect(result.checks.map((check) => check.reason)).toEqual(['invalid-response', 'invalid-response'])
  })

  it('times out an injected fetch that ignores cancellation with no retry or real wait', async () => {
    vi.useFakeTimers()
    const request = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const pending = probe(request)
    await vi.advanceTimersByTimeAsync(60_001)
    const result = await pending
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.checks.map((check) => check.reason)).toEqual(['timeout', 'timeout'])
  })

  it('keeps the injected transport when an adapter is durably prepared', async () => {
    const calls: string[] = []
    const adapter = new PiAdapter({
      manualRoutes: [{ route: 'custom-openai', api: 'openai-completions', baseUrl, models: [record] }],
      fetchImpl: async (input, init) => {
        calls.push(new Request(input, init).url)
        return completion()
      },
      maxRetries: 0,
    })
    adapter.bindCredential('custom-openai', apiKey)
    const request = fakeRequest({ route: 'custom-openai', model })
    const prepared = await adapter.prepare('custom-openai', request, { signal: new AbortController().signal })
    const events = []
    for await (const event of prepared.adapter.stream('custom-openai', request, {
      signal: new AbortController().signal,
      toolNames: [],
      sessionKey: request.sessionKey,
      retry: false,
      timeoutMs: { firstToken: 1000, total: 1000 },
    }))
      events.push(event)
    expect(calls).toEqual([`${baseUrl}/chat/completions`])
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
  })
})
