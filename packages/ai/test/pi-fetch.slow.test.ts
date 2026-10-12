import { createServer, type ServerResponse } from 'node:http'
import {
  Agent,
  type Dispatcher,
  getGlobalDispatcher,
  setGlobalDispatcher,
  fetch as undiciFetch,
} from 'undici'
import { afterEach, describe, expect, it } from 'vitest'
import { inferenceFetch } from '../src/adapters/pi/fetch.js'
import { PiAdapter } from '../src/adapters/pi/index.js'
import type { WireEvent } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function fixture(reply: (response: ServerResponse) => void) {
  const original = getGlobalDispatcher()
  const shortIdle = new Agent({ headersTimeout: 10, bodyTimeout: 10 })
  setGlobalDispatcher(shortIdle)
  const server = createServer((request, response) => {
    request.resume()
    reply(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    setGlobalDispatcher(original)
    server.closeAllConnections()
    await Promise.all([shortIdle.destroy(), new Promise<void>((resolve) => server.close(() => resolve()))])
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  const adapter = new PiAdapter({
    manualRoutes: [
      {
        route: 'gw',
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${address.port}`,
        credentialRef: 'secret://test/gw',
        models: [
          fakeModel({ id: 'm', route: 'gw', reasoning: true, compat: { thinkingFormat: 'deepseek' } }),
        ],
      },
    ],
    maxRetries: 2,
  })
  adapter.bindCredential('gw', 'synthetic-only')
  return adapter
}

function start(response: ServerResponse) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'req-loopback' })
  response.write(
    'data: {"id":"local","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking"},"finish_reason":null}]}\n\n',
  )
}
function finish(response: ServerResponse) {
  response.end(
    'data: {"id":"local","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\ndata: [DONE]\n\n',
  )
}
async function collect(
  adapter: PiAdapter,
  total = 6000,
  controller = new AbortController(),
  abortOnOutput = false,
) {
  const events: WireEvent[] = []
  for await (const event of adapter.stream('gw', fakeRequest({ route: 'gw', model: 'm' }), {
    signal: controller.signal,
    toolNames: [],
    sessionKey: 'test',
    timeoutMs: { firstToken: 4000, total },
  })) {
    events.push(event)
    if (abortOnOutput && event.type === 'thinking_delta') controller.abort()
  }
  return events
}

describe('inference HTTP deadlines on the real streaming SDK path', () => {
  it('preserves a dispatch-only global transport and the v2 handler protocol', async () => {
    const adapter = await fixture((response) => {
      start(response)
      finish(response)
    })
    const pool = getGlobalDispatcher()
    const optionsSeen: Array<Dispatcher.DispatchOptions & { allowH2?: boolean }> = []
    const minimal = {
      dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
        optionsSeen.push(options)
        return pool.dispatch(options, handler)
      },
    } as Dispatcher
    setGlobalDispatcher(minimal)
    const request = inferenceFetch(undiciFetch as unknown as typeof fetch, () => {})
    const route = adapter.routes()[0]
    if (!route) throw new Error('Missing loopback route')
    const response = await request(route.baseUrl)
    expect(await response.text()).toContain('data: [DONE]')
    expect(optionsSeen).toHaveLength(1)
    expect(optionsSeen[0]?.allowH2).not.toBe(false)
    expect(getGlobalDispatcher()).toBe(minimal)
  })
  it.each(['headers', 'body'] as const)(
    'survives %s silence beyond the selected HTTP pool idle limit',
    async (silence) => {
      const adapter = await fixture((response) => {
        if (silence === 'body') start(response)
        setTimeout(() => {
          if (silence === 'headers') start(response)
          finish(response)
        }, 1800)
      })
      const selectedPool = getGlobalDispatcher()
      const route = adapter.routes()[0]
      if (!route) throw new Error('Missing loopback route')
      // Cross Undici's coarse timer window: the unpatched path must actually fail first.
      const baselineError = await fetch(route.baseUrl)
        .then((response) => response.text())
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(baselineError).toMatchObject({
        cause: { code: silence === 'headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT' },
      })
      const prepared = await adapter.prepare('gw', fakeRequest({ route: 'gw', model: 'm' }), {
        signal: new AbortController().signal,
      })
      const events = await collect(prepared.adapter as PiAdapter)
      expect(events.filter((event) => event.type === 'error')).toEqual([])
      expect(events.filter((event) => event.type === 'thinking_delta')).toMatchObject([{ delta: 'thinking' }])
      expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
      expect(getGlobalDispatcher()).toBe(selectedPool)
    },
  )
  it('stops an idle reasoning stream at the runtime total deadline and drains its connection', async () => {
    let closed = false
    const adapter = await fixture((response) => {
      response.on('close', () => {
        closed = true
      })
      start(response)
    })
    const events = await collect(adapter, 120)
    expect(events.filter((event) => event.type === 'error')).toMatchObject([
      { code: 'TIMEOUT', message: 'total timeout' },
    ])
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(closed).toBe(true)
  })
  it('retains explicit cancellation after reasoning output', async () => {
    const adapter = await fixture(start)
    const events = await collect(adapter, 4000, new AbortController(), true)
    expect(events.filter((event) => event.type === 'error')).toMatchObject([
      { code: 'ABORTED', retryable: false },
    ])
  })
  it('records a socket cause after output without replaying a partial answer', async () => {
    let requests = 0
    const adapter = await fixture((response) => {
      requests++
      start(response)
      setTimeout(() => response.destroy(), 30)
    })
    const events = await collect(adapter)
    expect(events.some((event) => event.type === 'thinking_delta')).toBe(true)
    const error = events.find((event) => event.type === 'error')
    expect(error).toMatchObject({ type: 'error', code: 'TRANSPORT', retryable: true })
    if (error?.type !== 'error') throw new Error('Missing transport error')
    expect(error.message).toContain('transportCode=UND_ERR_SOCKET')
    expect(error.message).toContain('cause=SocketError')
    expect(requests).toBe(1)
  })
})
