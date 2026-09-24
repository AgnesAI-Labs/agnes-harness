import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ManualRoute } from '../src/adapters/pi/index.js'
import type { WireEvent } from '../src/index.js'
import { PiAdapter } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'
import { assertLoopbackOnly, installLoopbackOnly, restoreLoopbackOnly } from './loopback-only.js'

/**
 * Where a request goes, as opposed to what it carries.
 *
 * The sibling file asks whether an ambient *credential* can reach the wire. This one asks the
 * question one level up, which is the one that was missed: does any option or environment variable
 * outrank the endpoint the route declared? It did on one api — `azure-openai-responses` resolved
 * `azureBaseUrl` then AZURE_OPENAI_BASE_URL then AZURE_OPENAI_RESOURCE_NAME and only then
 * `model.baseUrl`, so with either variable exported the route's own credential went to a host the
 * environment named and the declared endpoint was never contacted.
 *
 * So every api is asked the same way, and by measurement rather than by reading: two loopback
 * servers, DECLARED and ELSEWHERE, every destination-shaped variable pointed at ELSEWHERE, and the
 * assertion is which server was contacted.
 *
 * Nothing can leave the machine, and that is enforced at the socket rather than by the variable
 * list: `installLoopbackOnly()` refuses every outbound connection to anything but loopback, so an
 * api redirected through a variable nobody enumerated fails here instead of quietly succeeding. The
 * `fetch` wrapper below is kept for the readable message it produces, but it is no longer the
 * control — it never saw `bedrock-converse-stream`, whose client builds requests with its own node
 * http handler, and it cannot see an HTTP CONNECT tunnel at all.
 */

type Hit = {
  where: Where
  kind: 'request' | 'upgrade'
  url: string
  headers: Record<string, string>
  body: string
}
type Where = 'DECLARED' | 'ELSEWHERE'

let hits: Hit[] = []
let blocked: string[] = []

function record(
  where: Where,
  kind: 'request' | 'upgrade',
  url: string,
  headers: Record<string, unknown>,
  body: string,
) {
  hits.push({
    where,
    kind,
    url,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
    body,
  })
}

function listen(where: Where): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      record(where, 'request', req.url ?? '', req.headers, Buffer.concat(chunks).toString('utf8'))
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"message":"the test answered this"}')
    })
  })
  // A WebSocket handshake arrives here and not on the request handler, so a recorder without this
  // cannot see the transport `openai-codex-responses` tries first.
  server.on('upgrade', (req, socket) => {
    record(where, 'upgrade', req.url ?? '', req.headers, '')
    socket.destroy()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      resolve({ server, port: typeof a === 'object' && a !== null ? a.port : 0 })
    })
  })
}

let servers: Server[] = []
let declaredPort = 0
let elsewherePort = 0
let originalFetch: typeof globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** Every variable any of the ten apis, or the SDK under it, reads for a destination. */
const DESTINATION_VARS = [
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_BASE_URL',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
  'GEMINI_NEXT_GEN_API_BASE_URL',
  'MISTRAL_BASE_URL',
  'PI_BASE_URL',
  'CODEX_BASE_URL',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
]

const APIS = [
  'anthropic-messages',
  'azure-openai-responses',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'mistral-conversations',
  'openai-codex-responses',
  'openai-completions',
  'openai-responses',
  'pi-messages',
] as const

/**
 * `openai-codex-responses` reads an account id out of its key and throws on anything that is not a
 * JWT, so it never reaches the wire with an ordinary string. This is a syntactically valid token
 * with no signature and no secret in it — it exists only so that this api can be asked the same
 * question as the other nine.
 */
const codexKey = (): string => {
  const claims = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-for-the-test' } }),
  ).toString('base64url')
  return `notaheader.${claims}.notasignature`
}

beforeAll(async () => {
  installLoopbackOnly()
  const declared = await listen('DECLARED')
  const elsewhere = await listen('ELSEWHERE')
  servers = [declared.server, elsewhere.server]
  declaredPort = declared.port
  elsewherePort = elsewhere.port

  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== '127.0.0.1') {
      blocked.push(url.hostname)
      throw new Error(`the test blocked a request to ${url.hostname}`)
    }
    return originalFetch(input, init)
  }) as typeof globalThis.fetch

  for (const key of DESTINATION_VARS) setEnv(key, `http://127.0.0.1:${elsewherePort}/stolen`)
  setEnv('AZURE_OPENAI_RESOURCE_NAME', undefined)
  setEnv('AZURE_OPENAI_DEPLOYMENT_NAME_MAP', undefined)
  setEnv('AWS_REGION', 'us-east-1')
  setEnv('AWS_PROFILE', undefined)
  // Transport knobs, not destinations: the AWS client defaults to HTTP/2, which `node:http` does not
  // speak, and the EC2 metadata service must not be reached for a credential.
  setEnv('AWS_BEDROCK_FORCE_HTTP1', '1')
  setEnv('AWS_EC2_METADATA_DISABLED', 'true')
  setEnv('GCE_METADATA_HOST', `127.0.0.1:${declaredPort}`)
  setEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined)
  setEnv('GOOGLE_CLOUD_PROJECT', 'proj-for-the-test')
  setEnv('GOOGLE_CLOUD_LOCATION', 'us-central1')
})

afterAll(async () => {
  restoreLoopbackOnly()
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
})

afterEach(() => {
  hits = []
  blocked = []
  // Whatever the body of the test asserted, this is the one that cannot be satisfied by contacting
  // nothing: any connection attempted off this machine, on any transport, fails the test that made
  // it — including one whose client caught the guard's own throw.
  assertLoopbackOnly()
})

const declaredUrl = () => `http://127.0.0.1:${declaredPort}`

const run = async (api: string, credential: string, baseUrl = declaredUrl()): Promise<WireEvent[]> => {
  const decl: ManualRoute = {
    route: 'gw',
    api,
    baseUrl,
    credentialRef: 'secret://agnes/gw',
    models: [fakeModel({ id: 'm1', route: 'gw', api, baseUrl })],
  }
  const adapter = new PiAdapter({ manualRoutes: [decl], maxRetries: 0, sleep: async () => {} })
  adapter.bindCredential('gw', credential)
  const out: WireEvent[] = []
  for await (const event of adapter.stream('gw', fakeRequest({ route: 'gw', model: 'm1' }), {
    signal: new AbortController().signal,
    toolNames: [],
    sessionKey: 'agnes:t:a:cli:dm:x',
    timeoutMs: { firstToken: 2000, total: 8000 },
  })) {
    out.push(event)
  }
  return out
}

describe('the request goes to the endpoint the route declared', () => {
  for (const api of APIS) {
    it(`${api} contacts only the declared endpoint`, async () => {
      const credential = api === 'openai-codex-responses' ? codexKey() : 'BOUND-KEY'
      await run(api, credential)
      // Reaching the wire at all is half the assertion: an api that threw before building a client
      // would trivially contact nothing, and would say nothing about precedence.
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.filter((h) => h.where === 'ELSEWHERE')).toEqual([])
      // Nothing was attempted off this machine either. This list only holds what went through
      // `fetch`, which is why it says nothing at all for `bedrock-converse-stream`; the socket guard
      // in `afterEach` is what covers every api uniformly.
      expect(blocked).toEqual([])
      // The two options that pin the destination are read by the client that builds the request;
      // an api that forwarded its options into the payload would put them on the wire instead.
      for (const hit of hits) expect(hit.body).not.toContain('azureBaseUrl')
    })
  }

  // The api that failed this. With the declared endpoint passed as `azureBaseUrl` — the first thing
  // the api looks at — AZURE_OPENAI_BASE_URL no longer outranks it. Without that, the only request
  // this makes is to ELSEWHERE.
  it('azure ignores AZURE_OPENAI_BASE_URL', async () => {
    await run('azure-openai-responses', 'DEPLOYMENT-KEY')
    expect(hits.map((h) => `${h.where}${h.url}`)).toEqual(['DECLARED/responses?api-version=v1'])
    expect(hits[0]?.headers['api-key'] ?? hits[0]?.headers.authorization).toContain('DEPLOYMENT-KEY')
  })

  // The same api's other route to the same place: with no base-url variable set, an exported
  // resource name resolved to https://<name>.openai.azure.com and sent the deployment's key there.
  // Nothing is blocked now because nothing is attempted.
  it('azure ignores AZURE_OPENAI_RESOURCE_NAME', async () => {
    setEnv('AZURE_OPENAI_BASE_URL', undefined)
    setEnv('AZURE_OPENAI_RESOURCE_NAME', 'a-resource-the-route-never-named')
    try {
      await run('azure-openai-responses', 'DEPLOYMENT-KEY')
    } finally {
      setEnv('AZURE_OPENAI_RESOURCE_NAME', undefined)
      setEnv('AZURE_OPENAI_BASE_URL', `http://127.0.0.1:${elsewherePort}/stolen`)
    }
    expect(blocked).toEqual([])
    expect(hits.map((h) => h.where)).toEqual(['DECLARED'])
  })

  // Same shape, lower stakes: the deployment name is part of what the request asks for, and the same
  // api took it from AZURE_OPENAI_DEPLOYMENT_NAME_MAP unless it was given one. The consequence of
  // pinning it is that the map is no longer honoured — a deployment that renames a model says so in
  // its catalogue record, where the rest of the route table can see it.
  it('azure asks for the declared model, not the one the environment maps it to', async () => {
    setEnv('AZURE_OPENAI_DEPLOYMENT_NAME_MAP', 'm1=some-other-deployment')
    try {
      await run('azure-openai-responses', 'DEPLOYMENT-KEY')
    } finally {
      setEnv('AZURE_OPENAI_DEPLOYMENT_NAME_MAP', undefined)
    }
    expect(hits.length).toBe(1)
    expect(JSON.parse(hits[0]?.body ?? '{}').model).toBe('m1')
  })

  /**
   * The other api whose destination the environment could take, and the one place where refusing at
   * assembly is the whole fix. `google-vertex` discards a base URL holding `{location}` anywhere in
   * it — path and query included, not only the host — and rebuilds the destination out of
   * GOOGLE_CLOUD_LOCATION, which is `aiplatform.googleapis.com`. So the templated route never gets
   * to stream: it fails at construction, and the measurement is that nothing was contacted at all.
   */
  it('vertex refuses a templated base URL instead of resolving it out of the environment', async () => {
    for (const baseUrl of [
      `${declaredUrl()}/{location}/v1`,
      `${declaredUrl()}/v1/projects/p/locations/{location}/x`,
      `${declaredUrl()}/v1?loc={location}`,
    ]) {
      await expect(run('google-vertex', 'BOUND-KEY', baseUrl)).rejects.toThrow()
      expect(hits).toEqual([])
    }
    // and the same route without the placeholder does reach the declared endpoint
    await run('google-vertex', 'BOUND-KEY')
    expect(hits.map((h) => h.where)).toContain('DECLARED')
  })

  /**
   * F15, pinned rather than fixed, and the one answer in this file that is still "the environment
   * decides".
   *
   * `bedrock-converse-stream` pins `config.endpoint` to the declared base URL only when
   * `shouldUseExplicitBedrockEndpoint` says so, and for a *standard* Bedrock host — the ordinary
   * production endpoint, `bedrock-runtime.<region>.amazonaws.com` — it says so only when no region
   * and no profile are configured. An ambient AWS_REGION is enough to make it stop pinning, and the
   * AWS SDK then resolves the endpoint itself, consulting AWS_ENDPOINT_URL_BEDROCK_RUNTIME and
   * AWS_ENDPOINT_URL. So on a standard host the declared endpoint is advisory and the bound
   * credential follows the environment, which is what this records by arriving at ELSEWHERE.
   *
   * It cannot be closed from here. Passing a region makes `configuredRegion` truthy, which is one of
   * the two things that turns the pinning *off*; there is no option on the library's surface that
   * sets the endpoint unconditionally, and writing a process-wide AWS variable would re-import the
   * environment dependency this work removed.
   *
   * The ruling, taken with the error mapping: the behaviour stays, and the obligation stays on the
   * deployment. Refusing a standard Bedrock host at construction was the alternative, and it would
   * refuse the ordinary direct-to-Bedrock configuration - which this package cannot tell apart from
   * one fronted by a gateway - so the fix would cost more deployments than it protects. What this
   * package does instead is state the obligation where an operator meets it: the deployment notes at
   * the head of the adapter name the variables to clear and the one to set. If that turns out to be
   * unheeded in practice, the next step is an opt-in on the route declaration, not a silent pin.
   */
  it('bedrock at a standard host follows the environment, not the declaration', async () => {
    await run('bedrock-converse-stream', 'BOUND-KEY', 'https://bedrock-runtime.us-east-1.amazonaws.com')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.where === 'ELSEWHERE')).toBe(true)
    // What keeps this arm off the real Bedrock endpoint is that AWS_ENDPOINT_URL_BEDROCK_RUNTIME is
    // honoured. If a future SDK stopped honouring it, the socket guard in `afterEach` refuses the
    // connection before it is made; without the guard the first symptom would have been a real
    // request to `bedrock-runtime.us-east-1.amazonaws.com` and a red test afterwards.
  })

  // And with any other host the endpoint is pinned, which is every private deployment: the same two
  // variables are exported here and the request still arrives at the declared endpoint.
  it('bedrock at any other host is pinned to the declaration', async () => {
    await run('bedrock-converse-stream', 'BOUND-KEY')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.where === 'DECLARED')).toBe(true)
  })
})

/**
 * The other half of the same question, asked adversarially: with a credential for every api family
 * exported into the environment, does a route that bound nothing reach anything at all?
 *
 * A refusal on its own would prove very little - an adapter that refused every request would pass
 * this and be useless - so each case here is the negative twin of a case above, which shows the same
 * api reaching DECLARED once a credential is properly bound. The pair is the claim: bound reaches
 * the endpoint it named, unbound reaches nothing.
 *
 * The socket guard in `afterEach` still applies, so a route that found a way off this machine fails
 * here even if the assertions below were satisfied.
 */
describe('a route that bound no credential reaches nothing, with one exported for every api', () => {
  const AMBIENT_VARS = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'MISTRAL_API_KEY',
    'PI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ]
  const ambientSaved: Record<string, string | undefined> = {}

  beforeAll(() => {
    for (const key of AMBIENT_VARS) {
      ambientSaved[key] = process.env[key]
      process.env[key] = 'sk-AMBIENT-MUST-NOT-TRAVEL'
    }
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(ambientSaved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const unbound = async (decl: Partial<ManualRoute> & { api: string }): Promise<WireEvent[]> => {
    const baseUrl = declaredUrl()
    const adapter = new PiAdapter({
      manualRoutes: [
        {
          route: 'gw',
          baseUrl,
          models: [fakeModel({ id: 'm1', route: 'gw', api: decl.api, baseUrl })],
          ...decl,
        } as ManualRoute,
      ],
      maxRetries: 0,
      sleep: async () => {},
    })
    const out: WireEvent[] = []
    for await (const event of adapter.stream('gw', fakeRequest({ route: 'gw', model: 'm1' }), {
      signal: new AbortController().signal,
      toolNames: [],
      sessionKey: 'agnes:t:a:cli:dm:x',
      timeoutMs: { firstToken: 2000, total: 8000 },
    }))
      out.push(event)
    return out
  }

  for (const api of APIS) {
    it(`${api} does not open a socket for a route that bound nothing`, async () => {
      const events = await unbound({ api })
      expect(events).toEqual([
        { type: 'error', reason: 'error', code: 'AUTH', message: 'route=gw', retryable: false },
      ])
      expect(hits).toEqual([])
      expect(blocked).toEqual([])
    })
  }

  // On these two apis the client authenticates from the host itself, so `keyless` does not describe
  // a request without a credential - it describes one carrying the deployment's own cloud identity
  // to whatever endpoint the route named. The declaration is refused rather than obeyed, and the
  // proof is that no socket is opened even though the environment is holding an AWS identity.
  for (const api of ['bedrock-converse-stream', 'google-vertex']) {
    it(`${api} refuses a keyless declaration rather than signing with the host identity`, async () => {
      const events = await unbound({ api, keyless: true })
      expect(events[0]).toMatchObject({ type: 'error', code: 'AUTH', retryable: false })
      expect((events[0] as { message: string }).message).toContain('keyless refused')
      expect(hits).toEqual([])
      expect(blocked).toEqual([])
    })
  }

  // A keyless declaration on an ordinary api does not borrow the exported key either: the wire
  // library refuses to send an unauthenticated request at all, which reads here as an auth failure
  // rather than as a request that went out bare. Measured, not assumed - the recorder is watching.
  it('a keyless route on an ordinary api sends nothing rather than borrowing the exported key', async () => {
    const events = await unbound({ api: 'openai-completions', keyless: true })
    expect(events[0]).toMatchObject({ type: 'error', code: 'AUTH', retryable: false })
    expect(hits).toEqual([])
    expect(blocked).toEqual([])
  })

  // The positive control for every refusal above: the same environment, the same endpoint, and a
  // route that did bind a credential reaches DECLARED - carrying its own key and not the exported
  // one. Without this the whole block would be satisfied by an adapter that refused everything.
  it('a route that bound a credential still reaches its endpoint, carrying only what it was handed', async () => {
    await run('openai-completions', 'sk-BOUND-FOR-THIS-ROUTE')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.where === 'DECLARED')).toBe(true)
    for (const hit of hits) {
      expect(hit.headers.authorization).toContain('sk-BOUND-FOR-THIS-ROUTE')
      expect(`${JSON.stringify(hit.headers)}${hit.body}`).not.toContain('sk-AMBIENT-MUST-NOT-TRAVEL')
    }
  })
})
