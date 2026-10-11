import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { classifyPiError } from '../src/adapters/pi/errors.js'
import { PiAdapter } from '../src/adapters/pi/index.js'
import { networkFailure } from '../src/adapters/pi/network.js'
import { AMBIENT_CREDENTIAL_APIS, streamOverApi } from '../src/adapters/pi/wire.js'
import type { WireEvent } from '../src/index.js'
import {
  assertLoopbackOnly,
  fakeModel,
  fakeRequest,
  installLoopbackOnly,
  restoreLoopbackOnly,
} from '../testkit/index.js'

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
    ['getaddrinfo ENOTFOUND sk-abc.example', 'TRANSPORT', true, undefined],
    ['certificate for sk-abc.example: CERT_HAS_EXPIRED', 'TRANSPORT', false, undefined],
    // A client library's own wrapper says that the request failed, not why; on its own it is not
    // evidence of a network failure, and the fetch that saw the real one is what says so.
    ['Connection error.', 'TRANSPORT', false, undefined],
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

  // Node's own text for a socket failure carries the address, and its port is not a status. A 5xx
  // that quotes a code, though, is the far end's answer about its upstream and keeps its status.
  it('names a network code in the text only when nothing answered', () => {
    expect(classifyPiError(msg('connect ECONNREFUSED 10.0.0.1:443')).message).toBe(
      'the model provider refused the connection while connecting (ECONNREFUSED)',
    )
    expect(classifyPiError(msg('502 Bad Gateway: upstream connect ECONNREFUSED')).message).toBe('status=502')
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

// The wire library hands the classifier "Connection error." or "terminated" for every one of these;
// the code that says what happened is on the error the fetch threw, a cause or two down. Each row is
// that error as Node builds it, with an address and a would-be secret in its text that must not come
// through: only the code, from a fixed list, and the phase are kept.
const sysErr = (message: string, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra })
const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause })
const terminated = (cause: unknown) => new TypeError('terminated', { cause })

describe('network failures seen by the fetch', () => {
  it.each([
    [
      'the connection to the model provider was reset while waiting for the first byte (ECONNRESET)',
      fetchFailed(sysErr('read ECONNRESET sk-abc.example', 'ECONNRESET', { syscall: 'read' })),
      'first-byte',
      'TRANSPORT',
      true,
    ],
    [
      'the model provider refused the connection while connecting (ECONNREFUSED)',
      fetchFailed(sysErr('connect ECONNREFUSED 10.0.0.1:443 sk-abc', 'ECONNREFUSED', { syscall: 'connect' })),
      'first-byte',
      'TRANSPORT',
      true,
    ],
    [
      "the model provider's host name was not found while connecting (ENOTFOUND)",
      fetchFailed(sysErr('getaddrinfo ENOTFOUND sk-abc.example', 'ENOTFOUND', { syscall: 'getaddrinfo' })),
      'first-byte',
      'TRANSPORT',
      true,
    ],
    [
      "the model provider's host name could not be resolved while connecting (EAI_AGAIN)",
      fetchFailed(sysErr('getaddrinfo EAI_AGAIN sk-abc.example', 'EAI_AGAIN', { syscall: 'getaddrinfo' })),
      'first-byte',
      'TRANSPORT',
      true,
    ],
    // Undici's ten-second connect timeout, which the client library reports as "Request timed out."
    // and nothing more - so a route that could not be reached read as a slow model.
    [
      'the connection to the model provider timed out while connecting (connect timeout, UND_ERR_CONNECT_TIMEOUT)',
      fetchFailed(
        sysErr('Connect Timeout Error (attempted address: sk-abc.example:443)', 'UND_ERR_CONNECT_TIMEOUT'),
      ),
      'first-byte',
      'TIMEOUT',
      true,
    ],
    [
      'the model provider did not answer in time while waiting for the first byte (headers timeout, UND_ERR_HEADERS_TIMEOUT)',
      fetchFailed(sysErr('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT')),
      'first-byte',
      'TIMEOUT',
      true,
    ],
    [
      'the model provider stopped sending mid-stream (body timeout, UND_ERR_BODY_TIMEOUT)',
      terminated(sysErr('Body Timeout Error', 'UND_ERR_BODY_TIMEOUT')),
      'stream',
      'TIMEOUT',
      true,
    ],
    [
      'the model provider closed the connection mid-stream (UND_ERR_SOCKET)',
      terminated(sysErr('other side closed sk-abc', 'UND_ERR_SOCKET')),
      'stream',
      'TRANSPORT',
      true,
    ],
    // A reset during the TLS handshake is a connection that was never established.
    [
      'the connection to the model provider was reset while connecting (ECONNRESET)',
      fetchFailed(
        sysErr(
          'Client network socket disconnected before secure TLS connection was established',
          'ECONNRESET',
        ),
      ),
      'first-byte',
      'TRANSPORT',
      true,
    ],
    // Happy eyeballs: every address failed, and the codes are on the aggregate's members.
    [
      'the connection to the model provider timed out while connecting (TCP timeout, ETIMEDOUT)',
      fetchFailed(
        new AggregateError([
          sysErr('connect ETIMEDOUT 10.0.0.1:443', 'ETIMEDOUT', { syscall: 'connect' }),
          sysErr('connect ENETUNREACH ::1:443', 'ENETUNREACH', { syscall: 'connect' }),
        ]),
      ),
      'first-byte',
      'TIMEOUT',
      true,
    ],
    // A certificate that is not accepted now will not be accepted in a second either.
    [
      "the model provider's TLS certificate was not accepted while connecting (CERT_HAS_EXPIRED)",
      fetchFailed(sysErr('certificate has expired sk-abc', 'CERT_HAS_EXPIRED')),
      'first-byte',
      'TRANSPORT',
      false,
    ],
    // A client-library code outside the list is named but not placed or retried: it says the request
    // went wrong in this process, which asking again does not mend.
    [
      'the HTTP client failed (UND_ERR_INVALID_ARG)',
      fetchFailed(sysErr('invalid onRequestStart method', 'UND_ERR_INVALID_ARG')),
      'first-byte',
      'TRANSPORT',
      false,
    ],
  ] as const)('%s', (message, error, phase, code, retryable) => {
    const failure = networkFailure(error, phase)
    expect(classifyPiError(msg('Connection error.'), undefined, failure)).toEqual({
      code,
      retryable,
      message,
    })
    expect(JSON.stringify(failure)).not.toContain('sk-abc')
  })

  // The code is copied only when it is one this list knows or has the shape of one. Anything else is
  // dropped rather than echoed, and the failure falls back to the text it came with.
  it.each([
    ['a code nobody listed', fetchFailed(sysErr('x', 'EWHATEVER'))],
    ['a code that is really a URL', fetchFailed(sysErr('x', 'https://sk-abc.example/v1'))],
    ['no code at all', fetchFailed(new Error('x'))],
    ['an abort', new DOMException('This operation was aborted', 'AbortError')],
  ])('keeps nothing from %s', (_name, error) => {
    expect(networkFailure(error, 'first-byte')).toBeUndefined()
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
  // The total deadline is set far out of reach, so only the first-token one can end this, and the
  // message has to name that one: which timer fired is what a reader of the error is looking for.
  it.each([undefined, 'start', 'text_start', 'thinking_start', 'toolcall_start', 'text_delta'])(
    'a stream with only %s and no output fails on the first-token deadline',
    async (type) => {
      const silent: StreamImpl = () =>
        (async function* () {
          if (type) yield { type, contentIndex: 0, delta: '', partial: msg('') } as never
          await new Promise<never>(() => {})
        })()
      const out = await drain(adapter({ streamImpl: silent }), {
        timeoutMs: { firstToken: 20, total: 60_000 },
      })
      expect(out.filter((event) => event.type !== 'text_delta')).toEqual([
        {
          type: 'error',
          reason: 'error',
          code: 'TIMEOUT',
          message:
            'no answer from the model provider while waiting for the first byte (first-token timeout, 20ms)',
          retryable: true,
        },
      ])
    },
  )

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
  // model that emits one token and then stops is otherwise a turn that never ends. The timeout is
  // this adapter's own error, so it carries what the HTTP response already said about who answered.
  it('a stream that speaks once and then stops fails on the total deadline', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(null, { headers: { 'x-request-id': 'req-stall', 'set-cookie': 'sid=never-recorded' } }),
    )
    const stall: StreamImpl = (_model, _context, options) =>
      (async function* () {
        await options?.fetch?.('https://gw.invalid/chat/completions', { method: 'POST', body: '{}' })
        yield { type: 'text_delta', contentIndex: 0, delta: 'a', partial: msg('') } as never
        await new Promise<never>(() => {})
      })()
    try {
      const out = await drain(adapter({ streamImpl: stall }), { timeoutMs: { firstToken: 20, total: 60 } })
      expect(out).toEqual([
        { type: 'text_delta', delta: 'a' },
        {
          type: 'error',
          reason: 'error',
          code: 'TIMEOUT',
          message: 'the model provider did not finish its answer mid-stream (total timeout, 60ms)',
          retryable: true,
          response: {
            status: 200,
            headers: { 'x-request-id': 'req-stall' },
            headerNames: ['set-cookie', 'x-request-id'],
          },
        },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // The same deadline says something different once the provider has answered: the route is up and
  // the model is what has not started, which is a different thing to go and look at.
  it('a first-token timeout after the response headers names the status that came back', async () => {
    vi.stubGlobal('fetch', async () => new Response(null))
    const answeredThenSilent: StreamImpl = (_model, _context, options) =>
      (async function* () {
        await options?.fetch?.('https://gw.invalid/chat/completions', { method: 'POST', body: '{}' })
        await new Promise<never>(() => {})
      })()
    try {
      const out = await drain(adapter({ streamImpl: answeredThenSilent }), {
        timeoutMs: { firstToken: 20, total: 60_000 },
      })
      expect(out).toMatchObject([
        {
          type: 'error',
          code: 'TIMEOUT',
          message: 'the model provider answered status=200 but sent no output (first-token timeout, 20ms)',
          retryable: true,
        },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
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

// The same failures on a real socket and through the real wire library, which is where the codes
// above go missing: the server resets or closes the connection at a chosen point and what reaches
// the caller is checked end to end. It is bound to 127.0.0.1, and the process refuses anything else
// at the socket.
describe('network failures on a real socket', () => {
  let server: Server
  let mode = 'reset'
  let base = ''
  // Cuts the connection under a response that has started. Called once the caller has seen the first
  // delta, so the failure lands while the body is being read and not before the chunk was.
  let cut: (() => void) | undefined
  beforeAll(async () => {
    installLoopbackOnly()
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (mode === 'reset') return req.socket.resetAndDestroy()
        if (mode === 'close') return req.socket.destroy()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = { role: 'assistant', content: 'hel' }
        res.write(
          `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        )
        cut = () => (mode === 'mid-reset' ? req.socket.resetAndDestroy() : req.socket.destroy())
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    restoreLoopbackOnly()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  afterEach(() => assertLoopbackOnly())

  const run = async (baseUrl: string, maxRetries: number) => {
    let attempts = 0
    const a = new PiAdapter({
      manualRoutes: [{ ...route, baseUrl }],
      streamImpl: (model, context, options) => {
        attempts++
        return streamOverApi(model, context, options)
      },
      maxRetries,
      sleep: async () => {},
    })
    a.bindCredential('gw', 'k')
    const events: WireEvent[] = []
    for await (const e of a.stream('gw', fakeRequest({ route: 'gw', model: 'm' }), {
      signal: new AbortController().signal,
      toolNames: [],
      sessionKey: 'k',
      timeoutMs: slow,
    })) {
      events.push(e)
      if (e.type === 'text_delta') cut?.()
    }
    return { events, attempts }
  }

  // Before this, both were "Connection error." and neither was retried: a reset that a second
  // attempt would very likely have survived ended the turn.
  it.each([
    ['reset', 'the connection to the model provider was reset while waiting for the first byte (ECONNRESET)'],
    ['close', 'the model provider closed the connection while waiting for the first byte (UND_ERR_SOCKET)'],
  ])('retries a connection %s before the response, then names it', async (m, message) => {
    mode = m
    const { events, attempts } = await run(base, 2)
    expect(attempts).toBe(3)
    expect(events).toEqual([
      {
        type: 'error',
        reason: 'error',
        code: 'TRANSPORT',
        message: `${message}, after 3 attempts`,
        retryable: true,
      },
    ])
  })

  it('names a refused connection as one that never connected', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { events, attempts } = await run(`http://127.0.0.1:${port}`, 1)
    expect(attempts).toBe(2)
    expect(events).toEqual([
      {
        type: 'error',
        reason: 'error',
        code: 'TRANSPORT',
        message:
          'the model provider refused the connection while connecting (ECONNREFUSED), after 2 attempts',
        retryable: true,
      },
    ])
  })

  // Part of the answer has already been forwarded, so this adapter must not ask again and append a
  // second answer to it. It is still offered as retryable: the caller that keeps the partial text
  // apart from the transcript is the one that may start a new request.
  it.each([
    ['mid-reset', 'the connection to the model provider was reset mid-stream (ECONNRESET)'],
    ['mid-close', 'the model provider closed the connection mid-stream (UND_ERR_SOCKET)'],
  ])('reports a %s failure after output without retrying it here', async (m, message) => {
    mode = m
    const { events, attempts } = await run(base, 2)
    expect(attempts).toBe(1)
    expect(events).toMatchObject([
      { type: 'text_delta', delta: 'hel' },
      { type: 'error', code: 'TRANSPORT', message, retryable: true, response: { status: 200 } },
    ])
  })
})
