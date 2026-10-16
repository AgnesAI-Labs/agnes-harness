import type { RequestBody } from '@agnes/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { WireEvent } from '../src/index.js'
import { JEV_WIRE_API, JevAdapter } from '../src/index.js'
import type { FakeSystemOne, FakeSystemOneScript } from '../testkit/index.js'
import {
  assertLoopbackOnly,
  fakeModel,
  installLoopbackOnly,
  restoreLoopbackOnly,
  SYSTEMONE_ERROR_BODIES,
  startFakeSystemOne,
} from '../testkit/index.js'

/**
 * The adapter against real sockets on 127.0.0.1, through its default network layer: the deployment
 * pool, with keep-alive. The things a scripted fetch cannot show are shown here - connection reuse,
 * what the server sees when the pool closes, a redirect that must not carry the key, a body that
 * never ends, a body that is too long, a connection that dies halfway.
 */
const KEY = 'TEST-KEY-0123456789'
const MODEL = 'typesafe/jev-1.13-20260917'
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const PAYLOAD = {
  state: { step: 1 },
  questions: {
    q1: { type: 'choice', criteria: { a: 'A', b: 'B' } },
    q2: { type: 'score', criteria: ['low', 'mid', 'high'] },
  },
}

const savedEnv = new Map<string, string | undefined>()
const fakes: FakeSystemOne[] = []
const adapters: JevAdapter[] = []

beforeAll(() => {
  installLoopbackOnly()
  // The pool honours the proxy variables, which would send even loopback traffic through a proxy
  // configured on the machine running the tests.
  for (const key of PROXY_VARIABLES) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  savedEnv.set('NO_PROXY', process.env.NO_PROXY)
  process.env.NO_PROXY = '127.0.0.1,localhost'
})

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restoreLoopbackOnly()
})

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.dispose()))
  await Promise.all(fakes.splice(0).map((f) => f.close()))
  assertLoopbackOnly()
})

async function start(script?: FakeSystemOneScript) {
  const fake = await startFakeSystemOne(script)
  fakes.push(fake)
  return fake
}

function adapterFor(baseUrl: string) {
  const adapter = new JevAdapter({
    routes: [
      {
        route: 'jev',
        api: JEV_WIRE_API,
        baseUrl,
        credentialRef: 'secret://jev/key',
        models: [fakeModel({ id: MODEL, route: 'jev', api: JEV_WIRE_API, baseUrl })],
      },
    ],
  })
  adapter.bindCredential('jev', KEY)
  adapters.push(adapter)
  return adapter
}

const request = (): RequestBody => ({
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
})

async function call(adapter: JevAdapter, signal: AbortSignal = new AbortController().signal) {
  const events: WireEvent[] = []
  for await (const event of adapter.stream('jev', request(), {
    signal,
    toolNames: [],
    sessionKey: 'agnes:t:a:cli:dm:x',
    timeoutMs: { firstToken: 10_000, total: 10_000 },
  }))
    events.push(event)
  return events
}

const types = (events: WireEvent[]) => events.map((e) => e.type)
const errorOf = (events: WireEvent[]) =>
  events.find((e) => e.type === 'error') as Extract<WireEvent, { type: 'error' }>

// The pool hands a connection back a tick after the body is read, so a call issued in that same
// tick opens a second one. Calls in practice are separated by a model call; the tests leave a gap.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('a successful call over a real socket', () => {
  it('posts the vendor body with the key and returns the answers', async () => {
    const fake = await start()
    const events = await call(adapterFor(fake.url))
    expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
    const [seen] = fake.seen
    expect(seen).toMatchObject({ method: 'POST', path: '/v1/systemone', authorization: `Bearer ${KEY}` })
    expect(seen?.body).toEqual({ model: MODEL, ...PAYLOAD })
    const answers = JSON.parse((events[0] as { delta: string }).delta)
    expect(Object.keys(answers)).toEqual(['q1', 'q2'])
    expect(events[1]).toMatchObject({
      tokens: { input: 180, output: 9 },
      billing: { usdMicros: 8, source: 'gateway', subscription: false },
      response: { status: 200, model: MODEL },
    })
  })

  it('reports each vendor failure from the service the way it answers', async () => {
    const fake = await start(
      (n) =>
        [
          { status: 400, body: SYSTEMONE_ERROR_BODIES.overflow },
          { status: 400, body: SYSTEMONE_ERROR_BODIES.noModel },
          { status: 400, body: SYSTEMONE_ERROR_BODIES.validation },
          { status: 401, body: SYSTEMONE_ERROR_BODIES.auth },
        ][n] ?? {},
    )
    const adapter = adapterFor(fake.url)
    const codes: string[] = []
    for (let i = 0; i < 4; i++) {
      const events = await call(adapter)
      expect(types(events)).toEqual(['usage', 'error'])
      codes.push(errorOf(events).code)
      expect(JSON.stringify(events)).not.toMatch(/user_|Model typesafe/)
    }
    expect(codes).toEqual(['OVERFLOW', 'NO_MODEL', 'CONTRACT_MISMATCH', 'AUTH'])
  })
})

describe('the connection pool', () => {
  it('reuses one connection for consecutive calls', async () => {
    const fake = await start()
    const adapter = adapterFor(fake.url)
    for (let i = 0; i < 3; i++) {
      expect(types(await call(adapter))).toEqual(['text_delta', 'usage', 'done'])
      await settle()
    }
    expect(fake.seen).toHaveLength(3)
    expect(fake.accepts()).toBe(1)
    expect(new Set(fake.seen.map((s) => s.socket)).size).toBe(1)
  })

  it('opens a new connection after the server recycles an idle one', async () => {
    const fake = await start()
    const adapter = adapterFor(fake.url)
    expect(types(await call(adapter))).toEqual(['text_delta', 'usage', 'done'])
    await settle()
    fake.dropIdle()
    await until(() => fake.openSockets() === 0)
    expect(types(await call(adapter))).toEqual(['text_delta', 'usage', 'done'])
    expect(fake.accepts()).toBe(2)
  })

  it('serves four concurrent calls', async () => {
    const fake = await start({ delayMs: 40 })
    const adapter = adapterFor(fake.url)
    const results = await Promise.all([call(adapter), call(adapter), call(adapter), call(adapter)])
    for (const events of results) expect(types(events)).toEqual(['text_delta', 'usage', 'done'])
    expect(fake.seen).toHaveLength(4)
  })

  it('closes its connections on dispose and refuses calls afterwards', async () => {
    const fake = await start()
    const adapter = adapterFor(fake.url)
    await call(adapter)
    expect(fake.openSockets()).toBe(1)
    await adapter.dispose()
    await until(() => fake.openSockets() === 0)
    const events = await call(adapter)
    expect(errorOf(events)).toMatchObject({ code: 'NO_ADAPTER' })
    expect(fake.seen).toHaveLength(1)
  })

  it('does not send a request twice when the server drops it', async () => {
    const fake = await start({ drop: true })
    const events = await call(adapterFor(fake.url))
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'TRANSPORT', retryable: true })
    expect(fake.seen).toHaveLength(1)
  })
})

describe('redirects', () => {
  it('are not followed, and the key never reaches the target', async () => {
    const target = await start()
    const origin = await start({
      status: 307,
      headers: { location: `${target.url}/systemone` },
      body: '',
    })
    const events = await call(adapterFor(origin.url))
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'TRANSPORT', retryable: true })
    expect(origin.seen).toHaveLength(1)
    expect(target.seen).toHaveLength(0)
    expect(JSON.stringify(events)).not.toContain(KEY)
  })
})

describe('a body that misbehaves', () => {
  it('that never ends is cut off at the caller cancelling, within two seconds', async () => {
    const fake = await start({ dripMs: 20 })
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 150)
    const events = await call(adapterFor(fake.url), controller.signal)
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ reason: 'aborted', code: 'ABORTED', retryable: false })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('that never starts ends at the call time limit as TIMEOUT', async () => {
    const fake = await start({ hang: true })
    const adapter = adapterFor(fake.url)
    const events: WireEvent[] = []
    for await (const event of adapter.stream('jev', request(), {
      signal: new AbortController().signal,
      toolNames: [],
      sessionKey: 'agnes:t:a:cli:dm:x',
      timeoutMs: { firstToken: 150, total: 150 },
    }))
      events.push(event)
    expect(errorOf(events)).toMatchObject({ code: 'TIMEOUT', retryable: true })
  })

  it('that streams past 1 MiB is a FORMAT failure', async () => {
    const fake = await start({ streamBytes: 3 * 1024 * 1024 })
    const events = await call(adapterFor(fake.url))
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'FORMAT', retryable: false })
  })

  it('that declares more than 1 MiB is a FORMAT failure', async () => {
    const fake = await start({ headers: { 'content-length': String(4 * 1024 * 1024) }, cutAfterWrite: true })
    const events = await call(adapterFor(fake.url))
    expect(errorOf(events)).toMatchObject({ code: 'FORMAT', retryable: false })
  })

  it('that is cut off halfway is a retryable TRANSPORT failure', async () => {
    const fake = await start({ cutAfterWrite: true })
    const events = await call(adapterFor(fake.url))
    expect(types(events)).toEqual(['error'])
    expect(errorOf(events)).toMatchObject({ code: 'TRANSPORT', retryable: true })
  })
})
