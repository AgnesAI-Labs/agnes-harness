import type { RequestBody } from '@agnes/protocol'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import type { WireEvent } from '../src/index.js'
import { JEV_WIRE_API, JevAdapter } from '../src/index.js'
import type { FakeSystemOne } from '../testkit/index.js'
import {
  assertLoopbackOnly,
  fakeModel,
  installLoopbackOnly,
  restoreLoopbackOnly,
  startFakeSystemOne,
} from '../testkit/index.js'

/**
 * The part of the connection-pool behaviour that needs real idle time. The fast loopback file holds
 * the rest; this one waits on a real timer, so it belongs to the heavy tier.
 */
const KEY = 'TEST-KEY-0123456789'
const MODEL = 'typesafe/jev-1.13-20260917'
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const PAYLOAD = { state: { step: 1 }, questions: { q1: { type: 'choice', criteria: { a: 'A', b: 'B' } } } }

const savedEnv = new Map<string, string | undefined>()
const fakes: FakeSystemOne[] = []
const adapters: JevAdapter[] = []

beforeAll(() => {
  installLoopbackOnly()
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

async function call(adapter: JevAdapter) {
  const events: WireEvent[] = []
  for await (const event of adapter.stream('jev', request(), {
    signal: new AbortController().signal,
    toolNames: [],
    sessionKey: 'agnes:t:a:cli:dm:x',
    timeoutMs: { firstToken: 10_000, total: 10_000 },
  }))
    events.push(event)
  return events.map((e) => e.type)
}

it('reuses one connection for two calls six seconds apart', async () => {
  // The fixture sends no keep-alive hint and never closes an idle connection, so the only idle limit
  // left is the one the adapter sets on its own pool. Left to the pool's default, the connection
  // would be retired after a few seconds and the second call would open another.
  const fake = await startFakeSystemOne({}, { keepAliveTimeoutMs: 0 })
  fakes.push(fake)
  const baseUrl = fake.url
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

  expect(await call(adapter)).toEqual(['text_delta', 'usage', 'done'])
  await new Promise((resolve) => setTimeout(resolve, 6_000))
  expect(await call(adapter)).toEqual(['text_delta', 'usage', 'done'])

  expect(fake.seen).toHaveLength(2)
  expect(fake.accepts()).toBe(1)
  expect(new Set(fake.seen.map((s) => s.socket)).size).toBe(1)
}, 30_000)
