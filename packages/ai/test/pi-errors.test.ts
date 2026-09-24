import type { AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { classifyPiError } from '../src/adapters/pi/errors.js'
import { PiAdapter } from '../src/adapters/pi/index.js'
import { AMBIENT_CREDENTIAL_APIS } from '../src/adapters/pi/wire.js'
import type { WireEvent } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'

type StreamImpl = NonNullable<ConstructorParameters<typeof PiAdapter>[0]['streamImpl']>

const msg = (
  errorMessage: string,
  stopReason: AssistantMessage['stopReason'] = 'error',
  usage: Partial<AssistantMessage['usage']> = {},
): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'openai-completions',
  provider: 'gw',
  model: 'm',
  stopReason,
  errorMessage,
  timestamp: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...usage,
  },
})

describe('classifyPiError', () => {
  it.each([
    ['401 Unauthorized: invalid api key sk-abc', 'AUTH', false, undefined],
    ['429 Too Many Requests, retry-after: 7', 'RATE_LIMIT', true, 7000],
    ['rate limit exceeded', 'RATE_LIMIT', true, 1000],
    ['402 insufficient credit', 'QUOTA', false, undefined],
    ['request timed out after 30s', 'TIMEOUT', true, undefined],
    ['404 model gpt-x not found', 'NO_MODEL', false, undefined],
    ['Unexpected token < in JSON', 'FORMAT', false, undefined],
    ['503 Service Unavailable', 'TRANSPORT', true, undefined],
    ['ECONNRESET', 'TRANSPORT', true, undefined],
    ['weird failure', 'TRANSPORT', false, undefined],
  ] as const)('%s -> %s', (text, code, retryable, retryAfterMs) => {
    const c = classifyPiError(msg(text))
    expect(c.code).toBe(code)
    expect(c.retryable).toBe(retryable)
    if (retryAfterMs !== undefined) expect(c.retryAfterMs).toBe(retryAfterMs)
    // The provider's own words are never forwarded; a key quoted back in an error message would
    // otherwise land in an event that is stored and displayed.
    expect(c.message).not.toContain('sk-abc')
  })

  it('maps context overflow and abort', () => {
    expect(classifyPiError(msg("This model's maximum context length is 8192 tokens"), 8192).code).toBe(
      'OVERFLOW',
    )
    expect(classifyPiError(msg('', 'aborted')).code).toBe('ABORTED')
  })

  // A permanent misconfiguration answered as retryable is retried under backoff until the budget is
  // gone, so the two halves of every row - the code and whether to ask again - are asserted together
  // above, and the default is asserted to be the cautious one here.
  it('does not offer a retry for a failure it could not classify', () => {
    expect(classifyPiError(msg('something nobody has seen before'))).toMatchObject({
      code: 'TRANSPORT',
      retryable: false,
    })
  })
})

// The timeout cases are about a stream that hangs, not about credentials - so the fixture route
// BINDS one. Without credentialRef and a bound secret the fail-closed gate answers AUTH before the
// stream is ever opened, and a green TIMEOUT test would be evidence that the gate had been removed.
const route = {
  route: 'gw',
  api: 'openai-completions',
  baseUrl: 'https://gw.invalid',
  credentialRef: 'secret://ai/gw',
  models: [fakeModel({ id: 'm', route: 'gw', contextWindow: 8192 })],
}
const hang: StreamImpl = () =>
  (async function* () {
    await new Promise<never>(() => {})
    yield undefined as never
  })()
const scripted =
  (...events: unknown[]): StreamImpl =>
  () =>
    (async function* () {
      for (const e of events) yield e as never
    })()

function adapter(cfg: Partial<ConstructorParameters<typeof PiAdapter>[0]> & { streamImpl: StreamImpl }) {
  const a = new PiAdapter({ manualRoutes: [route], maxRetries: 0, ...cfg })
  if (cfg.manualRoutes === undefined) a.bindCredential('gw', 'k')
  return a
}
const drain = async (
  a: PiAdapter,
  over: Partial<{ signal: AbortSignal; timeoutMs: { firstToken: number; total: number } }> = {},
): Promise<WireEvent[]> => {
  const out: WireEvent[] = []
  for await (const e of a.stream('gw', fakeRequest({ route: 'gw', model: 'm' }), {
    signal: new AbortController().signal,
    toolNames: [],
    sessionKey: 'k',
    timeoutMs: { firstToken: 20, total: 1000 },
    ...over,
  }))
    out.push(e)
  return out
}
const slow = { firstToken: 5000, total: 5000 }

describe('timeouts and cancellation', () => {
  // The total deadline is set far out of reach, so only the first-token one can end this. With both
  // in range the two are indistinguishable - the message is chosen from whether anything arrived,
  // not from which timer fired - and a case that cannot tell them apart tests neither.
  it('a stream that never speaks fails on the first-token deadline', async () => {
    expect(
      await drain(adapter({ streamImpl: hang }), { timeoutMs: { firstToken: 20, total: 60_000 } }),
    ).toEqual([
      { type: 'error', reason: 'error', code: 'TIMEOUT', message: 'first token timeout', retryable: true },
    ])
  })

  // And once it has spoken, the first-token deadline is spent. A model that thinks for longer than
  // that between tokens is answering, not hanging, and must not be cut off by the deadline that
  // asked whether the route was alive at all.
  it('does not hold a stream to the first-token deadline once it has started answering', async () => {
    const slowAnswer: StreamImpl = () =>
      (async function* () {
        yield { type: 'text_delta', contentIndex: 0, delta: 'a', partial: msg('') } as never
        await new Promise((resolve) => setTimeout(resolve, 120))
        yield { type: 'done', reason: 'stop', message: msg('', 'stop') } as never
      })()
    const out = await drain(adapter({ streamImpl: slowAnswer }), {
      timeoutMs: { firstToken: 20, total: 4000 },
    })
    expect(out.map((e) => e.type)).toEqual(['text_delta', 'usage', 'done'])
  })

  // Once a stream has spoken the first-token deadline is spent, and only the total one is left. A
  // model that emits one token and then stops is otherwise a turn that never ends.
  it('a stream that speaks once and then stops fails on the total deadline', async () => {
    const stall: StreamImpl = () =>
      (async function* () {
        yield { type: 'text_delta', contentIndex: 0, delta: 'a', partial: msg('') } as never
        await new Promise<never>(() => {})
      })()
    const out = await drain(adapter({ streamImpl: stall }), { timeoutMs: { firstToken: 20, total: 60 } })
    expect(out).toEqual([
      { type: 'text_delta', delta: 'a' },
      { type: 'error', reason: 'error', code: 'TIMEOUT', message: 'total timeout', retryable: true },
    ])
  })

  it('a caller abort ends the stream as ABORTED rather than as a timeout', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 10)
    const out = await drain(adapter({ streamImpl: hang }), { signal: ac.signal, timeoutMs: slow })
    expect(out).toEqual([
      { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false },
    ])
  })

  // The default nobody walks. maxRetries defaults to 2, so one retryable failure becomes three
  // requests and three charges for anyone who does not pass the option. Every other case in this
  // package passes it explicitly, so the number a real assembly gets was proved by nothing.
  it('the default retry budget is 2, so a retryable failure is attempted three times', async () => {
    let attempts = 0
    const flaky: StreamImpl = () => {
      attempts++
      return (async function* () {
        yield { type: 'error', reason: 'error', error: msg('503 Service Unavailable') } as never
      })()
    }
    const a = new PiAdapter({ manualRoutes: [route], streamImpl: flaky, sleep: async () => {} })
    a.bindCredential('gw', 'k')
    await drain(a, { timeoutMs: slow })
    expect(attempts).toBe(3)
  })
})

// The gate this task must not remove. One case per refusal, so a rewrite of stream() that drops any
// of them is red in this file rather than in a leak.
describe('credential fail-closed gate', () => {
  it('a route that neither declares keyless nor binds a credential is refused before the socket', async () => {
    const { credentialRef: _ref, ...bare } = route
    const a = new PiAdapter({ manualRoutes: [bare], streamImpl: hang, maxRetries: 0 })
    expect(await drain(a)).toEqual([
      { type: 'error', reason: 'error', code: 'AUTH', message: 'route=gw', retryable: false },
    ])
  })

  it('a route that names a credentialRef and was handed nothing is refused', async () => {
    const a = new PiAdapter({ manualRoutes: [route], streamImpl: hang, maxRetries: 0 })
    expect(await drain(a)).toEqual([
      { type: 'error', reason: 'error', code: 'AUTH', message: 'route=gw', retryable: false },
    ])
  })

  // On these apis the client library authenticates from the host itself, so honouring `keyless`
  // would ship the deployment's own cloud identity to whatever endpoint the route named - and the
  // route name is configuration. The declaration is refused rather than obeyed.
  it.each([...AMBIENT_CREDENTIAL_APIS])('keyless is refused on %s', async (api) => {
    const { credentialRef: _ref, ...rest } = route
    const a = new PiAdapter({
      manualRoutes: [{ ...rest, api, keyless: true }],
      streamImpl: hang,
      maxRetries: 0,
    })
    const e = (await drain(a))[0] as { code: string; message: string; retryable: boolean }
    expect(e.code).toBe('AUTH')
    expect(e.retryable).toBe(false)
    expect(e.message).toContain('keyless refused')
  })

  // The positive control. A gate that refuses everything proves nothing, so the same fixture with a
  // credential actually bound reaches the wire and the request carries that credential and no other.
  it('a properly bound route does reach the wire, carrying the credential it was handed', async () => {
    const keys: Array<string | undefined> = []
    const seen: StreamImpl = (_model, _context, options) => {
      keys.push(options?.apiKey)
      return (async function* () {
        yield { type: 'done', reason: 'stop', message: msg('', 'stop') } as never
      })()
    }
    const a = new PiAdapter({ manualRoutes: [route], streamImpl: seen, maxRetries: 0 })
    a.bindCredential('gw', 'sk-bound')
    expect((await drain(a, { timeoutMs: slow })).map((e) => e.type)).toEqual(['usage', 'done'])
    expect(keys).toEqual(['sk-bound'])
  })

  // A credential bound for one route is not a credential for another. Two routes on one adapter, one
  // of them keyed: the unkeyed one is refused rather than served from its neighbour's secret.
  it('does not serve one route from another route’s credential', async () => {
    const other = { ...route, route: 'other', credentialRef: 'secret://ai/other' }
    const a = new PiAdapter({ manualRoutes: [route, other], streamImpl: hang, maxRetries: 0 })
    a.bindCredential('gw', 'sk-gw')
    const out: WireEvent[] = []
    for await (const e of a.stream('other', fakeRequest({ route: 'other', model: 'm' }), {
      signal: new AbortController().signal,
      toolNames: [],
      sessionKey: 'k',
      timeoutMs: slow,
    }))
      out.push(e)
    expect(out).toEqual([
      { type: 'error', reason: 'error', code: 'AUTH', message: 'route=other', retryable: false },
    ])
  })
})

// OVERFLOW, reached the way a user reaches it: through stream(), with the context window coming from
// the route's own catalogue record rather than from a test argument.
describe('context overflow through stream()', () => {
  it('classifies an overflow the provider spelled out, with nobody passing a window', async () => {
    const a = adapter({
      streamImpl: scripted({
        type: 'error',
        reason: 'error',
        error: msg("This model's maximum context length is 8192 tokens"),
      }),
    })
    a.bindCredential('gw', 'k')
    expect((await drain(a, { timeoutMs: slow }))[0]).toMatchObject({
      code: 'OVERFLOW',
      retryable: false,
    })
  })

  // The half that needs the window. A provider that truncated an oversized input and stopped for
  // length says nothing about a context at all: the only signal is that the input filled the window
  // the catalogue declared. Nobody but a test ever passed that number in, which is what made this
  // arm of the classification unreachable in production.
  it('classifies a silent overflow from the record window, which no caller supplies', async () => {
    const a = adapter({
      streamImpl: scripted({
        type: 'error',
        reason: 'error',
        error: msg('', 'length', { input: 8192, output: 0 }),
      }),
    })
    a.bindCredential('gw', 'k')
    expect((await drain(a, { timeoutMs: slow }))[0]).toMatchObject({
      code: 'OVERFLOW',
      retryable: false,
    })
  })
})
