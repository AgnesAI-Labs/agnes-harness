import { createHash } from 'node:crypto'
import type { AiErrorCode, InferenceEvent, ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { AdapterStreamOptions, WireEvent } from '../src/index.js'
import {
  AiSetupError,
  createProvider,
  JEV_WIRE_API,
  JevAdapter,
  NullContractStore,
  validateModelBaseUrl,
} from '../src/index.js'
import { fakeModel } from '../testkit/index.js'

// Every case here runs against a scripted `fetch`, so nothing opens a socket. The same adapter against
// real sockets is covered in jev-adapter-loopback.test.ts.

const KEY = 'TEST-KEY-0123456789'
const USER_ID = 'user_SENTINEL_9f3c'
const SENTINEL = 'SENTINEL-BODY-TEXT'
const MODEL = 'typesafe/jev-1.13-20260917'
const BASE = 'https://jev.example.invalid/v1'
const NOW = Date.parse('2026-10-15T12:00:00Z')

type JevRoute = RouteDecl & { models: ModelRecord[]; keyless?: boolean }
type Call = { url: string; init: RequestInit }
type Reply = Response | Error | ((call: Call) => Response | Promise<Response>)

const routeDecl = (over: Partial<JevRoute> = {}): JevRoute => ({
  route: 'jev',
  api: JEV_WIRE_API,
  baseUrl: BASE,
  credentialRef: 'secret://jev/key',
  models: [fakeModel({ id: MODEL, route: 'jev', api: JEV_WIRE_API, baseUrl: BASE })],
  ...over,
})

const choice = (probabilities: Record<string, unknown> = { a: 0.7, b: 0.3 }) => ({
  type: 'choice',
  choice: 'a',
  probabilities,
  confidence: 0.8,
})
const PAYLOAD = {
  state: { step: 1 },
  questions: { q1: { type: 'choice', criteria: { a: 'A', b: 'B' } } },
}

type RequestOver = { [K in keyof RequestBody]?: RequestBody[K] | undefined }
const request = (over: RequestOver = {}): RequestBody => {
  const { payload, ...rest } = {
    kind: 'inference',
    sessionKey: 'agnes:t:a:cli:dm:x',
    slot: 'primary',
    route: 'jev',
    model: MODEL,
    contractId: null,
    derivedHash: 'a'.repeat(64),
    system: '',
    messages: [],
    tools: [],
    payload: PAYLOAD,
    ...over,
  }
  return (payload === undefined ? rest : { ...rest, payload }) as RequestBody
}

const options = (over: Partial<AdapterStreamOptions> = {}): AdapterStreamOptions => ({
  signal: new AbortController().signal,
  toolNames: [],
  sessionKey: 'agnes:t:a:cli:dm:x',
  timeoutMs: { firstToken: 5_000, total: 5_000 },
  ...over,
})

const envelope = (over: Record<string, unknown> = {}) => ({
  id: 'gen-1',
  model: MODEL,
  answers: { q1: choice() },
  usage: { input_tokens: 290, output_tokens: 9, cost: 0.00001218 },
  ...over,
})
const reply = (body: unknown = envelope(), status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-generation-id': 'gen-1', ...headers },
  })
const failureBody = (message: string) =>
  JSON.stringify({ error: { message: `${message} ${SENTINEL}`, code: 0 }, user_id: USER_ID })
const failed = (status: number, message: string, headers: Record<string, string> = {}) =>
  reply(failureBody(message), status, headers)

function harness(replies: Reply[] = [], over: { routes?: JevRoute[]; clock?: () => number } = {}) {
  const calls: Call[] = []
  const closed: string[] = []
  const log: string[] = []
  const queue = [...replies]
  const network = (decl: RouteDecl) => ({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} }
      calls.push(call)
      log.push('fetch')
      const next = queue.shift() ?? reply()
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(call) : next
    }) as typeof fetch,
    close: async () => {
      closed.push(decl.route)
    },
  })
  const adapter = new JevAdapter({
    routes: over.routes ?? [routeDecl()],
    network,
    clock: over.clock ?? (() => NOW),
  })
  adapter.bindCredential('jev', KEY)
  hookLogs.set(adapter, log)
  return { adapter, calls, closed, log, queue }
}

// The log of an adapter built by `harness` also records the three reporting hooks, so a test can see
// that a call refused before it was sent never reported anything. `run` installs the spies unless
// the test passes its own.
const hookLogs = new WeakMap<JevAdapter, string[]>()

async function run(
  adapter: JevAdapter,
  req: RequestBody = request(),
  opts: Partial<AdapterStreamOptions> = {},
  route = 'jev',
): Promise<WireEvent[]> {
  const log = hookLogs.get(adapter)
  const spies: Partial<AdapterStreamOptions> = log
    ? {
        reportSent: () => void log.push('sent'),
        reportRequest: async () => void log.push('request'),
        reportDispatch: () => void log.push('dispatch'),
      }
    : {}
  const out: WireEvent[] = []
  for await (const event of adapter.stream(route, req, options({ ...spies, ...opts }))) out.push(event)
  return out
}

const types = (events: ReadonlyArray<{ type: string }>) => events.map((e) => e.type)
const errorOf = (events: WireEvent[]) =>
  events.find((e) => e.type === 'error') as Extract<WireEvent, { type: 'error' }>
const usageOf = (events: WireEvent[]) =>
  events.find((e) => e.type === 'usage') as Extract<WireEvent, { type: 'usage' }>
const textOf = (events: ReadonlyArray<{ type: string; delta?: string }>) =>
  events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.delta)
    .join('')
const sentBody = (call: Call | undefined) => JSON.parse(String(call?.init.body)) as Record<string, unknown>
const hanging: Reply = (call) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = call.init.signal as AbortSignal
    const stop = () => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
const setupError = (make: () => unknown): AiSetupError => {
  try {
    make()
  } catch (error) {
    expect(error).toBeInstanceOf(AiSetupError)
    return error as AiSetupError
  }
  throw new Error('expected the constructor to throw')
}

describe('the request on the wire', () => {
  it('posts {model, state, questions} to <baseUrl>/systemone with a bearer key and no redirects', async () => {
    const { adapter, calls } = harness()
    await run(adapter)
    expect(calls).toHaveLength(1)
    const call = calls[0] as Call
    expect(call.url).toBe(`${BASE}/systemone`)
    expect(call.init.method).toBe('POST')
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${KEY}`)
    expect(new Headers(call.init.headers).get('content-type')).toBe('application/json')
    expect(call.init.redirect).toBe('error')
    const body = sentBody(call)
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
    expect(body).toEqual({ model: MODEL, ...PAYLOAD })
  })

  it.each([
    ['https://host.invalid/v1/', 'https://host.invalid/v1/systemone'],
    ['https://host.invalid', 'https://host.invalid/systemone'],
    ['https://host.invalid/api/v1', 'https://host.invalid/api/v1/systemone'],
    ['http://127.0.0.1:8123/v1', 'http://127.0.0.1:8123/v1/systemone'],
  ])('appends /systemone to %s', async (baseUrl, expected) => {
    const { adapter, calls } = harness([], { routes: [routeDecl({ baseUrl })] })
    await run(adapter)
    expect(calls[0]?.url).toBe(expected)
  })

  it.each([MODEL, 'jev-1.13.0', 'jev-latest', '~typesafe/jev-latest', 'Typesafe/Jev.1_13'])(
    'sends the model id %s exactly as requested',
    async (model) => {
      const { adapter, calls } = harness()
      await run(adapter, request({ model }))
      expect(sentBody(calls[0]).model).toBe(model)
    },
  )

  it('reports the sent digest, then the body, then the dispatch, and only then calls fetch', async () => {
    const { adapter, calls, log } = harness()
    const seen: { sent?: unknown; body?: unknown } = {}
    await run(adapter, request(), {
      reportSent: (report) => {
        log.push('sent')
        seen.sent = report
      },
      reportRequest: async (body) => {
        log.push('request')
        seen.body = body
      },
      reportDispatch: () => {
        log.push('dispatch')
      },
    })
    expect(log).toEqual(['sent', 'request', 'dispatch', 'fetch'])
    const text = String(calls[0]?.init.body)
    expect(seen.sent).toEqual({
      sentHash: createHash('sha256').update(text).digest('hex'),
      transforms: [{ event: 'payload_body', ext: 'typesafe-systemone' }],
    })
    expect(seen.body).toEqual(JSON.parse(text))
    expect(JSON.stringify(seen)).not.toContain(KEY)
  })

  it('still sends when the request capture hook throws', async () => {
    const { adapter, calls } = harness()
    const events = await run(adapter, request(), {
      reportRequest: async () => {
        throw new Error('capture failed')
      },
    })
    expect(calls).toHaveLength(1)
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
  })
})

describe('requests refused before any network call', () => {
  const noKey = () => {
    const built = harness()
    built.adapter.bindCredential('jev', undefined)
    return built
  }
  const cases: Array<[string, RequestOver, AiErrorCode]> = [
    ['no payload', { payload: undefined }, 'CONTRACT_MISMATCH'],
    ['a null payload', { payload: null }, 'CONTRACT_MISMATCH'],
    ['an array payload', { payload: [] }, 'CONTRACT_MISMATCH'],
    ['a string payload', { payload: 'state' }, 'CONTRACT_MISMATCH'],
    ['an extra payload key', { payload: { ...PAYLOAD, extra: 1 } }, 'CONTRACT_MISMATCH'],
    ['a payload without questions', { payload: { state: {} } }, 'CONTRACT_MISMATCH'],
    ['a payload without state', { payload: { questions: {} } }, 'CONTRACT_MISMATCH'],
    ['an undefined state', { payload: { state: undefined, questions: {} } as never }, 'CONTRACT_MISMATCH'],
    ['array questions', { payload: { state: {}, questions: [] } }, 'CONTRACT_MISMATCH'],
    ['null questions', { payload: { state: {}, questions: null } }, 'CONTRACT_MISMATCH'],
    ['string questions', { payload: { state: {}, questions: 'q' } }, 'CONTRACT_MISMATCH'],
    [
      'tools',
      { tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] as never },
      'CONTRACT_MISMATCH',
    ],
    [
      'messages',
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      'CONTRACT_MISMATCH',
    ],
    ['a system prompt', { system: 'be helpful' }, 'CONTRACT_MISMATCH'],
  ]
  it.each(cases)('rejects %s', async (_name, over, code) => {
    const { adapter, calls, log } = harness()
    const events = await run(adapter, request(over))
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ reason: 'error', code, retryable: false })
    expect(calls).toHaveLength(0)
    expect(log).toEqual([])
  })

  it('rejects a call with no bound credential as AUTH', async () => {
    const { adapter, calls, log } = noKey()
    const events = await run(adapter)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'AUTH', retryable: false })
    expect(calls).toHaveLength(0)
    expect(log).toEqual([])
  })

  it('does not send a blank credential', async () => {
    const { adapter, calls, log } = harness()
    adapter.bindCredential('jev', '   ')
    const events = await run(adapter)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'AUTH', retryable: false })
    expect(calls).toHaveLength(0)
    expect(log).toEqual([])
  })

  it('rejects an unknown route as NO_ADAPTER', async () => {
    const { adapter, calls, log } = harness()
    const events = await run(adapter, request(), {}, 'ghost')
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'NO_ADAPTER', retryable: false })
    expect(calls).toHaveLength(0)
    expect(log).toEqual([])
  })

  it('rejects a call on a disposed instance as NO_ADAPTER', async () => {
    const { adapter, calls, log } = harness()
    await adapter.dispose()
    const events = await run(adapter)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'NO_ADAPTER', retryable: false })
    expect(calls).toHaveLength(0)
    expect(log).toEqual([])
  })

  it('rejects a call whose signal is already aborted without dispatching it', async () => {
    const { adapter, calls, log } = harness()
    const controller = new AbortController()
    controller.abort()
    const events = await run(adapter, request(), { signal: controller.signal })
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ reason: 'aborted', code: 'ABORTED', retryable: false })
    expect(calls).toHaveLength(0)
    expect(log).toEqual([])
  })

  it.each([
    ['the caller cancels', { kind: 'caller' }, { reason: 'aborted', code: 'ABORTED', retryable: false }],
    [
      'the instance is disposed',
      { kind: 'dispose' },
      { reason: 'aborted', code: 'ABORTED', retryable: false },
    ],
    [
      'the call time limit runs out',
      { kind: 'limit' },
      { reason: 'error', code: 'TIMEOUT', retryable: true },
    ],
  ] as const)(
    'does not dispatch or report a dispatch when %s while the request capture is still running',
    async (_name, how, expected) => {
      const { adapter, calls, log } = harness()
      const controller = new AbortController()
      const slowCapture = async () => {
        log.push('request')
        if (how.kind === 'caller') setTimeout(() => controller.abort(), 5)
        else if (how.kind === 'dispose') setTimeout(() => void adapter.dispose(), 5)
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      const events = await run(adapter, request(), {
        signal: controller.signal,
        timeoutMs:
          how.kind === 'limit' ? { firstToken: 10, total: 10 } : { firstToken: 60_000, total: 60_000 },
        reportRequest: slowCapture,
      })
      expect(types(events)).toEqual(['error'])
      expect(errorOf(events)).toMatchObject(expected)
      expect(calls).toHaveLength(0)
      expect(log).toEqual(['sent', 'request'])
    },
  )

  it('never puts the credential in a refusal', async () => {
    const { adapter } = harness()
    const events = await run(adapter, request({ payload: undefined }))
    expect(JSON.stringify(events)).not.toContain(KEY)
  })
})

describe('the vendor rules are not enforced here', () => {
  const many = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [`q${i}`, { type: 'choice', criteria: { a: 'A', b: 'B' } }]),
  )
  const odd = {
    '': { type: 'choice', criteria: { '': 'empty', [`k${'x'.repeat(509)}`]: 'long' } },
    'Q.Upper.dotted': { type: 'choice', criteria: { '\u{1F600}': 'emoji', 'A.B': 'dotted' } },
  }
  it.each([
    ['1000 questions', { state: {}, questions: many }],
    ['empty and 512-character option keys, emoji, dotted ids', { state: {}, questions: odd }],
    ['a string state', { state: 'free text', questions: {} }],
    ['an array state', { state: [1, 'two', null], questions: {} }],
    ['a null state', { state: null, questions: {} }],
    ['no questions at all', { state: {}, questions: {} }],
  ])('sends %s unchanged', async (_name, payload) => {
    const { adapter, calls } = harness()
    const events = await run(adapter, request({ payload }))
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
    expect(sentBody(calls[0])).toEqual({ model: MODEL, ...payload })
  })
})

describe('the answers', () => {
  it('hands back whatever the vendor answered, as JSON text', async () => {
    const answers = {
      q1: choice({ a: 0.9, b: 0.9 }),
      extra: { type: 'noul', noul: 0.4, surprise: [1, 2] },
    }
    const { adapter } = harness([reply(envelope({ answers }))])
    const events = await run(adapter)
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
    expect(JSON.parse(textOf(events))).toEqual(answers)
  })

  it('passes an empty answer set through', async () => {
    const { adapter } = harness([reply(envelope({ answers: {} }))])
    expect(textOf(await run(adapter))).toBe('{}')
  })

  it('carries only the answers, not the model name', async () => {
    const { adapter } = harness()
    const text = textOf(await run(adapter))
    expect(Object.keys(JSON.parse(text))).toEqual(['q1'])
  })

  it('writes every < as an escape so no tag-shaped text reaches the decoder', async () => {
    const answers = {
      q1: { ...choice(), legend: { '0': '<think>x</think>', '<k>': '<tool_call>' } },
    }
    const { adapter } = harness([reply(envelope({ answers }))])
    const text = textOf(await run(adapter))
    expect(text).not.toContain('<')
    expect(text).toContain('\\u003cthink>')
    expect(JSON.parse(text)).toEqual(answers)
  })

  describe('through the provider facade', () => {
    const answersWithTags = {
      q1: { ...choice(), legend: { '0': '<think>x</think> and <function=f>y</function>' } },
    }
    const facade = (replies: Reply[]) => {
      const built = harness(replies)
      const provider = createProvider({
        adapters: [built.adapter],
        routes: { primary: { route: 'jev', model: MODEL } },
        contract: new NullContractStore(),
        secrets: () => KEY,
        clock: () => 1000,
        pricing: { creditsPerUsd: 100 },
      })
      return { ...built, provider }
    }
    const infer = async (provider: ReturnType<typeof facade>['provider'], req = request()) => {
      const out: InferenceEvent[] = []
      for await (const e of provider.infer(req, { signal: new AbortController().signal, toolNames: [] }))
        out.push(e)
      return out
    }

    it('passes the payload gate and yields sent, text_delta, usage, done', async () => {
      const { provider, calls } = facade([reply()])
      const events = await infer(provider)
      expect(types(events)).toEqual(['sent', 'text_delta', 'usage', 'done'])
      expect(sentBody(calls[0])).toEqual({ model: MODEL, ...PAYLOAD })
      const stamp = (events[0] as Extract<InferenceEvent, { type: 'sent' }>).stamp
      expect(stamp.sent_hash).toBe(createHash('sha256').update(String(calls[0]?.init.body)).digest('hex'))
      expect(stamp.transforms).toEqual([{ event: 'payload_body', ext: 'typesafe-systemone' }])
    })

    it('keeps tag-shaped answer text as plain text', async () => {
      const { provider } = facade([reply(envelope({ answers: answersWithTags }))])
      const events = await infer(provider)
      expect(events.some((e) => e.type === 'thinking_delta' || e.type === 'toolcall_end')).toBe(false)
      expect(JSON.parse(textOf(events))).toEqual(answersWithTags)
    })

    it('returns the same text when the first question id is "name"', async () => {
      const answers = { name: choice(), other: choice() }
      const direct = textOf(await run(harness([reply(envelope({ answers }))]).adapter))
      const { provider } = facade([reply(envelope({ answers }))])
      const viaFacade = textOf(await infer(provider))
      expect(viaFacade).toBe(direct)
      expect(JSON.parse(viaFacade)).toEqual(answers)
    })

    it('converts the gateway price into credits with the deployment rate', async () => {
      const { provider } = facade([reply()])
      const usage = (await infer(provider)).find((e) => e.type === 'usage')
      expect(usage).toMatchObject({
        billing: { usdMicros: 12, source: 'gateway', subscription: false },
        credits: 0.0012,
        creditSource: 'gateway',
      })
    })

    it('estimates from the catalogue price when the vendor reports no cost', async () => {
      const route = routeDecl({
        models: [
          fakeModel({
            id: MODEL,
            route: 'jev',
            api: JEV_WIRE_API,
            baseUrl: BASE,
            cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
          }),
        ],
      })
      const built = harness([reply(envelope({ usage: { input_tokens: 5290, output_tokens: 40 } }))], {
        routes: [route],
      })
      const provider = createProvider({
        adapters: [built.adapter],
        routes: { primary: { route: 'jev', model: MODEL } },
        contract: new NullContractStore(),
        secrets: () => KEY,
        clock: () => 1000,
        pricing: { creditsPerUsd: 100 },
      })
      const usage = (await infer(provider)).find((e) => e.type === 'usage')
      expect(usage).toMatchObject({
        billing: { usdMicros: 222, source: 'estimated', subscription: false },
        creditSource: 'estimated',
      })
    })

    it('refuses an ordinary chat request for this route without sending anything', async () => {
      const { provider, calls } = facade([])
      const events = await infer(
        provider,
        request({
          payload: undefined,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        }),
      )
      expect(types(events)).toEqual(['sent', 'error'])
      expect(events[1]).toMatchObject({ code: 'CONTRACT_MISMATCH', retryable: false })
      expect(calls).toHaveLength(0)
    })

    it('records a refused request as a known zero spend, then the failure', async () => {
      const { provider } = facade([failed(400, 'bad request')])
      const events = await infer(provider)
      expect(types(events)).toEqual(['sent', 'usage', 'error'])
      expect(events[1]).toMatchObject({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        credits: 0,
        creditSource: 'gateway',
        billing: { usdMicros: 0, source: 'gateway', subscription: false },
      })
      expect(events[2]).toMatchObject({ code: 'CONTRACT_MISMATCH', retryable: false })
    })

    it('leaves a rate limit with no usage and passes the vendor wait through', async () => {
      const { provider, calls } = facade([failed(529, 'busy', { 'retry-after': '0.25' }), reply()])
      const events = await infer(provider)
      expect(types(events)).toEqual(['sent', 'error'])
      expect(events[1]).toMatchObject({ code: 'RATE_LIMIT', retryable: true, retryAfterMs: 250 })
      expect(calls).toHaveLength(1)
    })
  })
})

describe('usage and response metadata', () => {
  it('maps tokens and the vendor price into a gateway billing', async () => {
    const { adapter } = harness([
      reply(envelope({ usage: { input_tokens: 5290, output_tokens: 40, cost: 0.00022218 } })),
    ])
    const usage = usageOf(await run(adapter))
    expect(usage).toEqual({
      type: 'usage',
      tokens: { input: 5290, output: 40, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'estimated',
      billing: { usdMicros: 222, source: 'gateway', subscription: false },
      response: { status: 200, id: 'gen-1', model: MODEL },
    })
    expect(usage).not.toHaveProperty('credits')
  })

  it('rounds a price in dollars to whole micro-dollars', async () => {
    const { adapter } = harness([
      reply(envelope({ usage: { input_tokens: 290, output_tokens: 0, cost: 12.18e-6 } })),
    ])
    expect(usageOf(await run(adapter)).billing?.usdMicros).toBe(12)
  })

  it('reports a zero price as a zero billing', async () => {
    const { adapter } = harness([reply(envelope({ usage: { input_tokens: 0, output_tokens: 0, cost: 0 } }))])
    expect(usageOf(await run(adapter)).billing).toEqual({
      usdMicros: 0,
      source: 'gateway',
      subscription: false,
    })
  })

  it.each([
    ['absent', undefined],
    ['negative', -0.5],
    ['a string', '0.5'],
    ['null', null],
    ['an object', {}],
  ])('reports no billing when the cost is %s', async (_name, cost) => {
    const usage = { input_tokens: 10, output_tokens: 1, ...(cost === undefined ? {} : { cost }) }
    const { adapter } = harness([reply(envelope({ usage }))])
    const events = await run(adapter)
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
    expect(usageOf(events)).not.toHaveProperty('billing')
  })

  it('reports no billing when the cost is not a finite number', async () => {
    const text = `{"id":"g","model":"${MODEL}","answers":{},"usage":{"input_tokens":1,"output_tokens":1,"cost":1e999}}`
    const { adapter } = harness([reply(text)])
    expect(usageOf(await run(adapter))).not.toHaveProperty('billing')
  })

  it('takes the response id from the body, else from the generation header', async () => {
    const withBody = harness([reply(envelope({ id: 'body-id' }), 200, { 'x-generation-id': 'header-id' })])
    expect(usageOf(await run(withBody.adapter)).response).toEqual({
      status: 200,
      id: 'body-id',
      model: MODEL,
    })
    const headerOnly = harness([reply(envelope({ id: undefined }), 200, { 'x-generation-id': 'header-id' })])
    expect(usageOf(await run(headerOnly.adapter)).response?.id).toBe('header-id')
  })

  it.each([
    ['no id anywhere', envelope({ id: undefined }), {}],
    [
      'an id that is too long and a header with spaces',
      envelope({ id: 'x'.repeat(129) }),
      { 'x-generation-id': 'has spaces' },
    ],
    ['an empty id', envelope({ id: '' }), { 'x-generation-id': '' }],
  ])('omits the response id for %s', async (_name, body, headers) => {
    const response = new Response(JSON.stringify(body), { status: 200, headers })
    const { adapter } = harness([response])
    expect(usageOf(await run(adapter)).response).toEqual({ status: 200, model: MODEL })
  })

  it('keeps the dated model the vendor resolved to', async () => {
    const { adapter } = harness([reply(envelope({ model: 'typesafe/jev-1.13-20260917' }))])
    expect(usageOf(await run(adapter)).response?.model).toBe('typesafe/jev-1.13-20260917')
  })
})

describe('failures reported by the vendor', () => {
  const zeroUsage = (status: number, id?: string) => ({
    type: 'usage',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    creditSource: 'estimated',
    billing: { usdMicros: 0, source: 'gateway', subscription: false },
    response: { status, ...(id ? { id } : {}) },
  })
  const rows: Array<{
    name: string
    status: number
    text: string
    code: AiErrorCode
    retryable: boolean
    zero: boolean
    message: string
  }> = [
    {
      name: '400 with max_tokens_exceeded',
      status: 400,
      text: 'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}',
      code: 'OVERFLOW',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone OVERFLOW (HTTP 400) max_tokens_exceeded',
    },
    {
      name: '400 for a model that does not exist',
      status: 400,
      text: `Model ${MODEL} does not exist`,
      code: 'NO_MODEL',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone NO_MODEL (HTTP 400) model_not_found',
    },
    {
      name: 'any other 400',
      status: 400,
      text: '[{"type":"missing","loc":["body","questions"],"msg":"Field required"}]',
      code: 'CONTRACT_MISMATCH',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone CONTRACT_MISMATCH (HTTP 400)',
    },
    {
      name: '422',
      status: 422,
      text: 'validation error',
      code: 'CONTRACT_MISMATCH',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone CONTRACT_MISMATCH (HTTP 422)',
    },
    {
      name: '401',
      status: 401,
      text: 'User not found.',
      code: 'AUTH',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone AUTH (HTTP 401)',
    },
    {
      name: '403',
      status: 403,
      text: 'forbidden',
      code: 'AUTH',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone AUTH (HTTP 403)',
    },
    {
      name: '402',
      status: 402,
      text: 'insufficient credits',
      code: 'QUOTA',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone QUOTA (HTTP 402)',
    },
    {
      name: '404',
      status: 404,
      text: 'not found',
      code: 'CONTRACT_MISMATCH',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone CONTRACT_MISMATCH (HTTP 404)',
    },
    {
      name: '413',
      status: 413,
      text: 'too large',
      code: 'CONTRACT_MISMATCH',
      retryable: false,
      zero: true,
      message: 'typesafe-systemone CONTRACT_MISMATCH (HTTP 413)',
    },
    {
      name: '429',
      status: 429,
      text: 'slow down',
      code: 'RATE_LIMIT',
      retryable: true,
      zero: true,
      message: 'typesafe-systemone RATE_LIMIT (HTTP 429)',
    },
    {
      name: '529',
      status: 529,
      text: 'overloaded',
      code: 'RATE_LIMIT',
      retryable: true,
      zero: false,
      message: 'typesafe-systemone RATE_LIMIT (HTTP 529)',
    },
    {
      name: '500',
      status: 500,
      text: 'boom',
      code: 'TRANSPORT',
      retryable: true,
      zero: false,
      message: 'typesafe-systemone TRANSPORT (HTTP 500)',
    },
    {
      name: '502',
      status: 502,
      text: 'bad gateway',
      code: 'TRANSPORT',
      retryable: true,
      zero: false,
      message: 'typesafe-systemone TRANSPORT (HTTP 502)',
    },
    {
      name: '503',
      status: 503,
      text: 'unavailable',
      code: 'TRANSPORT',
      retryable: true,
      zero: false,
      message: 'typesafe-systemone TRANSPORT (HTTP 503)',
    },
  ]

  it.each(rows)('$name maps to $code', async (row) => {
    const { adapter, calls } = harness([failed(row.status, row.text, { 'x-generation-id': 'gen-err-1' })])
    const events = await run(adapter)
    expect(calls).toHaveLength(1)
    expect(types(events)).toEqual(row.zero ? ['usage', 'error'] : ['error'])
    if (row.zero) expect(events[0]).toEqual(zeroUsage(row.status, 'gen-err-1'))
    const error = errorOf(events)
    expect(error).toMatchObject({
      reason: 'error',
      code: row.code,
      retryable: row.retryable,
      message: row.message,
      requestId: 'gen-err-1',
    })
    const everything = JSON.stringify(events)
    for (const secret of [KEY, USER_ID, SENTINEL, MODEL]) expect(everything).not.toContain(secret)
  })

  it('maps a thrown fetch to a retryable TRANSPORT without a usage event', async () => {
    const { adapter } = harness([new TypeError(`fetch failed for ${KEY} ${SENTINEL}`)])
    const events = await run(adapter)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({
      reason: 'error',
      code: 'TRANSPORT',
      retryable: true,
      message: 'typesafe-systemone TRANSPORT',
    })
    expect(JSON.stringify(events)).not.toMatch(/SENTINEL|TEST-KEY/)
  })

  it('treats a redirect status that slips through as a retryable TRANSPORT', async () => {
    const { adapter } = harness([new Response(null, { status: 307 })])
    const events = await run(adapter)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'TRANSPORT', retryable: true })
  })

  it('omits requestId when the generation header is not an id', async () => {
    const { adapter } = harness([failed(500, 'boom', { 'x-generation-id': 'not an id!' })])
    expect(errorOf(await run(adapter))).not.toHaveProperty('requestId')
  })

  it('classifies only on the first 16 KiB of an error body', async () => {
    const padding = 'x'.repeat(20_000)
    const late = new Response(`${padding} max_tokens_exceeded`, { status: 400 })
    const early = new Response(`max_tokens_exceeded ${padding}`, { status: 400 })
    const { adapter } = harness([late, early])
    expect(errorOf(await run(adapter))).toMatchObject({ code: 'CONTRACT_MISMATCH' })
    expect(errorOf(await run(adapter))).toMatchObject({ code: 'OVERFLOW' })
  })

  it('still classifies by status when the error body cannot be read', async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('socket reset'))
        },
      }),
      { status: 401 },
    )
    const { adapter } = harness([broken])
    const events = await run(adapter)
    expect(types(events)).toEqual(['usage', 'error'])
    expect(errorOf(events)).toMatchObject({ code: 'AUTH' })
  })
})

describe('a rate limit is reported once and never retried', () => {
  it.each([429, 529])('sends one request for a %i, whatever the retry option says', async (status) => {
    for (const retry of [undefined, false] as const) {
      const { adapter, calls, queue } = harness([failed(status, 'busy', { 'retry-after': '1' }), reply()])
      const events = await run(adapter, request(), retry === undefined ? {} : { retry })
      expect(calls).toHaveLength(1)
      expect(queue).toHaveLength(1)
      expect(errorOf(events)).toMatchObject({ code: 'RATE_LIMIT', retryable: true })
    }
  })

  it.each([
    ['0.25', 250],
    ['3', 3_000],
    ['0', 0],
    ['1.5', 1_500],
  ])('reads retry-after: %s as %i ms', async (value, expected) => {
    const { adapter } = harness([failed(429, 'busy', { 'retry-after': value })])
    expect(errorOf(await run(adapter))).toMatchObject({ retryAfterMs: expected })
  })

  it('reads an HTTP date as the distance from now', async () => {
    const future = new Date(NOW + 7_000).toUTCString()
    const past = new Date(NOW - 7_000).toUTCString()
    const { adapter } = harness([
      failed(529, 'busy', { 'retry-after': future }),
      failed(529, 'busy', { 'retry-after': past }),
    ])
    expect(errorOf(await run(adapter))).toMatchObject({ retryAfterMs: 7_000 })
    expect(errorOf(await run(adapter))).toMatchObject({ retryAfterMs: 0 })
  })

  it.each([
    ['missing', undefined],
    ['garbage', 'soon-ish'],
    ['negative', '-4'],
    ['empty', ''],
    ['huge', '9'.repeat(30)],
  ])('carries no retryAfterMs when the header is %s', async (_name, value) => {
    const { adapter } = harness([failed(429, 'busy', value === undefined ? {} : { 'retry-after': value })])
    const error = errorOf(await run(adapter))
    expect(error).toMatchObject({ code: 'RATE_LIMIT', retryable: true })
    expect(error).not.toHaveProperty('retryAfterMs')
  })

  it('ignores retry-after on other failures', async () => {
    const { adapter } = harness([failed(503, 'down', { 'retry-after': '5' })])
    expect(errorOf(await run(adapter))).not.toHaveProperty('retryAfterMs')
  })

  it('does not retry any other failure either', async () => {
    for (const status of [500, 502, 503, 400, 401]) {
      const { adapter, calls } = harness([failed(status, 'nope'), reply()])
      await run(adapter)
      expect(calls).toHaveLength(1)
    }
    const thrown = harness([new TypeError('reset'), reply()])
    await run(thrown.adapter)
    expect(thrown.calls).toHaveLength(1)
  })
})

describe('a reply that is not usable', () => {
  const formatCases: Array<[string, () => Response]> = [
    ['not JSON', () => reply('<html>gateway page</html>')],
    ['an empty body', () => reply('')],
    ['a JSON array', () => reply('[]')],
    ['a JSON string', () => reply('"ok"')],
    ['no model', () => reply(envelope({ model: undefined }))],
    ['an empty model', () => reply(envelope({ model: '' }))],
    ['a model over 256 characters', () => reply(envelope({ model: 'm'.repeat(257) }))],
    ['a non-string model', () => reply(envelope({ model: 7 }))],
    ['answers that are an array', () => reply(envelope({ answers: [] }))],
    ['no answers', () => reply(envelope({ answers: undefined }))],
    ['an answer that is not an object', () => reply(envelope({ answers: { q1: 'a' } }))],
    ['an answer that is null', () => reply(envelope({ answers: { q1: null } }))],
    ['no usage', () => reply(envelope({ usage: undefined }))],
    ['negative input tokens', () => reply(envelope({ usage: { input_tokens: -1, output_tokens: 0 } }))],
    ['fractional output tokens', () => reply(envelope({ usage: { input_tokens: 1, output_tokens: 0.5 } }))],
    ['string tokens', () => reply(envelope({ usage: { input_tokens: '1', output_tokens: 0 } }))],
    ['missing output tokens', () => reply(envelope({ usage: { input_tokens: 1 } }))],
    ['non-UTF-8 bytes', () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200 })],
  ]
  it.each(formatCases)('is FORMAT for %s', async (_name, make) => {
    const { adapter } = harness([make()])
    const events = await run(adapter)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({
      reason: 'error',
      code: 'FORMAT',
      retryable: false,
      message: 'typesafe-systemone FORMAT',
    })
  })

  it('is FORMAT when the declared length is over 1 MiB, without reading the body', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(body, {
      status: 200,
      headers: { 'content-length': String(2 * 1024 * 1024) },
    })
    const { adapter } = harness([response])
    expect(errorOf(await run(adapter))).toMatchObject({ code: 'FORMAT' })
    expect(cancelled).toBe(true)
  })

  it('is FORMAT when a body of unknown length runs past 1 MiB, and stops reading', async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(256 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const { adapter } = harness([new Response(body, { status: 200 })])
    expect(errorOf(await run(adapter))).toMatchObject({ code: 'FORMAT' })
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
  })

  it('accepts a body of exactly 1 MiB', async () => {
    const head = `{"model":"${MODEL}","usage":{"input_tokens":1,"output_tokens":1},"answers":{"q":{"pad":"`
    const tail = '"}}}'
    const pad = 'a'.repeat(1024 * 1024 - head.length - tail.length)
    const { adapter } = harness([reply(head + pad + tail)])
    expect(types(await run(adapter))).toEqual(['text_delta', 'usage', 'done'])
  })
})

describe('cancellation and time limits', () => {
  it('reports the caller cancelling as ABORTED', async () => {
    const { adapter } = harness([hanging])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 15)
    const events = await run(adapter, request(), { signal: controller.signal })
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({
      reason: 'aborted',
      code: 'ABORTED',
      retryable: false,
      message: 'typesafe-systemone ABORTED',
    })
  })

  it('reports the caller cancelling while the body is still arriving as ABORTED', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
    })
    const { adapter } = harness([new Response(body, { status: 200 })])
    setTimeout(() => controller.abort(), 15)
    const events = await run(adapter, request(), { signal: controller.signal })
    expect(errorOf(events)).toMatchObject({ reason: 'aborted', code: 'ABORTED' })
  })

  it.each([[{ firstToken: 25, total: 600_000 }], [{ firstToken: 600_000, total: 25 }]])(
    'reports its own time limit %j as a retryable TIMEOUT',
    async (timeoutMs) => {
      const { adapter } = harness([hanging])
      const events = await run(adapter, request(), { timeoutMs })
      expect(types(events)).toEqual(['error'])
      expect(errorOf(events)).toMatchObject({
        reason: 'error',
        code: 'TIMEOUT',
        retryable: true,
        message: 'typesafe-systemone TIMEOUT',
      })
    },
  )

  it('ends an in-flight call as ABORTED when the instance is disposed', async () => {
    const { adapter, closed } = harness([hanging])
    // A generous limit, so only the dispose can end the call within the test's own time budget.
    const pending = run(adapter, request(), { timeoutMs: { firstToken: 60_000, total: 60_000 } })
    await new Promise((resolve) => setTimeout(resolve, 15))
    await adapter.dispose()
    const events = await pending
    expect(errorOf(events)).toMatchObject({ code: 'ABORTED', retryable: false })
    expect(closed).toEqual(['jev'])
  })
})

describe('assembly', () => {
  it('identifies itself and declares that it reads a payload', () => {
    const { adapter } = harness()
    expect(adapter.id).toBe('typesafe-systemone')
    expect(JEV_WIRE_API).toBe('typesafe-systemone')
    expect(adapter.version).toBe('1.0.0')
    expect(adapter.acceptsPayload).toBe(true)
  })

  it('lists its routes without models or keyless, and hands out copies of the catalogue', () => {
    const { adapter } = harness([], { routes: [routeDecl({ keyless: true })] })
    const [decl] = adapter.routes()
    expect(decl).toEqual({
      route: 'jev',
      api: JEV_WIRE_API,
      baseUrl: BASE,
      credentialRef: 'secret://jev/key',
    })
    const models = adapter.models('jev')
    expect(models.map((m) => m.id)).toEqual([MODEL])
    models.length = 0
    ;(adapter.models('jev')[0] as ModelRecord).id = 'tampered'
    expect(adapter.models('jev').map((m) => m.id)).toEqual([MODEL])
    expect(adapter.models('ghost')).toEqual([])
  })

  it.each([
    ['http://127.0.0.1:9/v1'],
    ['http://127.8.9.10/v1'],
    ['http://[::1]:9/v1'],
    ['http://localhost:9/v1'],
    ['https://api.typesafe.ai/v1'],
    ['https://openrouter.ai/api/v1'],
  ])('accepts the base URL %s', (baseUrl) => {
    expect(() => harness([], { routes: [routeDecl({ baseUrl })] })).not.toThrow()
    expect(() => validateModelBaseUrl(routeDecl({ baseUrl }))).not.toThrow()
  })

  const rejected: Array<[string, () => JevRoute[], string]> = [
    ['a route for another api', () => [routeDecl({ api: 'openai-completions' })], 'NO_ADAPTER'],
    ['a relative base URL', () => [routeDecl({ baseUrl: '/v1' })], 'INVALID_BASE_URL'],
    ['an empty base URL', () => [routeDecl({ baseUrl: '' })], 'INVALID_BASE_URL'],
    [
      'a base URL that is not http or https',
      () => [routeDecl({ baseUrl: 'ftp://host.invalid/v1' })],
      'INVALID_BASE_URL',
    ],
    [
      'userinfo in the base URL',
      () => [routeDecl({ baseUrl: `https://user:${SENTINEL}@host.invalid/v1` })],
      'INVALID_BASE_URL',
    ],
    [
      'a query in the base URL',
      () => [routeDecl({ baseUrl: `https://host.invalid/v1?token=${SENTINEL}` })],
      'INVALID_BASE_URL',
    ],
    [
      'a fragment in the base URL',
      () => [routeDecl({ baseUrl: 'https://host.invalid/v1#x' })],
      'INVALID_BASE_URL',
    ],
    [
      'a template in the path',
      () => [routeDecl({ baseUrl: 'https://host.invalid/{region}/v1' })],
      'INVALID_BASE_URL',
    ],
    [
      'a template in the host',
      () => [routeDecl({ baseUrl: 'https://{region}.host.invalid/v1' })],
      'INVALID_BASE_URL',
    ],
    [
      'an encoded template in the host',
      () => [routeDecl({ baseUrl: 'https://%7Bregion%7D.host.invalid/v1' })],
      'INVALID_BASE_URL',
    ],
    [
      'plain http to a remote host',
      () => [routeDecl({ baseUrl: 'http://api.typesafe.ai/v1' })],
      'INVALID_BASE_URL',
    ],
    [
      'plain http to a private address',
      () => [routeDecl({ baseUrl: 'http://10.0.0.5/v1' })],
      'INVALID_BASE_URL',
    ],
    [
      'plain http to a loopback lookalike',
      () => [routeDecl({ baseUrl: 'http://127.0.0.1.example.invalid/v1' })],
      'INVALID_BASE_URL',
    ],
    ['the same route twice', () => [routeDecl(), routeDecl()], 'DUPLICATE_ROUTE'],
    [
      'a model recorded under another route',
      () => [routeDecl({ models: [fakeModel({ id: MODEL, route: 'other', api: JEV_WIRE_API })] })],
      'CONTRACT_MISMATCH',
    ],
    [
      'a model recorded for another api',
      () => [routeDecl({ models: [fakeModel({ id: MODEL, route: 'jev', api: 'openai-completions' })] })],
      'CONTRACT_MISMATCH',
    ],
    [
      'a model with a contract',
      () => [
        routeDecl({ models: [fakeModel({ id: MODEL, route: 'jev', api: JEV_WIRE_API, contract_id: 'c1' })] }),
      ],
      'CONTRACT_MISMATCH',
    ],
  ]
  it.each(rejected)('refuses %s', (_name, routes, code) => {
    const error = setupError(() => harness([], { routes: routes() }))
    expect(error.code).toBe(code)
    if (code === 'INVALID_BASE_URL')
      expect(() => validateModelBaseUrl(routes()[0] as JevRoute)).toThrow(/INVALID_BASE_URL/)
    expect(error.message).not.toContain(SENTINEL)
    expect(error.message).not.toContain('host.invalid')
  })

  it('opens no network for a set of routes it refuses', () => {
    const opened: string[] = []
    const network = (decl: RouteDecl) => {
      opened.push(decl.route)
      return { fetch: fetch as typeof globalThis.fetch, close: async () => {} }
    }
    setupError(
      () =>
        new JevAdapter({
          routes: [
            routeDecl({ route: 'one', models: [fakeModel({ id: MODEL, route: 'one', api: JEV_WIRE_API })] }),
            routeDecl({ route: 'two', api: 'openai-completions' }),
          ],
          network,
        }),
    )
    expect(opened).toEqual([])
  })

  it('serves each route through its own pool', async () => {
    const closed: string[] = []
    const urls: string[] = []
    const network = (decl: RouteDecl) => ({
      fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return reply()
      }) as typeof fetch,
      close: async () => void closed.push(decl.route),
    })
    const adapter = new JevAdapter({
      routes: [
        routeDecl({
          route: 'one',
          baseUrl: 'https://one.invalid/v1',
          models: [fakeModel({ id: MODEL, route: 'one', api: JEV_WIRE_API })],
        }),
        routeDecl({
          route: 'two',
          baseUrl: 'https://two.invalid/v1',
          models: [fakeModel({ id: MODEL, route: 'two', api: JEV_WIRE_API })],
        }),
      ],
      network,
    })
    adapter.bindCredential('one', KEY)
    adapter.bindCredential('two', KEY)
    await run(adapter, request({ route: 'one' }), {}, 'one')
    await run(adapter, request({ route: 'two' }), {}, 'two')
    expect(urls).toEqual(['https://one.invalid/v1/systemone', 'https://two.invalid/v1/systemone'])
    await adapter.dispose()
    expect(closed.sort()).toEqual(['one', 'two'])
  })

  it('closes every pool once on dispose, however often it is called', async () => {
    const { adapter, closed } = harness()
    await Promise.all([adapter.dispose(), adapter.dispose()])
    await adapter.dispose()
    expect(closed).toEqual(['jev'])
  })
})
