import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { PresetView } from '@agnes/core-common/step/preset'
import type { Event } from '@agnes/core-common/types'
import { CORE_CHECKS } from '@agnes/core-ledger/invariants/core-checks'
import { InvariantRegistry } from '@agnes/core-ledger/invariants/registry'
import { foldEvents } from '@agnes/core-ledger/reduce/reducer'
import type { LoopContext, LoopSideCallPort, SideCallOptions } from '@agnes/extension-api'
import type { InferenceEvent, ModelRecord, Provider, RequestBody } from '@agnes/protocol'
import { expect } from 'vitest'
import { createLoopContext } from '../../src/loop/ports.js'
import { sentFor } from './fake-provider.js'
import { fakeSeams } from './fake-seams.js'
import { actor, openSession } from './open-session.js'

/** A session with a side route the test scripts, and a loop context over its open turn. */

export type Options = Parameters<Provider['infer']>[1]
export type SideScript = (request: RequestBody, options: Options) => AsyncIterable<InferenceEvent>
export type Identity = NonNullable<ReturnType<NonNullable<Provider['describeRoute']>>>
export type Row = Record<string, unknown>

export const SIDE = Object.freeze({ route: 'side-route', model: 'side-model' })
export const ANSWER = '{"move":"e4","score":0.9}'
export const SENTINEL = 'SENTINEL-request-content-never-reaches-the-ledger'

export const record = (over: Partial<ModelRecord> = {}): ModelRecord => ({
  id: 'm',
  name: 'model',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://test.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1000,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  ...over,
})
export const sideRecord = record({
  id: SIDE.model,
  name: 'side',
  api: 'sample-adapter',
  route: SIDE.route,
  baseUrl: 'https://models.example.com/team-a/v1',
  contextWindow: 64_000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
})

/** What the provider says serves the side route: the host for audit, a digest of the full route. */
export const identity = (path = '/team-a/v1', host = 'models.example.com'): Identity => ({
  adapter: { id: 'sample-adapter', version: '1.0.0' },
  api: 'sample-adapter',
  endpointHost: host,
  routeDigest: sha256Hex(canonicalJson({ baseUrl: `https://${host}${path}`, api: 'sample-adapter' })),
})

export const sideUsage = (): InferenceEvent => ({
  type: 'usage',
  tokens: { input: 120, output: 4, cacheRead: 0, cacheWrite: 0 },
  credits: 0.042,
  creditSource: 'gateway',
  billing: { usdMicros: 420, source: 'gateway', subscription: false },
  response: { id: 'gen-1', model: 'side-model-2026' },
})
export const answer = (text = ANSWER): SideScript =>
  async function* (request) {
    yield sentFor(request)
    yield { type: 'text_delta', delta: text }
    yield sideUsage()
    yield { type: 'done', reason: 'stop' }
  }
export const never = () => new Promise<never>(() => undefined)
/** A non-streaming adapter whose response never arrives: not even the sent stamp is seen. */
export const silent: SideScript = () => ({
  [Symbol.asyncIterator]: () => ({
    next: never,
    return: async () => ({ done: true as const, value: undefined }),
  }),
})
/** Sends, then neither answers nor honours its signal. */
export const stalled: SideScript = async function* (request) {
  yield sentFor(request)
  await never()
}
/** Sends, then waits until the test opens the gate. */
export function gated(text = ANSWER) {
  let open!: () => void
  let entered!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const script: SideScript = async function* (request) {
    yield sentFor(request)
    entered()
    await opened
    yield { type: 'text_delta', delta: text }
    yield sideUsage()
    yield { type: 'done', reason: 'stop' }
  }
  return { script, open, reached }
}

export type SideProvider = Provider & {
  calls: Array<{ request: RequestBody; options: Options }>
  side: SideScript
  route: Identity | undefined
  catalog: ModelRecord[]
}

/** Answers the conversation with a fixed reply and the side route with the script under test. */
export function sideProvider(script: SideScript): SideProvider {
  const provider: SideProvider = {
    calls: [],
    side: script,
    route: identity(),
    catalog: [record(), sideRecord],
    models: () => provider.catalog,
    describeRoute: (route) => (route === SIDE.route ? provider.route : undefined),
    infer(request, options) {
      provider.calls.push({ request, options })
      return request.route === SIDE.route ? provider.side(request, options) : conversation(request)
    },
  }
  return provider
}
export async function* conversation(request: RequestBody): AsyncIterable<InferenceEvent> {
  const sent = sentFor(request)
  yield { ...sent, stamp: { ...sent.stamp, prompt_prefix_hash: sha256Hex(request.system) } }
  yield { type: 'text_delta', delta: 'main answer' }
  yield {
    type: 'usage',
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    credits: 1,
    creditSource: 'estimated',
  }
  yield { type: 'done', reason: 'stop' }
}

export type Setup = {
  script?: SideScript
  preset?: PresetView
  extra?: Partial<Parameters<typeof openSession>[0]>
}

/** An open turn and a loop context over a session whose side route the test scripts. */
export async function withSession<T>(setup: Setup, body: (t: Harness) => Promise<T>): Promise<T> {
  const provider = sideProvider(setup.script ?? answer())
  const billing: Row[] = []
  const seams = fakeSeams({
    billing: {
      record: async (row) => {
        billing.push(row as unknown as Row)
      },
      projected: async ({ tokensEstimate }) => ({
        credits: tokensEstimate / 1000,
        creditSource: 'estimated',
      }),
    },
  })
  const f = await openSession({
    provider,
    seams,
    ...(setup.preset ? { preset: setup.preset } : {}),
    ...setup.extra,
  })
  try {
    await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'decide' }], actor })
    expect(await f.session.acceptInput()).toBe(true)
    const ctx = await createLoopContext(f.session)
    const port = ctx.sideCall as LoopSideCallPort
    return await body({
      ...f,
      provider,
      billing,
      ctx,
      port,
      rows: () => f.session.scan({ fromSeq: 1, limit: 500 }),
    })
  } finally {
    await f.session.close()
  }
}
export type Harness = Awaited<ReturnType<typeof openSession>> & {
  provider: SideProvider
  billing: Row[]
  ctx: LoopContext
  port: LoopSideCallPort
  rows: () => Promise<Event[]>
}

export const options = (over: Partial<SideCallOptions> = {}): SideCallOptions => ({
  label: 'sample.decide',
  target: SIDE,
  system: 'Judge the board.',
  payload: {
    board: [
      [1, 0],
      [0, 1],
    ],
    questions: ['next move'],
  },
  output: 'json',
  deadlineMs: 5000,
  invocationId: 'call-1',
  ...over,
})
export const signal = () => new AbortController().signal
export const data = (row: Event | undefined) => row?.data as Row
export const ofType = (rows: Event[], type: string) => rows.filter((row) => row.type === type)
export const sideCosts = (rows: Event[]) =>
  ofType(rows, 'cost/ledger').filter((row) => data(row).purpose === 'side-call')
export const settlements = (rows: Event[]) =>
  ofType(rows, 'effect/settled').filter((row) => String(data(row).effectId).startsWith('side:'))
export const terminals = (rows: Event[]) => ofType(rows, 'x/core/side-call-terminal')
export function violations(rows: Event[]) {
  const checks = new InvariantRegistry()
  checks.register('@agnes/core', CORE_CHECKS)
  return checks.run(rows, foldEvents([]))
}
