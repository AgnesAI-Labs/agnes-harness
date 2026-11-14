import type {
  PreparedSideCall,
  SideCallOptions,
  SideCallPort,
  SideCallResult,
  SideCallStatus,
} from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { createAnswerCache } from '../src/cache.js'
import { createJudge, createRouteCooldown } from '../src/judge.js'
import { type JudgmentRequest, validateRequest } from '../src/questions.js'

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
const ok = (id = 'id'): Extract<SideCallResult, { status: 'ok' }> => ({
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
    prepare: vi.fn(
      async (o: SideCallOptions) => ({ ...o, requestHash: JSON.stringify(o) }) as unknown as PreparedSideCall,
    ),
    invoke: vi.fn(invoke),
    status: vi.fn(
      async (invocationId: string): Promise<SideCallStatus> => ({ status: 'absent', invocationId }),
    ),
  } satisfies SideCallPort
}
it('dispatches valid noul criteria undefined with the existing omitted native JSON and identity', async () => {
  const p = port()
  const request = {
    state: 'work',
    questions: { q: { type: 'noul' as const, instructions: 'done?', criteria: undefined } },
  }
  const input = request as unknown as JudgmentRequest
  expect(validateRequest(input)).toEqual({ ok: true })
  const result = await createJudge({ port: p, chain: [target], cache: cache(), now: Date.now }).judge(
    'judgment.stop',
    input,
    options(),
  )
  expect(result).toMatchObject({ status: 'ok', answers: { q: { type: 'noul', noul: 0.9 } } })
  const prepared = p.prepare.mock.calls.at(0)?.[0]
  expect(JSON.stringify(prepared?.payload)).toBe(
    '{"state":"work","questions":{"q":{"type":"noul","instructions":"done?"}}}',
  )
  expect(prepared?.invocationId).toBe('stop:1:2:c0:a0')
  expect(Object.hasOwn(request.questions.q, 'criteria')).toBe(true)
})
it.each([
  { ...req, state: { value: undefined } },
  {
    ...req,
    questions: { q: { type: 'noul', instructions: 'done?', criteria: { true: undefined } } },
  },
])('refuses invalid state or nested undefined criteria before preparing', async (request) => {
  const p = port()
  const result = await createJudge({ port: p, chain: [target], cache: cache(), now: Date.now }).judge(
    'judgment.stop',
    request as unknown as JudgmentRequest,
    options(),
  )
  expect(result).toMatchObject({ status: 'failed', reason: 'invalid', accounting: { calls: [] } })
  expect(p.prepare).not.toHaveBeenCalled()
  expect(p.invoke).not.toHaveBeenCalled()
})
it('returns no-judge when the chain is null', async () => {
  const p = port()
  expect(
    await createJudge({ port: p, chain: null, cache: cache(), now: Date.now }).judge(
      'judgment.stop',
      req,
      options(),
    ),
  ).toMatchObject({ status: 'failed', reason: 'no-judge' })
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
  ).toMatchObject({ status: 'failed', reason: 'budget' })
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
  expect(await result).toMatchObject({ status: 'failed', reason: 'timeout' })
  expect(p.invoke.mock.calls.every((call) => call[1].aborted)).toBe(true)
})
it('rejects malformed requests and outputs without exposing them', async () => {
  const p = port(async () => ({ ...ok(), json: {} }) as SideCallResult)
  const judge = createJudge({ port: p, chain: [target], cache: cache(), now: Date.now })
  expect(await judge.judge('judgment.stop', { ...req, questions: {} }, options())).toMatchObject({
    status: 'failed',
    reason: 'invalid',
  })
  expect(p.prepare).not.toHaveBeenCalled()
  expect(await judge.judge('judgment.stop', req, options())).toMatchObject({
    status: 'failed',
    reason: 'invalid',
  })
})

it('replays a finished matching request with a fixed deadline and preserves historical usage', async () => {
  const p = port()
  let saved: PreparedSideCall | undefined
  p.status.mockImplementation(async (id) =>
    saved
      ? ({
          status: 'finished',
          invocationId: id,
          label: saved.label,
          requestHash: saved.requestHash,
          result: ok(id),
        } as any)
      : { status: 'absent', invocationId: id },
  )
  p.invoke.mockImplementation(async (prepared) => {
    saved = prepared
    return ok(prepared.invocationId)
  })
  const make = () => createJudge({ port: p, chain: [target], cache: cache(), now: Date.now })
  await make().judge('judgment.stop', req, options())
  const result = await make().judge('judgment.stop', req, { ...options(), totalMs: 1000 })
  expect(result).toMatchObject({
    status: 'ok',
    backend: 'native',
    probabilityAvailable: true,
    accounting: { calls: [{ replayed: true, usage: { credits: 0 } }] },
  })
  expect(p.invoke).toHaveBeenCalledTimes(1)
  expect(p.prepare.mock.calls.map(([o]) => o.deadlineMs)).toEqual([5000, 5000])
  expect(await make().judge('judgment.stop', { ...req, state: 'different' }, options())).toMatchObject({
    status: 'failed',
    reason: 'invalid',
  })
  expect(p.invoke).toHaveBeenCalledTimes(1)
})
it('never sends unknown or in-flight identities and retries finished failures only under a new identity', async () => {
  const p = port()
  p.status.mockResolvedValue({ status: 'in-flight', invocationId: 'pending' })
  const judge = () => createJudge({ port: p, chain: [target], cache: cache(), now: Date.now })
  expect(await judge().judge('judgment.stop', req, { ...options(), retry: 'once' })).toMatchObject({
    status: 'failed',
  })
  expect(p.invoke).not.toHaveBeenCalled()
  p.status.mockImplementation(async (id) => ({ status: 'absent', invocationId: id }))
  p.invoke.mockImplementation(async (prepared) =>
    prepared.invocationId.endsWith('a0')
      ? {
          status: 'failed',
          invocationId: prepared.invocationId,
          reason: 'deadline',
          retryable: true,
          dispatch: 'may-have-sent',
          replayed: false,
          latencyMs: 1,
          usage: ok().status === 'ok' ? (ok() as any).usage : undefined,
        }
      : ok(prepared.invocationId),
  )
  const result = await judge().judge('judgment.stop', req, { ...options(), retry: 'once' })
  expect(result).toMatchObject({
    status: 'ok',
    accounting: { calls: [{ replayed: false }, { replayed: false }] },
  })
  expect(new Set(p.prepare.mock.calls.map(([o]) => o.invocationId)).size).toBe(2)
})
it('keeps Core refusal accounting and disables fallback with retry none', async () => {
  const p = port(async () => ({ status: 'refused', invocationId: 'x', reason: 'budget' }))
  const result = await createJudge({
    port: p,
    chain: [target, fallback],
    cache: cache(),
    now: Date.now,
  }).judge('judgment.stop', req, { ...options(), retry: 'none' })
  expect(result).toMatchObject({
    status: 'failed',
    reason: 'budget',
    accounting: { calls: [{ dispatch: 'not-sent', replayed: false }] },
  })
  expect(p.invoke).toHaveBeenCalledTimes(1)
})

it('rejects a split request before sending when splitting is disabled', async () => {
  const p = port()
  const multi = {
    state: 'shared',
    questions: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `q${i}`,
        { type: 'noul' as const, instructions: 'x'.repeat(24000) },
      ]),
    ),
  }
  const result = await createJudge({ port: p, chain: [target], cache: cache(), now: Date.now }).judge(
    'judgment.stop',
    multi,
    { ...options(), allowSplit: false },
  )
  expect(result).toMatchObject({ status: 'failed', reason: 'invalid', accounting: { calls: [] } })
  expect(p.prepare).not.toHaveBeenCalled()
})
it('replays a finished failure and uses a fresh attempt identity for the only retry', async () => {
  const p = port()
  const ledger = new Map<string, Extract<SideCallStatus, { status: 'finished' }>>()
  p.status.mockImplementation(async (id) => ledger.get(id) ?? { status: 'absent', invocationId: id })
  p.invoke.mockImplementation(async (prepared) => {
    const result: SideCallResult = prepared.invocationId.endsWith('a0')
      ? {
          status: 'failed',
          invocationId: prepared.invocationId,
          reason: 'adapter-error',
          retryable: true,
          dispatch: 'may-have-sent',
          replayed: false,
          latencyMs: 1,
          usage: (ok() as Extract<SideCallResult, { status: 'ok' }>).usage,
        }
      : ok(prepared.invocationId)
    ledger.set(prepared.invocationId, {
      status: 'finished',
      invocationId: prepared.invocationId,
      requestHash: prepared.requestHash,
      label: prepared.label,
      result,
    })
    return result
  })
  const make = () => createJudge({ port: p, chain: [target], cache: cache(), now: Date.now })
  const failed = await make().judge('judgment.stop', req, { ...options(), retry: 'none' })
  expect(failed).toMatchObject({
    status: 'failed',
    accounting: { calls: [{ usage: { credits: 0 }, replayed: false }] },
  })
  const retried = await make().judge('judgment.stop', req, { ...options(), retry: 'once' })
  expect(retried).toMatchObject({
    status: 'ok',
    accounting: { calls: [{ replayed: true, usage: { credits: 0 } }, { replayed: false }] },
  })
  expect(p.invoke.mock.calls.map(([prepared]) => prepared.invocationId)).toEqual([
    'stop:1:2:c0:a0',
    'stop:1:2:c0:a1',
  ])
})

function deferred<T>() {
  let resolve = (_value: T): void => {
    throw new Error('deferred not initialized')
  }
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
function nativeResult(prepared: PreparedSideCall): SideCallResult {
  const request = prepared as unknown as SideCallOptions
  const payload = request.payload as { questions: Record<string, unknown> }
  return {
    ...ok(prepared.invocationId),
    json: Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: 'noul', noul: 0.9 }])),
  }
}
function recordedPort() {
  const ledger = new Map<string, Extract<SideCallStatus, { status: 'finished' }>>()
  const p = port(async (prepared) => {
    const result = nativeResult(prepared)
    ledger.set(prepared.invocationId, {
      status: 'finished',
      invocationId: prepared.invocationId,
      label: prepared.label,
      requestHash: prepared.requestHash,
      result,
    })
    return result
  })
  p.status.mockImplementation(async (id) => ledger.get(id) ?? { status: 'absent', invocationId: id })
  return { p, ledger }
}
it('keeps full request chunk identities when an earlier successful chunk populated the cache', async () => {
  const multi = {
    state: 'same',
    questions: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `q${i}`,
        { type: 'noul' as const, instructions: 'x'.repeat(24000) + i },
      ]),
    ),
  }
  const { p, ledger } = recordedPort()
  const c = cache()
  const controller = new AbortController()
  const record = p.invoke.getMockImplementation()
  if (!record) throw new Error('fixture recording implementation missing')
  p.invoke.mockImplementation(async (prepared, signal) => {
    if (prepared.invocationId.endsWith('c1:a0')) {
      controller.abort()
      throw new Error('interrupted before sending second chunk')
    }
    return record(prepared, signal)
  })
  const judge = createJudge({ port: p, chain: [target], cache: c, now: Date.now })
  expect(
    await judge.judge('judgment.batch', multi, { ...options(), signal: controller.signal, retry: 'none' }),
  ).toMatchObject({ status: 'failed' })
  expect(ledger.size).toBe(1)
  p.invoke.mockImplementation(record)
  const result = await judge.judge('judgment.batch', multi, { ...options(), retry: 'none' })
  expect(result).toMatchObject({
    status: 'ok',
    answers: Object.fromEntries(Object.keys(multi.questions).map((id) => [id, { type: 'noul', noul: 0.9 }])),
  })
  expect(p.invoke.mock.calls.filter(([prepared]) => prepared.invocationId.endsWith('c0:a0'))).toHaveLength(1)
})
it.each(['stop:1:2', 'a'.repeat(100)])(
  'cold-cache replay preserves paid partial-cache requests and residuals for prefix %s',
  async (idPrefix) => {
    const multi = {
      state: req.state,
      questions: { ...req.questions, other: { ...req.questions.q, instructions: 'other?' } },
    }
    const { p } = recordedPort()
    const warm = cache()
    warm.set(req.state, target, req.questions.q, { type: 'noul', noul: 0.8 })
    expect(
      await createJudge({ port: p, chain: [target], cache: warm, now: Date.now }).judge(
        'judgment.batch',
        multi,
        { ...options(), idPrefix, retry: 'none' },
      ),
    ).toMatchObject({ status: 'ok' })
    const resumed = await createJudge({ port: p, chain: [target], cache: cache(), now: Date.now }).judge(
      'judgment.batch',
      multi,
      { ...options(), idPrefix, retry: 'none' },
    )
    expect(resumed).toMatchObject({
      status: 'ok',
      accounting: { calls: [{ replayed: true }, { replayed: false }] },
    })
    expect(
      p.invoke.mock.calls.map(([prepared]) =>
        Object.keys(
          ((prepared as unknown as SideCallOptions).payload as { questions: Record<string, unknown> })
            .questions,
        ),
      ),
    ).toEqual([['other'], ['q']])
    const coldAgain = await createJudge({ port: p, chain: [target], cache: cache(), now: Date.now }).judge(
      'judgment.batch',
      multi,
      { ...options(), idPrefix, retry: 'none' },
    )
    expect(coldAgain).toMatchObject({
      status: 'ok',
      accounting: { calls: [{ replayed: true }, { replayed: true }] },
    })
    expect(p.invoke).toHaveBeenCalledTimes(2)
  },
)
it.each([false, true])(
  'does not retry once while the timed-out invoke remains unsettled (fallback %s)',
  async (withFallback) => {
    vi.useFakeTimers()
    const first = deferred<SideCallResult>()
    const p = port(async () => first.promise)
    const outcome = createJudge({
      port: p,
      chain: withFallback ? [target, fallback] : [target],
      cache: cache(),
      now: Date.now,
    }).judge('judgment.batch', req, { ...options(), attemptMs: 100, totalMs: 250, retry: 'once' })
    await vi.advanceTimersByTimeAsync(250)
    expect(await outcome).toMatchObject({ status: 'failed', reason: 'timeout' })
    expect(p.invoke).toHaveBeenCalledTimes(1)
    first.resolve({ status: 'unknown', invocationId: 'stopped', reason: 'interrupted', replayed: false })
  },
)
it('retains usage that settles after the first wait timed out but before legacy fallback returns', async () => {
  vi.useFakeTimers()
  const first = deferred<SideCallResult>()
  const second = deferred<SideCallResult>()
  const p = port(async (prepared) =>
    prepared.target.route === target.route ? first.promise : second.promise,
  )
  const outcome = createJudge({ port: p, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
    'judgment.stop',
    req,
    { ...options(), attemptMs: 100, totalMs: 500 },
  )
  await vi.advanceTimersByTimeAsync(100)
  expect(p.invoke).toHaveBeenCalledTimes(2)
  const firstPrepared = p.invoke.mock.calls.at(0)?.[0]
  if (!firstPrepared) throw new Error('first request missing')
  first.resolve({
    status: 'failed',
    invocationId: firstPrepared.invocationId,
    reason: 'deadline',
    retryable: true,
    dispatch: 'may-have-sent',
    replayed: false,
    latencyMs: 101,
    usage: {
      tokens: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 },
      credits: 3,
      creditSource: 'gateway',
      billing: { usdMicros: 123, source: 'gateway', subscription: false },
    },
  })
  await vi.advanceTimersByTimeAsync(0)
  second.resolve(ok())
  const result = await outcome
  expect(result).toMatchObject({
    status: 'ok',
    accounting: {
      calls: [{ usage: { credits: 3, billing: { usdMicros: 123 } } }, { usage: { credits: 0 } }],
    },
  })
  const firstCall = result.accounting.calls.at(0)
  expect(firstCall?.usage?.credits).toBe(3)
})
it.each(['throw', 'nonretryable', 'invalid-output'] as const)(
  'preserves legacy native fallback after %s while once remains conservative',
  async (kind) => {
    const p = port(async (prepared) => {
      if (prepared.target.route === fallback.route) return ok(prepared.invocationId)
      if (kind === 'throw') throw new Error('ordinary adapter failure')
      if (kind === 'invalid-output') return { ...ok(prepared.invocationId), json: {} }
      return {
        status: 'failed',
        invocationId: prepared.invocationId,
        reason: 'adapter-error',
        retryable: false,
        dispatch: 'may-have-sent',
        latencyMs: 1,
        replayed: false,
      }
    })
    const result = await createJudge({
      port: p,
      chain: [target, fallback],
      cache: cache(),
      now: Date.now,
    }).judge('judgment.stop', req, options())
    expect(result).toMatchObject({ status: 'ok' })
    expect(p.invoke).toHaveBeenCalledTimes(2)
    const once = port(p.invoke.getMockImplementation())
    expect(
      await createJudge({ port: once, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
        'judgment.batch',
        req,
        { ...options(), retry: 'once' },
      ),
    ).toMatchObject({ status: 'failed' })
    expect(once.invoke).toHaveBeenCalledTimes(1)
  },
)

it('refuses an unreconciled cold-cache failed subset without resending it', async () => {
  const multi = {
    state: req.state,
    questions: { ...req.questions, other: { ...req.questions.q, instructions: 'other?' } },
  }
  const { p, ledger } = recordedPort()
  p.invoke.mockImplementation(async (prepared) => {
    const result: SideCallResult = {
      status: 'failed',
      invocationId: prepared.invocationId,
      reason: 'adapter-error',
      retryable: true,
      dispatch: 'may-have-sent',
      replayed: false,
      latencyMs: 1,
    }
    ledger.set(prepared.invocationId, {
      status: 'finished',
      invocationId: prepared.invocationId,
      label: prepared.label,
      requestHash: prepared.requestHash,
      result,
    })
    return result
  })
  const warm = cache()
  warm.set(req.state, target, req.questions.q, { type: 'noul', noul: 0.8 })
  expect(
    await createJudge({ port: p, chain: [target], cache: warm, now: Date.now }).judge(
      'judgment.batch',
      multi,
      { ...options(), retry: 'none' },
    ),
  ).toMatchObject({ status: 'failed', reason: 'error' })
  expect(
    await createJudge({ port: p, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
      'judgment.batch',
      multi,
      { ...options(), retry: 'once' },
    ),
  ).toMatchObject({ status: 'failed', reason: 'invalid' })
  expect(p.invoke).toHaveBeenCalledTimes(1)
})
it('returns a fixed accounting snapshot when an earlier call remains unknown at return', async () => {
  vi.useFakeTimers()
  const first = deferred<SideCallResult>()
  const p = port(async (prepared) =>
    prepared.target.route === target.route ? first.promise : ok(prepared.invocationId),
  )
  const pending = createJudge({ port: p, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
    'judgment.stop',
    req,
    { ...options(), attemptMs: 100, totalMs: 500 },
  )
  await vi.advanceTimersByTimeAsync(100)
  const result = await pending
  expect(result).toMatchObject({ status: 'ok' })
  expect(result.accounting.calls.at(0)?.usage).toBeUndefined()
  first.resolve(ok())
  await vi.advanceTimersByTimeAsync(0)
  expect(result.accounting.calls.at(0)?.usage).toBeUndefined()
})

it('does not turn an unavailable identity lookup into a legacy fallback dispatch', async () => {
  const p = port()
  p.status.mockImplementation(async (id) => {
    if (id.endsWith('a0')) throw new Error('identity lookup unavailable')
    return { status: 'absent', invocationId: id }
  })
  expect(
    await createJudge({ port: p, chain: [target, fallback], cache: cache(), now: Date.now }).judge(
      'judgment.stop',
      req,
      options(),
    ),
  ).toMatchObject({ status: 'failed' })
  expect(p.invoke).not.toHaveBeenCalled()
})
it('refuses cold-cache residual expansion when splitting is disabled and preserves default recovery', async () => {
  const extra = { type: 'noul' as const, instructions: 'second cache-only question?' }
  const multi = {
    state: req.state,
    questions: { ...req.questions, extra, other: { ...req.questions.q, instructions: 'other?' } },
  }
  const { p } = recordedPort()
  const warm = cache()
  warm.set(req.state, target, req.questions.q, { type: 'noul', noul: 0.8 })
  warm.set(req.state, target, extra, { type: 'noul', noul: 0.7 })
  const strict = { ...options(), retry: 'none' as const, allowSplit: false }
  expect(
    await createJudge({ port: p, chain: [target], cache: warm, now: Date.now }).judge(
      'judgment.rules',
      multi,
      strict,
    ),
  ).toMatchObject({ status: 'ok' })
  expect(
    await createJudge({ port: p, chain: [target], cache: cache(), now: Date.now }).judge(
      'judgment.rules',
      multi,
      strict,
    ),
  ).toMatchObject({ status: 'failed', reason: 'invalid', accounting: { calls: [{ replayed: true }] } })
  expect(p.invoke).toHaveBeenCalledTimes(1)
  expect(
    await createJudge({ port: p, chain: [target], cache: cache(), now: Date.now }).judge(
      'judgment.rules',
      multi,
      { ...options(), retry: 'none' },
    ),
  ).toMatchObject({ status: 'ok' })
  expect(p.invoke).toHaveBeenCalledTimes(3)
})
