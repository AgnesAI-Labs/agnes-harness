import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DecisionModelRecord, DecisionWireRequest, RouteDecl } from '@agnes/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DecisionAdapterError } from '../src/adapter.js'
import { JevDecisionAdapter } from '../src/adapters/jev/index.js'
import { TYPESAFE_CREDENTIAL_REF } from '../src/adapters/pi/api-key-providers.js'
import { NullContractStore } from '../src/contract-store.js'
import { AiSetupError } from '../src/errors.js'
import { createProvider } from '../src/provider.js'
import { assertLoopbackOnly, installLoopbackOnly, restoreLoopbackOnly } from './loopback-only.js'

const KEY = 'ts-test-key'
const jev = (route: string, id: string, api: string, baseUrl: string): DecisionModelRecord => ({
  id,
  name: id,
  api,
  route,
  baseUrl,
  kind: 'decision',
  contextWindow: 64000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
})
const DIRECT: RouteDecl = {
  route: 'jev',
  api: 'typesafe-systemone',
  baseUrl: 'https://api.typesafe.ai/v1',
  credentialRef: TYPESAFE_CREDENTIAL_REF,
  models: [jev('jev', 'jev-1.13.0', 'typesafe-systemone', 'https://api.typesafe.ai/v1')],
}
const RESOLD: RouteDecl = {
  route: 'jev-openrouter',
  api: 'openrouter-decisions',
  baseUrl: 'https://openrouter.ai/api/alpha',
  credentialRef: 'secret://openrouter/default',
  models: [
    jev('jev-openrouter', 'typesafe/jev-1.13', 'openrouter-decisions', 'https://openrouter.ai/api/alpha'),
  ],
}
const QUESTIONS: DecisionWireRequest['questions'] = {
  done: { type: 'noul', instructions: 'Is the task finished?' },
  risky: {
    type: 'noul',
    instructions: 'Is the next edit risky?',
    criteria: { true: 'touches shared state', false: 'local' },
  },
  action: {
    type: 'choice',
    instructions: 'Next action',
    criteria: { infer: 'keep going', compact: null, stop: 'finish' },
  },
  effort: { type: 'score', instructions: 'Remaining effort', criteria: ['none', 'some', 'a lot'] },
}
const REQUEST: DecisionWireRequest = {
  slot: 'decision',
  route: 'jev',
  model: 'jev-1.13.0',
  state: { tree: 'clean', tests: 'green' },
  questions: QUESTIONS,
  timeoutMs: 1000,
}
const ANSWERS = {
  done: { type: 'noul', noul: 0.12 },
  risky: { type: 'noul', noul: 0.91 },
  action: {
    type: 'choice',
    choice: 'infer',
    probabilities: { infer: 0.7, compact: 0.2, stop: 0.1 },
    confidence: 0.83,
  },
  effort: {
    type: 'score',
    score: 1.5,
    legend: { '0': 'none', '1': 'some', '2': 'a lot' },
    probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
    confidence: 0.64,
  },
}
const SUCCESS = { model: 'jev-1.13.0', answers: ANSWERS, usage: { input_tokens: 1234, output_tokens: 9 } }

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

// A whole second, so an HTTP date (which has no milliseconds) built from START + n ms is exact.
const START = Date.parse('2026-09-26T00:00:00Z')

function harness(responses: Array<Response | Error>) {
  let now = START
  const calls: Array<{ url: string; init: RequestInit }> = []
  const slept: number[] = []
  const warnings: Array<{ message: string; detail?: Record<string, unknown> }> = []
  const adapter = new JevDecisionAdapter({
    routes: [DIRECT, RESOLD],
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} })
      const next = responses.shift()
      if (!next) throw new Error('no scripted response')
      if (next instanceof Error) throw next
      return next
    },
    sleep: async (ms) => {
      slept.push(ms)
      now += ms
    },
    clock: () => now,
    log: { warn: (message, detail) => warnings.push({ message, ...(detail ? { detail } : {}) }) },
  })
  adapter.bindCredential('jev', KEY)
  adapter.bindCredential('jev-openrouter', KEY)
  const decide = (
    route = 'jev',
    over: Partial<DecisionWireRequest> = {},
    signal = new AbortController().signal,
  ) =>
    adapter.decide(
      route,
      { ...REQUEST, ...over, route, model: route === 'jev' ? 'jev-1.13.0' : 'typesafe/jev-1.13' },
      { signal },
    )
  return { adapter, calls, slept, warnings, decide, clock: () => now }
}
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(DecisionAdapterError)
    return (e as DecisionAdapterError).code
  }
  throw new Error('expected a DecisionAdapterError')
}

describe('the request on the wire', () => {
  it('posts {model, state, questions} to the direct endpoint with the pinned model', async () => {
    const h = harness([reply(200, SUCCESS)])
    await h.decide()
    expect(h.calls).toHaveLength(1)
    const [c] = h.calls
    expect(c?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(c?.init.method).toBe('POST')
    expect(c?.init.redirect).toBe('error')
    expect(c?.init.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(c?.init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(headers.get('content-type')).toBe('application/json')
    const body = JSON.parse(String(c?.init.body)) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['model', 'state', 'questions'])
    expect(body).toEqual({ model: 'jev-1.13.0', state: REQUEST.state, questions: QUESTIONS })
  })

  it('posts to /decisions on the resold route', async () => {
    const h = harness([
      reply(200, {
        ...SUCCESS,
        model: 'typesafe/jev-1.13',
        usage: { input_tokens: 10, output_tokens: 0, cost: 0.00042 },
      }),
    ])
    const r = await h.decide('jev-openrouter')
    expect(h.calls[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 0, costUsd: 0.00042 })
  })

  it('never calls out without a bound credential', async () => {
    const h = harness([reply(200, SUCCESS)])
    h.adapter.bindCredential('jev', undefined)
    expect(await code(h.decide())).toBe('AUTH')
    expect(h.calls).toHaveLength(0)
  })
})

describe('answers', () => {
  it('maps the three answer types and the token counts by their documented names', async () => {
    const r = await harness([reply(200, SUCCESS)]).decide()
    expect(r).toEqual({
      answers: ANSWERS,
      model: 'jev-1.13.0',
      usage: { inputTokens: 1234, outputTokens: 9 },
    })
  })

  it('ignores a cost field on the direct route', async () => {
    const r = await harness([
      reply(200, { ...SUCCESS, usage: { input_tokens: 1, output_tokens: 0, cost: 9 } }),
    ]).decide()
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 0 })
  })

  // Nothing here is repaired: judging answers belongs to the caller's validator, which fails closed.
  it.each([
    [
      'probabilities that sum to 0.995',
      { a: { type: 'choice', choice: 'x', probabilities: { x: 0.5, y: 0.495 }, confidence: 0.5 } },
    ],
    [
      'probabilities that sum to 1.011',
      { a: { type: 'choice', choice: 'x', probabilities: { x: 0.6, y: 0.411 }, confidence: 0.5 } },
    ],
    [
      'keys in another order',
      { a: { confidence: 0.5, probabilities: { y: 0.5, x: 0.5 }, choice: 'x', type: 'choice' } },
    ],
    ['an extra field', { a: { type: 'noul', noul: 0.5, confidence: 0.9 } }],
    ['a number as a string', { a: { type: 'noul', noul: '0.5' } }],
    [
      'a legend that differs only by whitespace',
      {
        a: {
          type: 'score',
          score: 0,
          legend: { '0': 'none ', '1': 'some' },
          probabilities: { '0': 1, '1': 0 },
          confidence: 1,
        },
      },
    ],
  ])('passes %s through unchanged', async (_name, answers) => {
    const r = await harness([reply(200, { ...SUCCESS, answers })]).decide()
    expect(r.answers).toEqual(answers)
  })

  it('passes an overflowing number through as Infinity', async () => {
    const text =
      '{"model":"jev-1.13.0","answers":{"a":{"type":"noul","noul":1e999}},"usage":{"input_tokens":1,"output_tokens":0}}'
    const r = await harness([reply(200, text)]).decide()
    expect((r.answers.a as { noul: number }).noul).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns the version that answered and warns once when it is not the pinned one', async () => {
    const h = harness([
      reply(200, { ...SUCCESS, model: 'jev-1.14.0' }),
      reply(200, { ...SUCCESS, model: 'jev-1.14.0' }),
    ])
    expect((await h.decide()).model).toBe('jev-1.14.0')
    expect((await h.decide()).model).toBe('jev-1.14.0')
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]?.detail).toEqual({ route: 'jev', pinned: 'jev-1.13.0', actual: 'jev-1.14.0' })
  })
})

describe('malformed 200 bodies are FORMAT', () => {
  it.each([
    ['not JSON', '<html>busy</html>'],
    [
      'NaN, which JSON cannot carry',
      '{"model":"jev-1.13.0","answers":{"a":{"type":"noul","noul":NaN}},"usage":{"input_tokens":1,"output_tokens":0}}',
    ],
    ['a JSON array', []],
    ['no model', { answers: ANSWERS, usage: SUCCESS.usage }],
    ['an empty model', { ...SUCCESS, model: '' }],
    ['answers as an array', { ...SUCCESS, answers: [] }],
    ['an answer that is not an object', { ...SUCCESS, answers: { a: 0.5 } }],
    ['no usage', { model: 'jev-1.13.0', answers: ANSWERS }],
    ['a token count as a string', { ...SUCCESS, usage: { input_tokens: '12', output_tokens: 0 } }],
    ['a negative token count', { ...SUCCESS, usage: { input_tokens: -1, output_tokens: 0 } }],
  ])('%s', async (_name, body) => {
    expect(await code(harness([reply(200, body)]).decide())).toBe('FORMAT')
  })

  it('a body that is not UTF-8', async () => {
    expect(
      await code(harness([new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200 })]).decide()),
    ).toBe('FORMAT')
  })

  it('a body over one mebibyte', async () => {
    const big = JSON.stringify({ ...SUCCESS, pad: 'x'.repeat(1024 * 1024) })
    expect(await code(harness([reply(200, big)]).decide())).toBe('FORMAT')
  })
})

describe('HTTP failures', () => {
  it.each([401, 403])('%i is AUTH and is not retried', async (status) => {
    const h = harness([reply(status, { error: 'bad key' })])
    expect(await code(h.decide())).toBe('AUTH')
    expect(h.calls).toHaveLength(1)
  })

  it('422 is CONTRACT_MISMATCH and its details go to the log only', async () => {
    const h = harness([reply(422, { error: 'validation', details: { questions: 'bad criteria' } })])
    let thrown: unknown
    try {
      await h.decide()
    } catch (e) {
      thrown = e
    }
    expect(thrown).toMatchObject({ code: 'CONTRACT_MISMATCH', status: 422 })
    expect(String((thrown as Error).message)).not.toContain('bad criteria')
    expect(h.warnings).toHaveLength(1)
    expect(JSON.stringify(h.warnings[0]?.detail)).toContain('bad criteria')
    expect(h.calls).toHaveLength(1)
  })

  it('another status is TRANSPORT and is not retried', async () => {
    const h = harness([reply(500, 'oops')])
    expect(await code(h.decide())).toBe('TRANSPORT')
    expect(h.calls).toHaveLength(1)
  })

  it('a rejected fetch is TRANSPORT, an aborted one ABORTED', async () => {
    expect(await code(harness([new TypeError('fetch failed')]).decide())).toBe('TRANSPORT')
    const ac = new AbortController()
    ac.abort()
    expect(
      await code(harness([new DOMException('aborted', 'AbortError')]).decide('jev', {}, ac.signal)),
    ).toBe('ABORTED')
  })
})

describe('429 and 529 retry within the remaining time', () => {
  it('backs off exponentially without retry-after', async () => {
    const h = harness([reply(429, ''), reply(529, ''), reply(200, SUCCESS)])
    await h.decide()
    expect(h.slept).toEqual([100, 200])
    expect(h.calls).toHaveLength(3)
  })

  it('honours retry-after seconds, fractional included', async () => {
    const h = harness([reply(429, '', { 'retry-after': '0.25' }), reply(200, SUCCESS)])
    await h.decide()
    expect(h.slept).toEqual([250])
  })

  it('honours an HTTP-date retry-after measured on its own clock', async () => {
    const at = new Date(START + 1000).toUTCString()
    const h = harness([reply(429, '', { 'retry-after': at }), reply(200, SUCCESS)])
    await h.decide('jev', { timeoutMs: 2000 })
    expect(h.slept).toEqual([1000])
  })

  it.each([
    ['a negative number', '-1'],
    ['garbage', 'soon'],
    ['a past date', 'Thu, 01 Jan 2026 00:00:00 GMT'],
  ])('falls back to backoff for %s', async (_name, value) => {
    const h = harness([reply(429, '', { 'retry-after': value }), reply(200, SUCCESS)])
    await h.decide()
    expect(h.slept).toEqual([100])
  })

  it('gives up at once when the wait would outlast the time limit', async () => {
    const h = harness([reply(429, '', { 'retry-after': '5' }), reply(200, SUCCESS)])
    expect(await code(h.decide('jev', { timeoutMs: 1000 }))).toBe('RATE_LIMIT')
    expect(h.slept).toEqual([])
    expect(h.calls).toHaveLength(1)
  })

  it('never sleeps past the time limit in total', async () => {
    const h = harness([reply(529, ''), reply(529, ''), reply(529, ''), reply(529, ''), reply(529, '')])
    const start = h.clock()
    expect(await code(h.decide('jev', { timeoutMs: 500 }))).toBe('RATE_LIMIT')
    expect(h.clock() - start).toBeLessThan(500)
    expect(h.slept).toEqual([100, 200])
  })

  it('stops after four attempts even with time to spare', async () => {
    const h = harness([reply(429, ''), reply(429, ''), reply(429, ''), reply(429, ''), reply(200, SUCCESS)])
    expect(await code(h.decide('jev', { timeoutMs: 2000 }))).toBe('RATE_LIMIT')
    expect(h.calls).toHaveLength(4)
  })
})

describe('construction', () => {
  it('refuses a route whose api is not a Jev api', () => {
    expect(() => new JevDecisionAdapter({ routes: [{ ...DIRECT, api: 'openai-completions' }] })).toThrow(
      AiSetupError,
    )
  })
  it.each(['ftp://api.typesafe.ai/v1', 'https://user:pw@api.typesafe.ai/v1', 'not a url'])(
    'refuses base URL %s',
    (baseUrl) => {
      expect(() => new JevDecisionAdapter({ routes: [{ ...DIRECT, baseUrl }] })).toThrow(/INVALID_BASE_URL/)
    },
  )
  it('refuses a chat record on a decision route', () => {
    const chat = { ...DIRECT.models?.[0], kind: undefined } as unknown as DecisionModelRecord
    expect(() => new JevDecisionAdapter({ routes: [{ ...DIRECT, models: [chat] }] })).toThrow(/ADAPTER_KIND/)
  })
  it('declares each route with its credential reference', () => {
    const a = new JevDecisionAdapter({ routes: [DIRECT, RESOLD] })
    expect(a.routes()).toEqual(['jev', 'jev-openrouter'])
    expect(a.credentialDecls()).toEqual([
      { route: 'jev', credentialRef: TYPESAFE_CREDENTIAL_REF },
      { route: 'jev-openrouter', credentialRef: 'secret://openrouter/default' },
    ])
    expect(TYPESAFE_CREDENTIAL_REF).toBe('secret://typesafe/default')
  })
})

describe('over a real socket on loopback', () => {
  let server: Server
  let base = ''
  let mode = 'ok'
  let hits = 0
  const timers = new Set<NodeJS.Timeout>()
  const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(body)
  }

  beforeAll(async () => {
    installLoopbackOnly()
    server = createServer((req, res) => {
      hits += 1
      req.resume()
      if (mode === 'truncate') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' })
        res.write('{"model":"jev')
        res.socket?.destroy()
      } else if (mode === 'partial') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"model":"jev')
      } else if (mode === 'drip') {
        res.writeHead(200, { 'content-type': 'application/json' })
        const t = setInterval(() => res.write(' '), 50)
        timers.add(t)
        res.on('close', () => clearInterval(t))
      } else if (mode === 'redirect') {
        res.writeHead(302, { location: `${base}/elsewhere` })
        res.end()
      } else if (mode === 'rate-short') {
        send(res, 429, '', { 'retry-after': '0.05' })
      } else if (mode === 'rate-long') {
        send(res, 429, '', { 'retry-after': '1' })
      } else send(res, 200, JSON.stringify(SUCCESS))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => {
    assertLoopbackOnly()
    hits = 0
  })
  afterAll(async () => {
    for (const t of timers) clearInterval(t)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    restoreLoopbackOnly()
  })

  const provider = () => {
    const route: RouteDecl = {
      ...DIRECT,
      baseUrl: `${base}/v1`,
      models: [jev('jev', 'jev-1.13.0', 'typesafe-systemone', `${base}/v1`)],
    }
    const p = createProvider({
      adapters: [],
      decision: { adapters: [new JevDecisionAdapter({ routes: [route] })], routes: [route] },
      routes: { primary: { route: 'unused', model: 'unused' } },
      contract: new NullContractStore(),
      secrets: (ref) => (ref === TYPESAFE_CREDENTIAL_REF ? KEY : ''),
      clock: () => Date.now(),
      pricing: { creditsPerUsd: 1 },
    })
    const decide = p.decide
    if (!decide) throw new Error('no decide')
    return (timeoutMs = 1000) => decide({ ...REQUEST, timeoutMs }, { signal: new AbortController().signal })
  }

  it('prices a direct call from the catalogue', async () => {
    mode = 'ok'
    const r = await provider()()
    expect(r).toMatchObject({ route: 'jev', model: 'jev-1.13.0', creditSource: 'estimated' })
    // 1234 input tokens at $0.042 per million, one credit per dollar, rounded to six places.
    expect(r.credits).toBe(0.000052)
  })

  it('a connection cut mid-body is TRANSPORT', async () => {
    mode = 'truncate'
    await expect(provider()()).rejects.toMatchObject({ kind: 'unavailable', code: 'TRANSPORT' })
  })

  it('a body that ends cleanly but is cut short is FORMAT', async () => {
    mode = 'partial'
    await expect(provider()()).rejects.toMatchObject({ kind: 'invalid', code: 'FORMAT' })
  })

  it('a slow drip is cut off at the time limit', async () => {
    mode = 'drip'
    const started = Date.now()
    await expect(provider()(300)).rejects.toMatchObject({ kind: 'timeout', code: 'TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('a redirect is refused, not followed', async () => {
    mode = 'redirect'
    await expect(provider()()).rejects.toMatchObject({ kind: 'unavailable', code: 'TRANSPORT' })
    expect(hits).toBe(1)
  })

  it('short retry-after waits are retried inside the limit, then give up', async () => {
    mode = 'rate-short'
    const started = Date.now()
    await expect(provider()(400)).rejects.toMatchObject({ kind: 'unavailable', code: 'RATE_LIMIT' })
    expect(hits).toBe(4)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('a retry-after longer than the limit is not waited on', async () => {
    mode = 'rate-long'
    await expect(provider()(400)).rejects.toMatchObject({ kind: 'unavailable', code: 'RATE_LIMIT' })
    expect(hits).toBe(1)
  })
})
