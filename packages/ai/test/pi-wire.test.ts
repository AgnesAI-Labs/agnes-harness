import type { RequestBody, RequestMessage } from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ManualRoute } from '../src/adapters/pi/index.js'
import type { WireEvent } from '../src/index.js'
import { AiSetupError, PiAdapter } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'

/**
 * These cases run the adapter's real default wire path — no stream is injected — because the thing
 * under test is what that path does with a credential it was not given. `globalThis.fetch` is
 * replaced by a recorder that captures the request and throws, so an attempt to reach the network
 * is observable and no packet can leave the process.
 */
type WireCall = { url: string; authorization: string | null }

let calls: WireCall[]
let originalFetch: typeof globalThis.fetch
let originalKey: string | undefined

const AMBIENT = 'sk-AMBIENT-EXPERIMENT'

beforeEach(() => {
  calls = []
  originalFetch = globalThis.fetch
  originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = AMBIENT
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push({ url: req.url, authorization: req.headers.get('authorization') })
    throw new Error('the test blocked this request')
  }) as typeof globalThis.fetch
})

it('preserves MCP action validation branches inside an object-root tool schema on the actual wire', async () => {
  const helper = (await import(
    new URL('../../package-manager/bundled-plugins/mcp-helper/index.mjs', import.meta.url).href
  )) as {
    mcpHelper: {
      apply(ctx: { extension(): { registerTool(tool: RequestBody['tools'][number]): void } }): void
    }
  }
  let tool: RequestBody['tools'][number] | undefined
  helper.mcpHelper.apply({
    extension: () => ({
      registerTool: (definition) => {
        tool = definition
      },
    }),
  })
  if (!tool) throw new Error('Missing mcp_manage definition')
  const bodies: Array<{ tools: Array<{ function: { parameters: Record<string, unknown> } }> }> = []
  globalThis.fetch = async (input, init) => {
    bodies.push(JSON.parse(await new Request(input, init).text()))
    throw new Error('Synthetic schema capture blocked network')
  }
  const adapter = new PiAdapter({
    manualRoutes: [routeDecl({ route: 'gw' })],
    maxRetries: 0,
    sleep: async () => {},
  })
  adapter.bindCredential('gw', 'synthetic-test-key')
  for await (const _event of adapter.stream(
    'gw',
    fakeRequest({ route: 'gw', model: modelId, tools: [tool] }),
    {
      signal: new AbortController().signal,
      toolNames: ['mcp_manage'],
      sessionKey: 'agnes:t:a:cli:dm:x',
      timeoutMs: { firstToken: 1000, total: 5000 },
    },
  )) {
    /* The real serializer reaches intercepted fetch without contacting a provider. */
  }
  expect(bodies).toHaveLength(1)
  const parameters = bodies[0]?.tools[0]?.function.parameters
  expect(parameters).toMatchObject({
    type: 'object',
    properties: { action: { anyOf: expect.any(Array) } },
    required: ['action'],
    additionalProperties: false,
    anyOf: expect.any(Array),
  })
  expect(parameters?.anyOf).toHaveLength(5)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalKey
})

const modelId = 'gpt-4o-mini'
const routeDecl = (over: Partial<ManualRoute> & { route: string }): ManualRoute => ({
  api: 'openai-completions',
  baseUrl: 'https://gw.invalid/v1',
  models: [
    fakeModel({
      id: modelId,
      route: over.route,
      api: 'openai-completions',
      baseUrl: 'https://gw.invalid/v1',
    }),
  ],
  ...over,
})

// Retries are switched off and the wait is a no-op: these cases are about what reaches the wire,
// and a real backoff would only make them slow.
const run = async (decl: ManualRoute, credential?: string) => {
  const a = new PiAdapter({ manualRoutes: [decl], maxRetries: 0, sleep: async () => {} })
  if (credential !== undefined) a.bindCredential(decl.route, credential)
  const out: WireEvent[] = []
  for await (const e of a.stream(decl.route, fakeRequest({ route: decl.route, model: modelId }), {
    signal: new AbortController().signal,
    toolNames: [],
    sessionKey: 'agnes:t:a:cli:dm:x',
    timeoutMs: { firstToken: 1000, total: 5000 },
  })) {
    out.push(e)
  }
  return out
}

describe('the default wire path never borrows a credential from the environment', () => {
  // The route is named after one of the wire library's builtin providers while pointing somewhere
  // else entirely. The library's dispatcher picks the environment variable to read from that name
  // and then sends the result to the declared endpoint, so this shape is how an operator's OpenAI
  // key would leave for gw.invalid. Nothing about the route declares a credential, which is exactly
  // why it must not acquire one.
  it('refuses a keyless route named after a builtin provider', async () => {
    const events = await run(routeDecl({ route: 'openai' }))
    expect(calls).toEqual([])
    expect(events).toEqual([
      { type: 'error', reason: 'error', code: 'AUTH', message: 'route=openai', retryable: false },
    ])
  })

  it('refuses a route that declared a credential and was handed none', async () => {
    const events = await run(routeDecl({ route: 'openai', credentialRef: 'secret://agnes/openai' }))
    expect(calls).toEqual([])
    expect(events).toEqual([
      { type: 'error', reason: 'error', code: 'AUTH', message: 'route=openai', retryable: false },
    ])
  })

  // A route whose name matches no builtin provider took a different branch through the dispatcher
  // and failed further downstream, as a transport error. It is the same configuration mistake as
  // the two above and now reads the same way.
  it('refuses a keyless route named after nothing in particular', async () => {
    const events = await run(routeDecl({ route: 'gw' }))
    expect(calls).toEqual([])
    expect(events).toEqual([
      { type: 'error', reason: 'error', code: 'AUTH', message: 'route=gw', retryable: false },
    ])
  })

  // The escape hatch, and the pin on the dispatcher being gone: a route may declare that it needs
  // no credential, and then it really gets none. Under the old default this same declaration would
  // have been answered with the ambient key, because the route is still named `openai`.
  //
  // The failure it produces is pinned too, and it now reads as what it is. The library refuses to
  // send an unauthenticated request at all — permanently — and that used to arrive here as a
  // retryable transport error, so a configuration mistake was retried under backoff until the
  // budget was gone. It is an auth failure and it is not retried.
  //
  // The rest of the class the older note listed is closed elsewhere and stays closed: a credential
  // that is a zero-width space or a NUL counts as no credential at all and is refused by the gate
  // above rather than by the HTTP client, and a base URL the api would have resolved somewhere the
  // route never declared is refused at construction.
  it('sends no credential for a route that declared itself keyless', async () => {
    const events = await run(routeDecl({ route: 'openai', keyless: true }))
    expect(calls).toEqual([])
    expect(events).toEqual([
      { type: 'error', reason: 'error', code: 'AUTH', message: 'status=?', retryable: false },
    ])
  })

  // A credential that is only whitespace used to pass the gate — it is not `undefined` — and then go
  // out as an empty `Bearer`. It counts as absent now, so the same route fails closed instead.
  it('treats a whitespace-only credential as no credential', async () => {
    for (const blank of ['   ', '\t\n']) {
      calls = []
      const events = await run(routeDecl({ route: 'openai', credentialRef: 'secret://agnes/openai' }), blank)
      expect(calls).toEqual([])
      expect(events).toEqual([
        { type: 'error', reason: 'error', code: 'AUTH', message: 'route=openai', retryable: false },
      ])
    }
  })

  // Whitespace around a credential is not part of it, and dropping it must not drop the credential.
  it('sends a credential that was bound with surrounding whitespace, trimmed', async () => {
    await run(routeDecl({ route: 'openai', credentialRef: 'secret://agnes/openai' }), '  sk-BOUND\n')
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.authorization).toBe('Bearer sk-BOUND')
  })

  // What a route with a bound credential actually puts on the wire: its own key, at its own
  // endpoint, with the ambient one exported the whole time and never consulted.
  it('authenticates with the bound credential and no other', async () => {
    await run(routeDecl({ route: 'openai', credentialRef: 'secret://agnes/openai' }), 'sk-BOUND')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]?.url).toBe('https://gw.invalid/v1/chat/completions')
    for (const c of calls) expect(c.authorization).toBe('Bearer sk-BOUND')
  })
})

/**
 * The schema bounds the length of `baseUrl` and nothing else, so an empty string is a valid route
 * declaration. The wire library reads an absent base URL as "use the vendor's default": a route that
 * declared no endpoint at all would send the deployment's own credential to a vendor's production
 * API over the public internet. That is caught at assembly now, so there is no request to record.
 */
describe('a route has to declare where it points', () => {
  const withBaseUrl = (baseUrl: string): ManualRoute => ({ ...routeDecl({ route: 'gw' }), baseUrl })

  for (const bad of ['', '   ', '/v1', 'api.openai.com/v1', 'ftp://gw.invalid/v1', 'file:///etc']) {
    it(`refuses ${JSON.stringify(bad)} at construction`, () => {
      expect(() => new PiAdapter({ manualRoutes: [withBaseUrl(bad)] })).toThrowError(AiSetupError)
      expect(() => new PiAdapter({ manualRoutes: [withBaseUrl(bad)] })).toThrowError(/INVALID_BASE_URL/)
    })
  }

  // And the rejected value never appears in the message, because a base URL is a plausible hiding
  // place for a token and this error is going to be logged.
  it('names the route and not the endpoint', () => {
    let caught: unknown
    try {
      new PiAdapter({ manualRoutes: [withBaseUrl('sk-INSIDE')] })
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message).toContain('gw')
    expect((caught as Error).message).not.toContain('sk-INSIDE')
  })

  // Userinfo parses as an absolute http URL, and it is a credential: the client sends it as Basic
  // auth. Accepting it puts a secret inline in the route table — the one place a credential may not
  // be, because every other one arrives through `credentialRef` and is resolved from the store — and
  // carries it into whatever prints `routes()`.
  for (const withCredential of [
    'https://sk-SECRETTOKEN@gw.invalid/v1',
    'https://user:sk-SECRETTOKEN@gw.invalid/v1',
    'https://:sk-SECRETTOKEN@gw.invalid/v1',
  ]) {
    it(`refuses userinfo in ${withCredential.replace('sk-SECRETTOKEN', '…')}`, () => {
      let caught: unknown
      try {
        new PiAdapter({ manualRoutes: [withBaseUrl(withCredential)] })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AiSetupError)
      expect((caught as AiSetupError).detail).toEqual({ route: 'gw', reason: 'credential in the base URL' })
      // and the smuggled value does not survive into the message that reports it
      expect(`${(caught as Error).message}${(caught as Error).stack}`).not.toContain('sk-SECRETTOKEN')
    })
  }

  // A host that is a template is not a destination: the wire library drops a Vertex base URL holding
  // `{location}` and rebuilds the host out of GOOGLE_CLOUD_LOCATION, so the route would declare one
  // endpoint and reach whichever one the environment named.
  const refusedBaseUrl = (baseUrl: string): unknown => {
    try {
      new PiAdapter({ manualRoutes: [withBaseUrl(baseUrl)] })
    } catch (e) {
      return (e as AiSetupError).detail
    }
    return undefined
  }

  it('refuses a placeholder in the host', () => {
    expect(refusedBaseUrl('https://{location}-aiplatform.googleapis.com/v1')).toEqual({
      route: 'gw',
      reason: 'placeholder in the host',
    })
    // Percent-encoded, which `URL` decodes back into the hostname. The library, which tests the raw
    // string, would have kept this one; refusing it is the fail-closed side of the difference.
    expect(refusedBaseUrl('https://%7Blocation%7D-aiplatform.googleapis.com/v1')).toEqual({
      route: 'gw',
      reason: 'placeholder in the host',
    })
    // A lone brace is not a placeholder the library knows, and is refused anyway: a host with a
    // brace in it is not a host anyone meant to type.
    expect(refusedBaseUrl('https://{-aiplatform.googleapis.com/v1')).toEqual({
      route: 'gw',
      reason: 'placeholder in the host',
    })
  })

  // The library's condition is the whole trimmed string, not the host, so the host check above is
  // not the same check. `{location}` in the path is what a Vertex endpoint copied out of a vendor
  // catalogue actually looks like — `…/v1/projects/<p>/locations/{location}/…` — and with only the
  // host examined it was accepted here, after which the library discarded the base URL and sent the
  // route's credential to `aiplatform.googleapis.com`.
  it('refuses a placeholder anywhere else in the base URL', () => {
    expect(refusedBaseUrl('http://127.0.0.1:8080/{location}/v1')).toEqual({
      route: 'gw',
      reason: 'placeholder in the base URL',
    })
    expect(refusedBaseUrl('http://127.0.0.1:8080/v1/projects/p/locations/{location}/x')).toEqual({
      route: 'gw',
      reason: 'placeholder in the base URL',
    })
    expect(refusedBaseUrl('http://127.0.0.1:8080/v1?loc={location}')).toEqual({
      route: 'gw',
      reason: 'placeholder in the base URL',
    })
    expect(refusedBaseUrl('http://127.0.0.1:8080/v1#{location}')).toEqual({
      route: 'gw',
      reason: 'placeholder in the base URL',
    })
    // Leading whitespace does not hide it either: the library trims before it looks.
    expect(refusedBaseUrl('  http://127.0.0.1:8080/{location}/v1  ')).toEqual({
      route: 'gw',
      reason: 'placeholder in the base URL',
    })
    // A closing brace alone is not the placeholder, and the library keeps such a base URL, so this
    // package keeps it too — the refusal tracks the library's condition, it does not invent one.
    expect(refusedBaseUrl('http://127.0.0.1:8080/location}/v1')).toBeUndefined()
  })

  it('accepts an ordinary http and https endpoint', () => {
    expect(() => new PiAdapter({ manualRoutes: [withBaseUrl('https://gw.invalid/v1')] })).not.toThrow()
    expect(() => new PiAdapter({ manualRoutes: [withBaseUrl('http://127.0.0.1:8080')] })).not.toThrow()
  })
})

it('serializes a Host action as an OpenAI tool pair while preserving the authored request and recording the transform', async () => {
  const flashModelId = 'deepseek-v4-flash'
  const decl = routeDecl({
    route: 'gw',
    credentialRef: 'secret://agnes/test',
    models: [
      fakeModel({
        id: flashModelId,
        route: 'gw',
        api: 'openai-completions',
        baseUrl: 'https://gw.invalid/v1',
      }),
    ],
  })
  const adapter = new PiAdapter({ manualRoutes: [decl], maxRetries: 0, sleep: async () => {} })
  adapter.bindCredential('gw', 'synthetic-test-key')
  const request = fakeRequest({
    route: 'gw',
    model: flashModelId,
    messages: [
      {
        role: 'host_action',
        content: [],
        toolCalls: [{ toolUseId: 'call_host_001', name: 'read', args: { path: 'source.txt' }, ordinal: 0 }],
      },
      {
        role: 'tool_result',
        toolUseId: 'call_host_001',
        content: [{ type: 'text', text: 'Recorded file evidence' }],
        isError: false,
      },
      { role: 'user', content: [{ type: 'text', text: 'Answer from recorded evidence.' }] },
    ],
  })
  const original = structuredClone(request)
  let body: { messages?: unknown[] } | undefined
  const reports: unknown[] = []
  globalThis.fetch = async (input, init) => {
    body = (await new Request(input, init).json()) as { messages?: unknown[] }
    throw new Error('test intercepted serialized request; no network')
  }
  for await (const _event of adapter.stream('gw', request, {
    signal: new AbortController().signal,
    toolNames: ['read'],
    sessionKey: 's',
    timeoutMs: { firstToken: 1000, total: 5000 },
    reportSent: (report) => {
      reports.push(report)
    },
  })) {
    /* Consume the deliberate transport refusal after serialization. */
  }
  expect(body?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_host_001',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"source.txt"}' },
          },
        ],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call_host_001',
        content: 'Recorded file evidence',
      }),
    ]),
  )
  expect(JSON.stringify(body)).not.toContain('host_action')
  expect(reports).toEqual([expect.objectContaining({ transforms: [{ event: 'host_action', ext: 'pi' }] })])
  expect(request).toEqual(original)
})

it('keeps ordered system updates at their wire positions without changing the earlier prefix, and does not revive cleared instructions', async () => {
  const flashModelId = 'deepseek-v4-flash'
  const decl = routeDecl({
    route: 'gw',
    credentialRef: 'secret://agnes/test',
    models: [
      fakeModel({
        id: flashModelId,
        route: 'gw',
        api: 'openai-completions',
        baseUrl: 'https://gw.invalid/v1',
        reasoning: true,
        compat: { supportsMidConvoSystemMessages: true, supportsDeveloperRole: false },
      }),
    ],
  })
  const adapter = new PiAdapter({ manualRoutes: [decl], maxRetries: 0, sleep: async () => {} })
  adapter.bindCredential('gw', 'synthetic-test-key')
  const base = fakeRequest({ route: 'gw', model: flashModelId, system: 'Fixed Host policy' })
  const first: RequestMessage[] = [
    { role: 'system', content: [{ type: 'text', text: 'Policy A' }] },
    { role: 'user', content: [{ type: 'text', text: 'Task at A' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Observed response at A' }] },
  ]
  const update: RequestMessage = { role: 'system', content: [{ type: 'text', text: 'Policy B' }] }
  const tail: RequestMessage = {
    role: 'user',
    content: [{ type: 'text', text: 'Stable answer instruction' }],
  }
  const current = [...first, update]
  const cleared = current.filter((message) => message.role !== 'system')
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  globalThis.fetch = async (input, init) => {
    bodies.push((await new Request(input, init).json()) as (typeof bodies)[number])
    throw new Error('test intercepted serialized request; no network')
  }
  for (const messages of [
    [...first, tail],
    [...current, tail],
    [...cleared, tail],
    [...cleared, update, tail],
  ]) {
    for await (const _event of adapter.stream(
      'gw',
      { ...base, messages },
      {
        signal: new AbortController().signal,
        toolNames: [],
        sessionKey: 's',
        timeoutMs: { firstToken: 1000, total: 5000 },
      },
    )) {
      /* The real serializer reaches the intercepted fetch and stops. */
    }
  }
  expect(bodies).toHaveLength(4)
  const [before, after, empty, restored] = bodies.map((body) => body.messages)
  if (!before || !after || !empty || !restored) throw new Error('Missing serialized prefix')
  expect(before.map((message) => message.role)).toEqual(['system', 'system', 'user', 'assistant', 'user'])
  expect(after.map((message) => message.role)).toEqual([
    'system',
    'system',
    'user',
    'assistant',
    'system',
    'user',
  ])
  expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1))
  expect(JSON.stringify(before)).not.toContain('Policy B')
  expect(empty).toEqual(
    after.filter((message) => message.role !== 'system' || message.content === 'Fixed Host policy'),
  )
  expect(restored.slice(0, -2)).toEqual(empty.slice(0, -1))
  expect(restored.at(-2)).toEqual({ role: 'system', content: 'Policy B' })
  expect(JSON.stringify(empty)).not.toContain('Policy A')
  expect(JSON.stringify(empty)).not.toContain('Policy B')
})
