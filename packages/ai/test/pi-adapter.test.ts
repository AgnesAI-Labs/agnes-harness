import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderStreamOptions,
  UserMessage,
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { redact } from '../src/adapters/pi/errors.js'
import { toContext } from '../src/adapters/pi/to-context.js'
import type { WireEvent } from '../src/index.js'
import { createProvider, NullContractStore, PiAdapter, toPiModel } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'

const route = {
  route: 'gw',
  api: 'openai-completions',
  baseUrl: 'https://gw.invalid/v1',
  credentialRef: 'secret://agnes/gateway',
  models: [
    fakeModel({ id: 'flash', route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid/v1' }),
  ],
}

function assistant(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
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
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...over,
  }
}

/** A stand-in for pi's stream: plays a script per call and records what it was handed. */
function fakeStream(scripts: AssistantMessageEvent[][]) {
  const seen: Array<{ model: Model<Api>; context: Context; options: ProviderStreamOptions | undefined }> = []
  let n = 0
  const impl = (model: Model<Api>, context: Context, options?: ProviderStreamOptions) => {
    seen.push({ model, context, options })
    const events = scripts[Math.min(n++, scripts.length - 1)] ?? []
    return (async function* () {
      for (const e of events) yield e
    })()
  }
  return { impl, seen }
}

async function collect(it: AsyncIterable<WireEvent>) {
  const out: WireEvent[] = []
  for await (const e of it) out.push(e)
  return out
}
const opts = (signal = new AbortController().signal) => ({
  signal,
  toolNames: ['read'],
  sessionKey: 'k',
  timeoutMs: { firstToken: 1000, total: 5000 },
})
const bound = (cfg: ConstructorParameters<typeof PiAdapter>[0]) => {
  const a = new PiAdapter(cfg)
  a.bindCredential('gw', 'sk-1')
  return a
}
const partial = assistant()

it('resolves request credentials without shared binding races and refreshes on subsequent calls', async () => {
  let count = 0
  const pending: Array<(key: string) => void> = []
  const wire = fakeStream([[{ type: 'done', reason: 'stop', message: assistant() }]])
  const adapter = new PiAdapter({
    manualRoutes: [route],
    streamImpl: wire.impl,
    resolveCredential: () => {
      count++
      return new Promise((resolve) => pending.push(resolve))
    },
  })
  const one = collect(adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
  const two = collect(adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
  expect(pending).toHaveLength(2)
  pending[1]?.('account-b')
  pending[0]?.('account-a')
  await Promise.all([one, two])
  expect(wire.seen.map((s) => s.options?.apiKey)).toEqual(['account-b', 'account-a'])
  expect(count).toBe(2)
  const third = collect(adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
  pending[2]?.('rotated-a')
  await third
  expect(wire.seen[2]?.options?.apiKey).toBe('rotated-a')
})

it('invalidates and resolves OAuth once after an initial AUTH rejection', async () => {
  const wire = fakeStream([
    [err('401 Unauthorized')],
    [{ type: 'done', reason: 'stop', message: assistant() }],
  ])
  const resolved = ['expired-access', 'fresh-access']
  const rejected: string[] = []
  const adapter = new PiAdapter({
    manualRoutes: [route],
    streamImpl: wire.impl,
    resolveCredential: async () => ({ apiKey: resolved.shift() ?? 'unexpected' }),
    recoverRejectedAuth: async (_route, auth) => {
      rejected.push(auth.apiKey ?? '')
      return true
    },
    sleep: async () => {},
  })
  const events = await collect(adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
  expect(events.map((event) => event.type)).toEqual(['usage', 'done'])
  expect(rejected).toEqual(['expired-access'])
  expect(wire.seen.map((seen) => seen.options?.apiKey)).toEqual(['expired-access', 'fresh-access'])
})

it('does not loop or recover AUTH after output', async () => {
  const twice = fakeStream([
    [err('401 Unauthorized')],
    [err('401 Unauthorized')],
    [{ type: 'done', reason: 'stop', message: assistant() }],
  ])
  let invalidations = 0
  const adapter = new PiAdapter({
    manualRoutes: [route],
    streamImpl: twice.impl,
    resolveCredential: async () => ({ apiKey: 'access' }),
    recoverRejectedAuth: async () => {
      invalidations++
      return true
    },
    sleep: async () => {},
  })
  const events = await collect(adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
  expect(events).toMatchObject([{ type: 'error', code: 'AUTH', retryable: false }])
  expect(invalidations).toBe(1)
  expect(twice.seen).toHaveLength(2)

  const late = fakeStream([
    [{ type: 'text_delta', contentIndex: 0, delta: 'partial', partial }, err('401 Unauthorized')],
  ])
  const afterOutput = new PiAdapter({
    manualRoutes: [route],
    streamImpl: late.impl,
    resolveCredential: async () => ({ apiKey: 'access' }),
    recoverRejectedAuth: async () => {
      throw new Error('private-refresh-token')
    },
  })
  const lateEvents = await collect(
    afterOutput.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()),
  )
  expect(lateEvents.map((event) => event.type)).toEqual(['text_delta', 'error'])
  expect(JSON.stringify(lateEvents)).not.toContain('private-refresh-token')
  expect(late.seen).toHaveLength(1)
})

it('keeps the sanitized AUTH result when recovery fails', async () => {
  const wire = fakeStream([[err('401 Unauthorized private-refresh-token')]])
  const adapter = new PiAdapter({
    manualRoutes: [route],
    streamImpl: wire.impl,
    resolveCredential: async () => ({ apiKey: 'access' }),
    recoverRejectedAuth: async () => {
      throw new Error('private-refresh-token')
    },
  })
  const events = await collect(adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
  expect(events).toMatchObject([{ type: 'error', code: 'AUTH', message: 'status=401' }])
  expect(JSON.stringify(events)).not.toContain('private-refresh-token')
  expect(wire.seen).toHaveLength(1)
})

it('cancels a hung auth recovery and gives the replacement request a first-token deadline', async () => {
  let entered!: () => void
  const recoveryStarted = new Promise<void>((resolve) => {
    entered = resolve
  })
  const ac = new AbortController()
  const authWire = fakeStream([[err('401 Unauthorized')]])
  let credentialResolutions = 0
  const hungRecovery = new PiAdapter({
    manualRoutes: [route],
    streamImpl: authWire.impl,
    resolveCredential: async () => {
      credentialResolutions++
      return { apiKey: 'access' }
    },
    recoverRejectedAuth: async () => {
      entered()
      return new Promise<boolean>(() => {})
    },
  })
  const cancelled = collect(
    hungRecovery.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts(ac.signal)),
  )
  await recoveryStarted
  ac.abort()
  await expect(cancelled).resolves.toMatchObject([{ type: 'error', code: 'ABORTED' }])
  expect(credentialResolutions).toBe(1)

  let calls = 0
  const hungRetry = new PiAdapter({
    manualRoutes: [route],
    streamImpl: () => {
      calls++
      return (async function* () {
        if (calls === 1) yield err('401 Unauthorized')
        else await new Promise<void>(() => {})
      })()
    },
    resolveCredential: async () => ({ apiKey: calls === 0 ? 'stale' : 'fresh' }),
    recoverRejectedAuth: async () => true,
    sleep: async () => {},
  })
  const timedOut = await collect(
    hungRetry.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), {
      ...opts(),
      timeoutMs: { firstToken: 20, total: 1000 },
    }),
  )
  expect(timedOut).toMatchObject([
    { type: 'error', code: 'TIMEOUT', message: 'first token timeout', retryable: true },
  ])
  expect(calls).toBe(2)
})

it('applies OAuth headers and dynamic base URL to one request without mutating the shared route', async () => {
  const wire = fakeStream([[{ type: 'done', reason: 'stop', message: assistant() }]])
  const adapter = new PiAdapter({
    manualRoutes: [route],
    streamImpl: wire.impl,
    resolveCredential: async () => ({
      apiKey: 'request-token',
      baseUrl: 'https://request.invalid/v1',
      headers: { Authorization: 'Bearer request-token', 'X-Null': null },
    }),
  })
  await collect(adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
  expect(wire.seen[0]?.options?.apiKey).toBe('request-token')
  expect(wire.seen[0]?.options?.headers).toEqual({ Authorization: 'Bearer request-token', 'X-Null': null })
  expect(wire.seen[0]?.model.baseUrl).toBe('https://request.invalid/v1')
  expect(wire.seen[0]?.model.headers).toEqual({ Authorization: 'Bearer request-token' })
  expect(adapter.routes()[0]?.baseUrl).toBe('https://gw.invalid/v1')
})

it('fails closed without leaking refresh errors and cancels hung authentication before network I/O', async () => {
  const wire = fakeStream([])
  const adapter = new PiAdapter({
    manualRoutes: [route],
    streamImpl: wire.impl,
    resolveCredential: async () => {
      throw new Error('private-refresh-token')
    },
  })
  const events = await collect(adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
  expect(events).toMatchObject([{ type: 'error', code: 'AUTH', retryable: false }])
  expect(JSON.stringify(events)).not.toContain('private-refresh-token')
  const ac = new AbortController()
  const hung = new PiAdapter({
    manualRoutes: [route],
    streamImpl: wire.impl,
    resolveCredential: () => new Promise(() => {}),
  })
  const result = collect(hung.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts(ac.signal)))
  ac.abort()
  expect(await result).toMatchObject([{ type: 'error', code: 'ABORTED' }])
  expect(wire.seen).toEqual([])
})
const err = (m: string): AssistantMessageEvent => ({
  type: 'error',
  reason: 'error',
  error: assistant({ stopReason: 'error', errorMessage: m }),
})

describe('toContext', () => {
  it('maps system, three message roles and tools one-to-one', () => {
    const req = fakeRequest({
      tools: [
        {
          name: 'read',
          description: 'r',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', data: 'AAA', mimeType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 't' },
            { type: 'text', text: 'call' },
          ],
          toolCalls: [{ toolUseId: 'c1', name: 'read', args: { path: 'a' }, ordinal: 0 }],
        },
        {
          role: 'tool_result',
          toolUseId: 'c1',
          content: [{ type: 'text', text: 'file body' }],
          isError: false,
        },
      ],
    })
    const { context, tools } = toContext(req)
    expect(context.systemPrompt).toBe('sys')
    expect(context.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult'])
    const user = context.messages[0] as UserMessage
    expect(user.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
    ])
    const asst = context.messages[1] as AssistantMessage
    expect(asst.content.map((c) => c.type)).toEqual(['thinking', 'text', 'toolCall'])
    expect(asst.content[2]).toEqual({ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } })
    expect(context.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'read',
      isError: false,
    })
    expect(tools[0]).toMatchObject({ name: 'read', description: 'r' })
    expect(tools[0]?.parameters).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
    expect(context.tools).toBe(tools)
  })

  // A tool result names the call it answers, not the tool; the name is recovered from the call that
  // asked, so a provider that requires the name on the result gets the right one.
  it('recovers the tool name from the call the result answers', () => {
    const req = fakeRequest({
      messages: [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            { toolUseId: 'c1', name: 'read', args: {}, ordinal: 0 },
            { toolUseId: 'c2', name: 'shell', args: {}, ordinal: 1 },
          ],
        },
        { role: 'tool_result', toolUseId: 'c2', content: [], isError: true },
        { role: 'tool_result', toolUseId: 'gone', content: [], isError: false },
      ],
    })
    const { context } = toContext(req)
    expect(context.messages[1]).toMatchObject({ toolCallId: 'c2', toolName: 'shell', isError: true })
    expect(context.messages[2]).toMatchObject({ toolCallId: 'gone', toolName: 'unknown' })
  })

  // A link is not something every wire protocol can carry, so it goes over as the text it names
  // rather than being dropped, which would silently shorten the prompt.
  it('carries a resource link across as text', () => {
    const req = fakeRequest({
      messages: [{ role: 'user', content: [{ type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt' }] }],
    })
    const user = toContext(req).context.messages[0] as UserMessage
    expect(user.content).toEqual([{ type: 'text', text: 'a.txt file:///a.txt' }])
  })

  it('marks an assistant turn that asked for tools as having stopped for tool use', () => {
    const withCalls = fakeRequest({
      messages: [
        {
          role: 'assistant',
          content: [],
          toolCalls: [{ toolUseId: 'c1', name: 'read', args: {}, ordinal: 0 }],
        },
      ],
    })
    const without = fakeRequest({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    })
    expect((toContext(withCalls).context.messages[0] as AssistantMessage).stopReason).toBe('toolUse')
    expect((toContext(without).context.messages[0] as AssistantMessage).stopReason).toBe('stop')
  })
})

describe('PiAdapter', () => {
  it('declares the manual route without its catalogue, and the catalogue separately', () => {
    const a = new PiAdapter({ manualRoutes: [route] })
    expect(a.routes()).toEqual([
      {
        route: 'gw',
        api: 'openai-completions',
        baseUrl: 'https://gw.invalid/v1',
        credentialRef: 'secret://agnes/gateway',
      },
    ])
    expect(a.models('gw').map((m) => m.id)).toEqual(['flash'])
    expect(a.models('unknown')).toEqual([])
    expect(a.id).toBe('pi')
    expect(new PiAdapter({ id: 'other', manualRoutes: [] }).id).toBe('other')
  })

  it('hands pi the bound credential and the declared endpoint', async () => {
    const { impl, seen } = fakeStream([[{ type: 'done', reason: 'stop', message: assistant() }]])
    const a = bound({ manualRoutes: [route], streamImpl: impl })
    await collect(
      a.stream('gw', fakeRequest({ route: 'gw', model: 'flash', sessionKey: 'agnes:t:a:cli:dm:s7' }), opts()),
    )
    expect(seen[0]?.options?.apiKey).toBe('sk-1')
    expect(seen[0]?.model.baseUrl).toBe('https://gw.invalid/v1')
    expect(seen[0]?.model.id).toBe('flash')
    // the session key travels from the request, which is what the stamp committed to
    expect(seen[0]?.options?.sessionId).toBe('agnes:t:a:cli:dm:s7')
    // pi's own retry loop stays off: retrying is this adapter's decision, and it only retries
    // before the first event has been forwarded.
    expect(seen[0]?.options?.maxRetries).toBe(0)
  })

  // Falling back to whatever the environment happens to hold is exactly what a private deployment
  // forbids, so a route that declared a credential and did not get one does not reach the wire.
  it('refuses to stream a declared-credential route with nothing bound', async () => {
    const { impl, seen } = fakeStream([[{ type: 'done', reason: 'stop', message: assistant() }]])
    const a = new PiAdapter({ manualRoutes: [route], streamImpl: impl })
    const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    expect(events).toEqual([
      { type: 'error', reason: 'error', code: 'AUTH', message: 'route=gw', retryable: false },
    ])
    expect(seen).toHaveLength(0)
  })

  it('reports an unknown route or model as NO_MODEL without calling pi', async () => {
    const { impl, seen } = fakeStream([[{ type: 'done', reason: 'stop', message: assistant() }]])
    const a = bound({ manualRoutes: [route], streamImpl: impl })
    const unknownModel = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'ghost' }), opts()))
    const unknownRoute = await collect(
      a.stream('nope', fakeRequest({ route: 'nope', model: 'flash' }), opts()),
    )
    expect(unknownModel[0]).toMatchObject({ type: 'error', code: 'NO_MODEL', retryable: false })
    expect(unknownRoute[0]).toMatchObject({ type: 'error', code: 'NO_MODEL', retryable: false })
    expect(seen).toHaveLength(0)
  })

  it('translates pi events into deltas, a native tool call, then usage and done', async () => {
    const msg = assistant({ stopReason: 'toolUse' })
    const { impl } = fakeStream([
      [
        { type: 'start', partial: msg },
        { type: 'text_start', contentIndex: 0, partial: msg },
        { type: 'text_delta', contentIndex: 0, delta: 'he', partial: msg },
        { type: 'text_end', contentIndex: 0, content: 'he', partial: msg },
        { type: 'thinking_start', contentIndex: 1, partial: msg },
        { type: 'thinking_delta', contentIndex: 1, delta: 'mm', partial: msg },
        { type: 'thinking_end', contentIndex: 1, content: 'mm', partial: msg },
        { type: 'toolcall_start', contentIndex: 2, partial: msg },
        { type: 'toolcall_delta', contentIndex: 2, delta: '{"path"', partial: msg },
        {
          type: 'toolcall_end',
          contentIndex: 2,
          toolCall: { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } },
          partial: msg,
        },
        { type: 'done', reason: 'toolUse', message: msg },
      ],
    ])
    const a = bound({ manualRoutes: [route], streamImpl: impl })
    const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'thinking_delta',
      'toolcall_delta',
      'toolcall_end',
      'usage',
      'done',
    ])
    expect(events[3]).toEqual({
      type: 'toolcall_end',
      call: { toolUseId: 'c1', name: 'read', args: { path: 'a' }, ordinal: 0 },
    })
    expect(events[4]).toMatchObject({
      type: 'usage',
      tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 },
      creditSource: 'estimated',
    })
    expect(events[5]).toEqual({ type: 'done', reason: 'toolUse' })
  })

  it('maps each stop reason pi reports and carries reasoning tokens when it reports them', async () => {
    const reasons = ['stop', 'length', 'toolUse', 'deferred'] as const
    for (const reason of reasons) {
      const msg = assistant({ usage: { ...assistant().usage, reasoning: 7 } })
      const { impl } = fakeStream([[{ type: 'done', reason, message: msg }]])
      const a = bound({ manualRoutes: [route], streamImpl: impl })
      const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
      // pi's `deferred` has no outward counterpart yet, so it lands on the closest honest reading
      expect(events.at(-1)).toEqual({ type: 'done', reason: reason === 'deferred' ? 'stop' : reason })
      expect(events[0]).toMatchObject({
        tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 7 },
      })
    }
  })

  // An adapter reports what the turn consumed and not what it cost. Pricing moved up to the provider
  // facade, which is the only layer that knows the deployment's credit rate - an adapter pricing
  // from the catalogue alone would put a dollar figure in a column that may be denominated in
  // something else. `estimated` still travels, because it says no gateway billed this request.
  it('reports tokens and leaves pricing to the layer that knows the rate', async () => {
    const priced = {
      ...route,
      models: [
        fakeModel({
          id: 'flash',
          route: 'gw',
          cost: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
    }
    const { impl } = fakeStream([[{ type: 'done', reason: 'stop', message: assistant() }]])
    const a = bound({ manualRoutes: [priced], streamImpl: impl })
    const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    const usage = events[0] as Extract<WireEvent, { type: 'usage' }>
    expect(usage.tokens).toEqual({ input: 3, output: 2, cacheRead: 1, cacheWrite: 0 })
    expect(usage.creditSource).toBe('estimated')
    // Even at a price high enough that the old catalogue estimate was non-zero, nothing is claimed
    // here - so a caller cannot read an adapter's guess as an authoritative figure.
    expect(usage).not.toHaveProperty('credits')
  })

  // Ordinals number the calls within one stream. They are per-stream state: two runs in flight at
  // once must not consume each other's numbers, which a module-level counter would let them do.
  it('numbers tool calls per stream, from zero, even with two streams interleaved', async () => {
    const call = (id: string): AssistantMessageEvent => ({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id, name: 'read', arguments: {} },
      partial,
    })
    const script = [call('c1'), call('c2'), { type: 'done', reason: 'stop', message: assistant() } as const]
    const a = bound({
      manualRoutes: [route],
      streamImpl: fakeStream([script as AssistantMessageEvent[]]).impl,
    })
    const first = a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts())[Symbol.asyncIterator]()
    const second = a
      .stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts())
      [Symbol.asyncIterator]()
    const ordinals = []
    for (const it of [first, second, first, second]) {
      const { value } = await it.next()
      ordinals.push((value as Extract<WireEvent, { type: 'toolcall_end' }>).call.ordinal)
    }
    expect(ordinals).toEqual([0, 0, 1, 1])
  })

  it('retries before the first event but never after a delta', async () => {
    const { impl, seen } = fakeStream([
      [err('503 upstream')],
      [{ type: 'done', reason: 'stop', message: assistant() }],
    ])
    const a = bound({ manualRoutes: [route], streamImpl: impl, maxRetries: 2, sleep: async () => {} })
    const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    expect(events.map((e) => e.type)).toEqual(['usage', 'done'])
    expect(seen).toHaveLength(2)

    const late = fakeStream([
      [{ type: 'text_delta', contentIndex: 0, delta: 'a', partial }, err('503 upstream')],
      [{ type: 'done', reason: 'stop', message: assistant() }],
    ])
    const b = bound({ manualRoutes: [route], streamImpl: late.impl, maxRetries: 2, sleep: async () => {} })
    const ev2 = await collect(b.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    expect(ev2.map((e) => e.type)).toEqual(['text_delta', 'error'])
    expect(late.seen).toHaveLength(1)
  })

  it('gives up after the configured number of attempts and reports the failure', async () => {
    const waits: number[] = []
    const { impl, seen } = fakeStream([[err('503 upstream')]])
    const a = bound({
      manualRoutes: [route],
      streamImpl: impl,
      maxRetries: 2,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    expect(seen).toHaveLength(3)
    expect(waits).toEqual([500, 1000])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'TRANSPORT', retryable: true })
  })

  it.each(['429 Too Many Requests', '503 upstream'])(
    'disables retries per inference through the facade: %s',
    async (message) => {
      const { impl, seen } = fakeStream([[err(message)]])
      const waits: number[] = []
      const adapter = bound({
        manualRoutes: [route],
        streamImpl: impl,
        sleep: async (ms) => {
          waits.push(ms)
        },
      })
      const provider = createProvider({
        adapters: [adapter],
        routes: { primary: { route: 'gw', model: 'flash' } },
        contract: new NullContractStore(),
        secrets: () => 'sk-1',
        clock: () => 0,
      })
      const request = fakeRequest({ route: 'gw', model: 'flash' })
      const results = []
      for await (const event of provider.infer(request, { ...opts(), retry: false })) results.push(event)
      expect(results.at(-1)).toMatchObject({ type: 'error', retryable: true })
      expect(seen).toHaveLength(1)
      expect(waits).toEqual([])
      // A request override must not mutate the shared adapter's defaults.
      for await (const event of provider.infer(request, opts())) results.push(event)
      expect(seen).toHaveLength(4)
      expect(waits).toHaveLength(2)
    },
  )

  // A cancelled run stops asking. Retrying after an abort would keep a route busy on work the
  // caller has already walked away from.
  it('does not retry once the caller has aborted', async () => {
    const ac = new AbortController()
    const { impl, seen } = fakeStream([[err('503 upstream')]])
    const a = bound({ manualRoutes: [route], streamImpl: impl, maxRetries: 2, sleep: async () => {} })
    ac.abort()
    const events = await collect(
      a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts(ac.signal)),
    )
    expect(seen).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
  })

  it('reports an abort as ABORTED and does not offer a retry', async () => {
    const { impl } = fakeStream([
      [{ type: 'error', reason: 'aborted', error: assistant({ stopReason: 'aborted' }) }],
    ])
    const a = bound({ manualRoutes: [route], streamImpl: impl, maxRetries: 2, sleep: async () => {} })
    const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    expect(events).toEqual([
      { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false },
    ])
  })

  it('reports a stream that ended without saying anything as a retryable transport failure', async () => {
    const { impl } = fakeStream([[]])
    const a = bound({ manualRoutes: [route], streamImpl: impl, maxRetries: 0 })
    const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'TRANSPORT', retryable: true })
  })

  // Provider error text quotes request material and sometimes credentials, so what reaches an event
  // is a status code and a request id, and nothing else.
  it('reports the request id and keeps provider error text out of the event', async () => {
    const { impl } = fakeStream([
      [
        {
          type: 'error',
          reason: 'error',
          error: assistant({
            stopReason: 'error',
            errorMessage: 'HTTP 429 for key sk-live-secret at /v1/chat',
            responseId: 'resp_42',
          }),
        },
      ],
    ])
    const a = bound({ manualRoutes: [route], streamImpl: impl, maxRetries: 0 })
    const events = await collect(a.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), opts()))
    expect(events[0]).toMatchObject({ type: 'error', requestId: 'resp_42' })
    expect(JSON.stringify(events)).not.toContain('sk-live-secret')
    expect(JSON.stringify(events)).not.toContain('/v1/chat')
  })
})

describe('redact', () => {
  it('keeps a status code and a request id and drops everything else', () => {
    expect(redact('HTTP 503 upstream from sk-live-abc')).toBe('status=503')
    expect(redact('429 rate limited req_abc123def')).toBe('status=429 requestId=req_abc123def')
    expect(redact('connection reset by peer')).toBe('status=?')
    expect(redact('failed 4f8c2b1a-1111-2222-3333-444455556666')).toBe(
      'status=? requestId=4f8c2b1a-1111-2222-3333-444455556666',
    )
  })
})

describe('toPiModel', () => {
  it('carries the declared endpoint, api and route into the model pi is given', () => {
    const model = toPiModel(route, route.models[0] as ReturnType<typeof fakeModel>, { 'x-a': '1' })
    expect(model).toMatchObject({
      id: 'flash',
      api: 'openai-completions',
      provider: 'gw',
      baseUrl: 'https://gw.invalid/v1',
      contextWindow: 128000,
      maxTokens: 8192,
    })
    expect(model.headers).toEqual({ 'x-a': '1' })
  })

  it('merges per-request headers over the ones the catalogue declared', () => {
    const record = fakeModel({
      id: 'flash',
      route: 'gw',
      headers: { 'x-a': 'from-catalogue', 'x-b': 'kept' },
    })
    expect(toPiModel(route, record, { 'x-a': 'from-request' }).headers).toEqual({
      'x-a': 'from-request',
      'x-b': 'kept',
    })
  })
})
