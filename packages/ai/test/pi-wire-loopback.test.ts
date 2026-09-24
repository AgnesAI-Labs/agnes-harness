import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ManualRoute } from '../src/adapters/pi/index.js'
import { toContext } from '../src/adapters/pi/to-context.js'
import { streamOverApi } from '../src/adapters/pi/wire.js'
import type { WireEvent } from '../src/index.js'
import { PiAdapter, toPiModel } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'
import { assertLoopbackOnly, installLoopbackOnly, restoreLoopbackOnly } from './loopback-only.js'

/**
 * Two of the ten apis are driven by vendor SDKs that never call `globalThis.fetch`: the AWS one
 * speaks HTTP itself and the Google one goes through its own auth client. A fetch recorder — the
 * harness the rest of these tests use — cannot see either, which is why an ambient credential
 * survived a round of fixes on this exact question. So this file records at the socket instead: the
 * route's declared endpoint is a real server bound to 127.0.0.1, and a request is observed by
 * arriving.
 *
 * Nothing here can leave the machine, and that is enforced rather than arranged. Every endpoint is
 * the literal loopback address, so no name is resolved and no route off the host is taken; the
 * Google metadata service is pointed at the same loopback port, so the ADC chain mints its token
 * here rather than at the link-local address; the EC2 metadata service is disabled for the same
 * reason. Underneath all of that, `installLoopbackOnly()` refuses any outbound connection to
 * anything but loopback at the socket, which is the only place that sees every transport — the
 * `fetch` wrapper below cannot see the AWS client's own http handler, and neither wrapper sees an
 * HTTP CONNECT tunnel. A mistake in any of the arrangements above is a failure, not a packet.
 *
 * The environment is poisoned with a marker instead of a plausible credential, so a leak is a string
 * search rather than a judgement, and nothing that looks like a real secret is ever in play.
 */
const MARKER = 'AMBIENT-MARKER-DO-NOT-SEND'

type Hit = { url: string; headers: Record<string, string> }

let server: Server
let port = 0
let hits: Hit[] = []
let originalFetch: typeof globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const baseUrl = () => `http://127.0.0.1:${port}`

beforeAll(async () => {
  installLoopbackOnly()
  server = createServer((req, res) => {
    hits.push({
      url: req.url ?? '',
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
    })
    // The Google auth client asks the metadata service for a token before it signs anything. Answer
    // it, so the chain runs to completion and the credential it mints is observable on the request
    // that follows — a refusal here would hide the very thing being measured.
    if ((req.url ?? '').includes('/computeMetadata/')) {
      res.writeHead(200, { 'content-type': 'application/json', 'metadata-flavor': 'Google' })
      res.end(JSON.stringify({ access_token: `gcp-${MARKER}`, expires_in: 3600, token_type: 'Bearer' }))
      return
    }
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"message":"the test answered this"}')
  })
  // A third transport, and the third time this recorder has had to grow to see one. `node:http`
  // delivers a WebSocket handshake on `upgrade` and not to the request handler, so a recorder made
  // of `createServer(handler)` alone is blind to it — the same shape of blindness that let the two
  // SDK-driven apis bypass a `fetch` recorder. `openai-codex-responses` tries a WebSocket before it
  // falls back to SSE. Nothing hides behind it today, and this is here so that the next thing cannot.
  server.on('upgrade', (req, socket) => {
    hits.push({
      url: `upgrade:${req.url ?? ''}`,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
    })
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0

  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== '127.0.0.1') throw new Error(`the test blocked a request to ${url.hostname}`)
    return originalFetch(input, init)
  }) as typeof globalThis.fetch

  setEnv('AWS_ACCESS_KEY_ID', `AKIA${MARKER}`)
  setEnv('AWS_SECRET_ACCESS_KEY', `sec-${MARKER}`)
  setEnv('AWS_SESSION_TOKEN', `tok-${MARKER}`)
  setEnv('AWS_REGION', 'us-east-1')
  setEnv('AWS_PROFILE', undefined)
  setEnv('AWS_BEARER_TOKEN_BEDROCK', undefined)
  setEnv('AWS_BEDROCK_SKIP_AUTH', undefined)
  // The AWS client defaults to HTTP/2, which a plain `node:http` server does not speak. This is a
  // transport knob, not a credential, and it only decides how the recorder is reached.
  setEnv('AWS_BEDROCK_FORCE_HTTP1', '1')
  setEnv('AWS_EC2_METADATA_DISABLED', 'true')
  setEnv('GCE_METADATA_HOST', `127.0.0.1:${port}`)
  setEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined)
  setEnv('GOOGLE_CLOUD_PROJECT', `proj-${MARKER}`)
  setEnv('GOOGLE_CLOUD_LOCATION', 'us-central1')
})

afterAll(async () => {
  restoreLoopbackOnly()
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  hits = []
  assertLoopbackOnly()
})

/** Every header of every recorded request, as one string to search for the marker in. */
const allHeaders = () => hits.map((h) => JSON.stringify(h.headers)).join('\n')

const route = (api: string, over: Partial<ManualRoute> = {}): ManualRoute => ({
  route: 'gw',
  api,
  baseUrl: baseUrl(),
  models: [fakeModel({ id: 'm1', route: 'gw', api, baseUrl: baseUrl() })],
  ...over,
})

const runAdapter = async (decl: ManualRoute, credential?: string): Promise<WireEvent[]> => {
  const adapter = new PiAdapter({ manualRoutes: [decl], maxRetries: 0, sleep: async () => {} })
  if (credential !== undefined) adapter.bindCredential(decl.route, credential)
  const out: WireEvent[] = []
  for await (const event of adapter.stream(decl.route, fakeRequest({ route: decl.route, model: 'm1' }), {
    signal: new AbortController().signal,
    toolNames: [],
    sessionKey: 'agnes:t:a:cli:dm:x',
    timeoutMs: { firstToken: 1000, total: 5000 },
  })) {
    out.push(event)
  }
  return out
}

/** The wire path with the adapter's gate stepped around, to show what the gate is holding back. */
const runLibraryDirectly = async (api: string): Promise<void> => {
  const decl = { route: 'gw', api, baseUrl: baseUrl() }
  const model = toPiModel(decl, fakeModel({ id: 'm1', route: 'gw', api, baseUrl: baseUrl() }))
  const { context } = toContext(fakeRequest({ route: 'gw', model: 'm1' }))
  try {
    for await (const _event of streamOverApi(model, context, {
      signal: new AbortController().signal,
      maxRetries: 0,
    })) {
      // drained; the recorder answers 500 and the events are not what is under test
    }
  } catch {
    // A failed request is expected. What it carried on the way out is the measurement.
  }
}

describe('the two apis whose SDK authenticates from the host environment', () => {
  // Why `keyless` cannot be honoured here, shown rather than asserted: given no key, the AWS client
  // signs with whatever identity the host exports and sends it to the endpoint the route declared.
  it('bedrock signs an unkeyed request with the host AWS identity', async () => {
    await runLibraryDirectly('bedrock-converse-stream')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.headers.authorization).toContain(`Credential=AKIA${MARKER}`)
    expect(hits[0]?.headers['x-amz-security-token']).toBe(`tok-${MARKER}`)
  })

  // The Google client is worse than a fallback: it walks the whole ADC chain, mints a fresh token
  // at the metadata service and puts that on the request.
  it('vertex mints a token from the metadata service for an unkeyed request', async () => {
    await runLibraryDirectly('google-vertex')
    const minted = hits.find((h) => h.headers.authorization !== undefined)
    expect(hits.some((h) => h.url.includes('/computeMetadata/'))).toBe(true)
    expect(minted?.headers.authorization).toBe(`Bearer gcp-${MARKER}`)
  })
})

describe('the adapter refuses keyless on those two apis', () => {
  for (const api of ['bedrock-converse-stream', 'google-vertex']) {
    it(`refuses a keyless route declaring ${api}`, async () => {
      const events = await runAdapter(route(api, { keyless: true }))
      expect(hits).toEqual([])
      expect(events).toEqual([
        {
          type: 'error',
          reason: 'error',
          code: 'AUTH',
          message: `route=gw api=${api} keyless refused: this api authenticates from the host environment`,
          retryable: false,
        },
      ])
    })
  }

  // The refusal is about the declaration, not about whether a credential happens to be bound: a
  // route may not both claim to need none and be handed one.
  it('refuses a keyless bedrock route even with a credential bound', async () => {
    const events = await runAdapter(route('bedrock-converse-stream', { keyless: true }), 'bed-BOUND')
    expect(hits).toEqual([])
    expect(events[0]).toMatchObject({ code: 'AUTH', retryable: false })
  })
})

describe('a bound credential still reaches the wire on both apis', () => {
  // The positive control for this recorder. Without it, "zero requests" above would be indis-
  // tinguishable from a harness that cannot see these SDKs — which is how the hole survived before.
  it('bedrock sends the bound credential and no ambient one', async () => {
    await runAdapter(route('bedrock-converse-stream', { credentialRef: 'secret://agnes/bed' }), 'bed-BOUND')
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) {
      expect(hit.url).toBe('/model/m1/converse-stream')
      expect(hit.headers.authorization).toBe('Bearer bed-BOUND')
    }
    expect(allHeaders()).not.toContain(MARKER)
  })

  it('vertex sends the bound credential and no ambient one', async () => {
    await runAdapter(route('google-vertex', { credentialRef: 'secret://agnes/gv' }), 'gv-BOUND')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.url.startsWith('/v1/publishers/google/models/m1:'))).toBe(true)
    expect(hits[0]?.headers['x-goog-api-key']).toBe('gv-BOUND')
    expect(allHeaders()).not.toContain(MARKER)
  })

  // The positive control for the `upgrade` listener, and the only api that exercises it. A key that
  // is not a JWT throws before any transport opens, so this one is shaped like a token and carries
  // nothing: the point is only to get the WebSocket attempt made, and then recorded.
  it('records the WebSocket handshake codex tries before falling back', async () => {
    const claims = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-for-the-test' } }),
    ).toString('base64url')
    const key = `notaheader.${claims}.notasignature`
    await runAdapter(route('openai-codex-responses', { credentialRef: 'secret://agnes/codex' }), key)
    expect(hits.map((h) => h.url)).toEqual(['upgrade:/codex/responses', '/codex/responses'])
    for (const hit of hits) expect(hit.headers.authorization).toBe(`Bearer ${key}`)
    expect(allHeaders()).not.toContain(MARKER)
  })

  // F10, pinned rather than fixed. `maxRetries: 0` is passed on every request, and the bedrock
  // implementation never reads it into the AWS client's config — there is no option on the library's
  // surface that does, so the adapter cannot switch this loop off from here. Until the library wires
  // it, one call to `stream()` is three requests, and the adapter's rule that it alone decides
  // whether a failure may be repeated does not hold on this one api. The count is asserted so that a
  // library that starts honouring it shows up here instead of passing unnoticed.
  //
  // What is owed is a bound, not a curiosity. This loop sits *under* the adapter's own, which repeats
  // a retryable failure up to `maxRetries` times — 2 by default — so one turn against a failing
  // bedrock endpoint is up to nine requests: nine times the intended latency and nine times the
  // intended spend. `maxRetries: 0` is passed here to isolate the SDK's three; a real turn does not
  // pass it. That multiplication, rather than the three, is what a later task has to rule on.
  it('cannot switch off the bedrock SDK retry loop', async () => {
    await runAdapter(route('bedrock-converse-stream', { credentialRef: 'secret://agnes/bed' }), 'bed-BOUND')
    expect(hits.length).toBe(3)
  })
})
