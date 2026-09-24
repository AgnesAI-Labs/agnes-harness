import { createServer } from 'node:http'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { PiAdapter } from '../src/adapters/pi/index.js'
import { fakeModel } from '../testkit/index.js'
import { installLoopbackOnly, restoreLoopbackOnly } from './loopback-only.js'

const model = fakeModel({ id: 'flash', route: 'gw', reasoning: false })
const route = {
  route: 'gw',
  api: 'pi-messages',
  baseUrl: 'http://127.0.0.1:1/v1',
  models: [model],
  credentialRef: 'secret://doctor',
}
const message: AssistantMessage = {
  role: 'assistant',
  content: [],
  api: 'openai-completions',
  provider: 'gw',
  model: 'flash',
  stopReason: 'stop',
  timestamp: 0,
  usage: {
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
}
const done: AssistantMessageEvent = { type: 'done', reason: 'stop', message }
function scripted(events: AssistantMessageEvent[], reasoning = false) {
  const streamImpl = vi.fn(async function* () {
    yield* events
  })
  const adapter = new PiAdapter({
    manualRoutes: [{ ...route, models: [{ ...model, reasoning }] }],
    streamImpl,
    maxRetries: 0,
  })
  adapter.bindCredential('gw', 'doctor-test-marker')
  return { adapter, streamImpl }
}
const signal = () => new AbortController().signal
const check = (r: Awaited<ReturnType<PiAdapter['probe']>>, name: string) => {
  const found = r.checks.find((c) => c.name === name)
  if (!found) throw new Error('missing diagnostic check')
  return found
}
afterEach(() => vi.useRealTimers())

it('uses real loopback HTTP, bound credentials, and actual wire event translation', async () => {
  installLoopbackOnly()
  const hits: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = []
  let catalogueRequests = 0
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      catalogueRequests++
      res.writeHead(200)
      res.end('{}')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    hits.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', model: 'flash', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', model: 'flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
    )
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test address')
    const adapter = new PiAdapter({
      manualRoutes: [
        {
          ...route,
          models: [model, { ...model, id: 'second' }],
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
      ],
      maxRetries: 0,
    })
    adapter.bindCredential('gw', 'doctor-test-marker')
    const result = await adapter.probe('gw', signal())
    expect(hits).toHaveLength(2)
    expect(catalogueRequests).toBe(1)
    expect(hits.map((hit) => hit.body.model)).toEqual(['flash', 'second'])
    expect(
      result.checks
        .filter((entry) => entry.name === 'minimal_inference')
        .map((entry) => JSON.parse(entry.detail ?? '').modelId),
    ).toEqual(['flash', 'second'])
    expect(
      result.checks
        .filter((entry) => entry.name === 'fields')
        .map((entry) => JSON.parse(entry.detail ?? '').modelId),
    ).toEqual(['flash', 'second'])
    expect(hits[0]).toMatchObject({
      url: '/v1/chat/completions',
      auth: 'Bearer doctor-test-marker',
      body: { model: 'flash', stream: true },
    })
    expect(hits[0]?.body.tools).toMatchObject([{ function: { name: 'noop' } }])
    expect(check(result, 'minimal_inference')).toMatchObject({ ok: true })
    expect(JSON.parse(check(result, 'minimal_inference').detail ?? '')).toMatchObject({
      modelId: 'flash',
      usageComplete: true,
      doneReason: 'stop',
    })
    expect(check(result, 'fields').ok).toBe(true)
    expect(result.ok).toBe(true)
    expect(check(result, 'models_endpoint').ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('doctor-test-marker')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    restoreLoopbackOnly()
  }
})

it('refuses an unbound credential before invoking transport', async () => {
  const { adapter, streamImpl } = scripted([done])
  adapter.bindCredential('gw', undefined)
  expect(check(await adapter.probe('gw', signal()), 'minimal_inference').ok).toBe(false)
  expect(streamImpl).not.toHaveBeenCalled()
})
it('does not call transport for a precancelled probe or unknown route', async () => {
  const { adapter, streamImpl } = scripted([done])
  expect(check(await adapter.probe('gw', AbortSignal.abort()), 'minimal_inference').ok).toBe(false)
  expect(check(await adapter.probe('missing', signal()), 'minimal_inference').ok).toBe(false)
  expect(streamImpl).not.toHaveBeenCalled()
})
it('binds observations to the selected first model and records native calls and thinking', async () => {
  const { adapter } = scripted([
    { type: 'thinking_delta', contentIndex: 0, delta: 'thought', partial: message },
    {
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { type: 'toolCall', id: 't', name: 'noop', arguments: {} },
      partial: message,
    },
    done,
  ])
  expect(
    JSON.parse(check(await adapter.probe('gw', signal()), 'minimal_inference').detail ?? ''),
  ).toMatchObject({
    modelId: 'flash',
    thinking: true,
    nativeToolCalls: true,
  })
})
it.each([0, -1, Number.NaN])('rejects invalid or zero input usage %s', async (input) => {
  const { adapter } = scripted([{ ...done, message: { ...message, usage: { ...message.usage, input } } }])
  expect(check(await adapter.probe('gw', signal()), 'fields').ok).toBe(false)
})
it('requires reasoning usage when the model declares reasoning', async () => {
  const { adapter } = scripted([done], true)
  const result = await adapter.probe('gw', signal())
  expect(JSON.parse(check(result, 'minimal_inference').detail ?? '').usageComplete).toBe(false)
  expect(check(result, 'fields').ok).toBe(false)
})
it('does not treat a partial stream as completed', async () => {
  const { adapter } = scripted([{ type: 'text_delta', contentIndex: 0, delta: 'pong', partial: message }])
  expect(check(await adapter.probe('gw', signal()), 'minimal_inference').ok).toBe(false)
})
it('suppresses thrown provider details', async () => {
  const adapter = new PiAdapter({
    manualRoutes: [route],
    streamImpl: () => {
      throw new Error('PRIVATE-MARKER')
    },
  })
  adapter.bindCredential('gw', 'doctor-test-marker')
  const result = await adapter.probe('gw', signal())
  expect(check(result, 'minimal_inference').ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain('PRIVATE-MARKER')
})
it('uses the actual default 30-second stream deadline for an uncooperative transport', async () => {
  vi.useFakeTimers()
  const adapter = new PiAdapter({
    manualRoutes: [route],
    streamImpl: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}),
      }),
    }),
  })
  adapter.bindCredential('gw', 'doctor-test-marker')
  const result = adapter.probe('gw', signal())
  let settled = false
  void result.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(29_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(settled).toBe(true)
  expect(check(await result, 'minimal_inference').ok).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('never sends later model requests after cancellation during the first model', async () => {
  const ac = new AbortController()
  const seen: string[] = []
  const adapter = new PiAdapter({
    manualRoutes: [{ ...route, models: [model, { ...model, id: 'second' }] }],
    streamImpl: async function* (requested) {
      seen.push(requested.id)
      ac.abort()
      yield done
    },
  })
  adapter.bindCredential('gw', 'doctor-test-marker')
  const result = await adapter.probe('gw', ac.signal)
  expect(seen).toEqual(['flash'])
  expect(result.ok).toBe(false)
  expect(
    result.checks.filter((entry) => entry.name === 'minimal_inference').map((entry) => entry.ok),
  ).toEqual([false, false])
})
it('keeps an empty route model catalogue unsuccessful', async () => {
  const streamImpl = vi.fn(async function* () {
    yield done
  })
  const adapter = new PiAdapter({ manualRoutes: [{ ...route, models: [] }], streamImpl })
  adapter.bindCredential('gw', 'doctor-test-marker')
  expect(check(await adapter.probe('gw', signal()), 'minimal_inference').ok).toBe(false)
  expect(streamImpl).not.toHaveBeenCalled()
})
it('fixes the model list before asynchronous probe work begins', async () => {
  const models = [model, { ...model, id: 'second' }]
  const seen: string[] = []
  const adapter = new PiAdapter({
    manualRoutes: [{ ...route, models }],
    streamImpl: async function* (requested) {
      seen.push(requested.id)
      if (seen.length === 1) models.push({ ...model, id: 'late' })
      yield done
    },
  })
  adapter.bindCredential('gw', 'doctor-test-marker')
  await adapter.probe('gw', signal())
  expect(seen).toEqual(['flash', 'second'])
})
