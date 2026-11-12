import type { PreparedSideCall, SideCallOptions, SideCallPort, SideCallResult } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { createAnswerCache } from '../src/cache.js'
import { createJudge, createRouteCooldown } from '../src/judge.js'

afterEach(() => vi.useRealTimers())
const req = { state: 'work', questions: { q: { type: 'noul' as const, instructions: 'done?' } } }
const target = { route: 'jev', model: 'j', native: true }
const fallback = { route: 'backup', model: 'j', native: true }
const cache = () => createAnswerCache(null, { ttlMs: 30 * 86400000, maxEntries: 2000 })
const options = () => ({
  attemptMs: 5000,
  totalMs: 14500,
  signal: new AbortController().signal,
  idPrefix: 'stop:1:2',
})
const ok = (id = 'id'): SideCallResult => ({
  status: 'ok',
  invocationId: id,
  text: '',
  json: { q: { type: 'noul', noul: 0.9 } },
  usage: {
    tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    credits: 0,
    creditSource: 'estimated',
  },
  latencyMs: 1,
  replayed: false,
})
function port(
  invoke: (p: PreparedSideCall, signal: AbortSignal) => Promise<SideCallResult> = async () => ok(),
) {
  return {
    prepare: vi.fn(async (o: SideCallOptions) => ({ ...o }) as PreparedSideCall),
    invoke: vi.fn(invoke),
    status: vi.fn(),
  } satisfies SideCallPort
}
it('returns no-judge when the chain is null', async () => {
  const p = port()
  expect(
    await createJudge({ port: p, chain: null, cache: cache(), now: Date.now }).judge(
      'judgment.stop',
      req,
      options(),
    ),
  ).toEqual({ status: 'failed', reason: 'no-judge' })
  expect(p.prepare).not.toHaveBeenCalled()
})
it('falls back once on timeout', async () => {
  vi.useFakeTimers()
  const p = port(async (prepared) => (prepared.target.route === 'jev' ? new Promise(() => {}) : ok()))
  const result = createJudge({ port: p, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
    'judgment.stop',
    req,
    options(),
  )
  await vi.advanceTimersByTimeAsync(5000)
  expect(await result).toMatchObject({ status: 'ok', model: 'j' })
  expect(p.invoke).toHaveBeenCalledTimes(2)
  expect(p.invoke.mock.calls[0]![1].aborted).toBe(true)
})
it('never falls back from native to text bridge', async () => {
  const p = port(async () => ({ status: 'failed', reason: 'deadline', retryable: true }) as SideCallResult)
  await createJudge({
    port: p,
    chain: [target, { ...fallback, native: false }],
    cache: cache(),
    now: Date.now,
  }).judge('judgment.stop', req, options())
  expect(p.invoke).toHaveBeenCalledTimes(1)
})
it('skips a route for 30s after a non-retryable failure only in its session', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const p = port(
    async () => ({ status: 'failed', reason: 'adapter-error', retryable: false }) as SideCallResult,
  )
  const cooldown = createRouteCooldown()
  const judge = (session: string) =>
    createJudge({ port: p, chain: [target], cache: cache(), now: Date.now, cooldown, session })
  await judge('a').judge('judgment.stop', req, options())
  await judge('a').judge('judgment.stop', req, options())
  expect(p.invoke).toHaveBeenCalledTimes(1)
  await judge('b').judge('judgment.stop', req, options())
  expect(p.invoke).toHaveBeenCalledTimes(2)
  vi.setSystemTime(30000)
  await judge('a').judge('judgment.stop', req, options())
  expect(p.invoke).toHaveBeenCalledTimes(3)
})
it('treats a budget refusal as failure', async () => {
  const p = port(async () => ({ status: 'refused', reason: 'budget' }) as SideCallResult)
  expect(
    await createJudge({ port: p, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
      'judgment.stop',
      req,
      options(),
    ),
  ).toEqual({ status: 'failed', reason: 'budget' })
  expect(p.invoke).toHaveBeenCalledTimes(1)
})
it('uses deterministic invocation ids from idPrefix', async () => {
  const ids: string[] = []
  for (let i = 0; i < 2; i++) {
    const p = port()
    await createJudge({ port: p, chain: [target], cache: cache(), now: Date.now }).judge(
      'judgment.stop',
      req,
      options(),
    )
    ids.push(p.prepare.mock.calls[0]![0].invocationId!)
  }
  expect(ids[0]).toBe(ids[1])
  expect(ids[0]).toMatch(/^stop:1:2:/)
  expect(ids[0]!.length).toBeLessThanOrEqual(112)
})
it('answers from cache without calling the port', async () => {
  const c = cache()
  c.set(req.state, target, req.questions.q, { type: 'noul', noul: 0.9 })
  const p = port()
  expect(
    await createJudge({ port: p, chain: [target], cache: c, now: Date.now }).judge(
      'judgment.stop',
      req,
      options(),
    ),
  ).toMatchObject({ status: 'ok', cached: true })
  expect(p.prepare).not.toHaveBeenCalled()
})
it('only sends uncached native questions and never caches text answers', async () => {
  const c = cache()
  c.set(req.state, target, req.questions.q, { type: 'noul', noul: 0.9 })
  const p = port(async () => ({ ...ok(), json: { other: { type: 'noul', noul: 0.2 } } }) as SideCallResult)
  const multi = {
    ...req,
    questions: { ...req.questions, other: { ...req.questions.q, instructions: 'other?' } },
  }
  expect(
    await createJudge({ port: p, chain: [target], cache: c, now: Date.now }).judge(
      'judgment.stop',
      multi,
      options(),
    ),
  ).toMatchObject({ status: 'ok', cached: false, answers: { q: { noul: 0.9 }, other: { noul: 0.2 } } })
  expect(Object.keys((p.prepare.mock.calls[0]![0].payload as any).questions)).toEqual(['other'])
  const textPort = port(async () => ({ ...ok(), text: 'yes' }) as SideCallResult)
  const judge = createJudge({
    port: textPort,
    chain: [{ ...target, native: false }],
    cache: c,
    now: Date.now,
  })
  await judge.judge('judgment.stop', req, options())
  await judge.judge('judgment.stop', req, options())
  expect(textPort.invoke).toHaveBeenCalledTimes(2)
})
it('abandons during prepare without invoking or falling back', async () => {
  const controller = new AbortController(),
    p = port()
  p.prepare.mockImplementation(async () => new Promise(() => {}))
  const result = createJudge({ port: p, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
    'judgment.stop',
    req,
    { ...options(), signal: controller.signal },
  )
  controller.abort()
  expect(await result).toMatchObject({ status: 'failed' })
  expect(p.invoke).not.toHaveBeenCalled()
})
it('total deadline bounds all attempts', async () => {
  vi.useFakeTimers()
  const p = port(async () => new Promise(() => {}))
  const result = createJudge({ port: p, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
    'judgment.stop',
    req,
    { ...options(), totalMs: 6000 },
  )
  await vi.advanceTimersByTimeAsync(6000)
  expect(await result).toEqual({ status: 'failed', reason: 'timeout' })
  expect(p.invoke.mock.calls.every((call) => call[1].aborted)).toBe(true)
})
it('rejects malformed requests and outputs without exposing them', async () => {
  const p = port(async () => ({ ...ok(), json: {} }) as SideCallResult)
  const judge = createJudge({ port: p, chain: [target], cache: cache(), now: Date.now })
  expect(await judge.judge('judgment.stop', { ...req, questions: {} }, options())).toEqual({
    status: 'failed',
    reason: 'invalid',
  })
  expect(p.prepare).not.toHaveBeenCalled()
  expect(await judge.judge('judgment.stop', req, options())).toEqual({ status: 'failed', reason: 'invalid' })
})
