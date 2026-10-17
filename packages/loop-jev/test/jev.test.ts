import { describe, expect, it } from 'vitest'
import { callJev, type JevDeps, resumeJev } from '../src/jev.js'
import { answersFor, fakeJev, PICK_RESPOND } from './helpers/fake-jev.js'

const payload = { state: { goal: 'g' }, questions: { phase: { type: 'choice', criteria: { RESPOND: 'r' } } } }
const req = (over: object = {}) => ({
  route: 'jev',
  model: 'typesafe/jev-1.13-20260917',
  deadlineMs: 15000,
  maxRetries: 2,
  idPrefix: 'jev:3:2',
  usedAttempts: 0,
  level: 0,
  build: () => payload,
  ...over,
})
function deps(port = fakeJev(() => ({})), over: Partial<JevDeps> = {}) {
  const log: string[] = []
  const delays: number[] = []
  const d: JevDeps = {
    sideCall: port,
    delay: async (ms) => void delays.push(ms),
    recordAttempt: async (id) => void log.push(`record ${id}`),
    emit: async (data) => void log.push(`emit ${String(data.invocationId)} ${String(data.status)}`),
    ...over,
  }
  return { d, log, delays, port }
}
const signal = new AbortController().signal

describe('callJev', () => {
  it('prepares exactly the jev.decide request and records the attempt before invoking', async () => {
    const { d, log, port } = deps()
    const out = await callJev(req(), d, signal)
    expect(out).toMatchObject({ kind: 'ok', invocationId: 'jev:3:2:d0' })
    expect(port.prepared[0]).toEqual({
      label: 'jev.decide',
      target: { route: 'jev', model: 'typesafe/jev-1.13-20260917' },
      payload,
      output: 'json',
      deadlineMs: 15000,
      invocationId: 'jev:3:2:d0',
    })
    expect(log).toEqual(['record jev:3:2:d0', 'emit jev:3:2:d0 ok'])
  })
  it('retries RATE_LIMIT with a new id after retryAfterMs', async () => {
    const { d, delays, port } = deps(
      fakeJev((n) =>
        n === 0
          ? { failed: { reason: 'adapter-error', code: 'RATE_LIMIT', retryable: true, retryAfterMs: 1200 } }
          : {},
      ),
    )
    expect(await callJev(req(), d, signal)).toMatchObject({ kind: 'ok', invocationId: 'jev:3:2:d1' })
    expect(delays).toEqual([1200])
    expect(port.invoked).toEqual(['jev:3:2:d0', 'jev:3:2:d1'])
  })
  it('backs off 500 ms × 2^n without a hint and gives up after maxRetries', async () => {
    const { d, delays } = deps(
      fakeJev(() => ({ failed: { reason: 'adapter-error', code: 'RATE_LIMIT', retryable: true } })),
    )
    expect(await callJev(req(), d, signal)).toMatchObject({
      kind: 'failed',
      code: 'MODEL_UNAVAILABLE',
      cause: 'RATE_LIMIT',
    })
    expect(delays).toEqual([500, 1000])
  })
  it('does not wait longer than 10 s', async () => {
    const { d, delays } = deps(
      fakeJev(() => ({
        failed: { reason: 'adapter-error', code: 'RATE_LIMIT', retryable: true, retryAfterMs: 20000 },
      })),
    )
    expect(await callJev(req(), d, signal)).toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    expect(delays).toEqual([])
  })
  it.each([
    [{ reason: 'adapter-error', code: 'TRANSPORT', retryable: true }, 'MODEL_UNAVAILABLE', 'TRANSPORT'],
    [{ reason: 'deadline', code: 'TIMEOUT', retryable: true }, 'MODEL_UNAVAILABLE', 'TIMEOUT'],
    [{ reason: 'adapter-error', code: 'OVERFLOW', retryable: false }, 'MODEL_UNAVAILABLE', 'OVERFLOW'],
    [{ reason: 'adapter-error', code: 'NO_ADAPTER', retryable: false }, 'MODEL_UNAVAILABLE', 'NO_ADAPTER'],
    [{ reason: 'invalid-output', retryable: false }, 'INVALID_PROPOSAL', 'invalid-output'],
    [{ reason: 'adapter-error', code: 'FORMAT', retryable: false }, 'INVALID_PROPOSAL', 'FORMAT'],
  ] as const)('maps %j to %s without retrying', async (failed, code, cause) => {
    const { d, port } = deps(fakeJev(() => ({ failed })))
    expect(await callJev(req(), d, signal)).toMatchObject({ kind: 'failed', code, cause })
    expect(port.invoked).toHaveLength(1)
  })
  it('treats a cancelled call as the end of the step', async () => {
    const { d } = deps(fakeJev(() => ({ failed: { reason: 'cancelled', retryable: false } })))
    expect(await callJev(req(), d, signal)).toEqual({ kind: 'cancelled' })
  })
  it('maps a missing route, a missing port and an exhausted budget', async () => {
    expect(
      await callJev(req(), deps(fakeJev(() => ({ prepareThrows: 'E_MODEL_UNKNOWN' }))).d, signal),
    ).toMatchObject({ code: 'MODEL_UNAVAILABLE', cause: 'E_MODEL_UNKNOWN' })
    expect(await callJev(req(), deps(undefined as never, { sideCall: undefined }).d, signal)).toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      cause: 'NO_SIDE_CALL',
    })
    expect(await callJev(req({ build: () => null }), deps().d, signal)).toMatchObject({
      code: 'INVALID_PROPOSAL',
      cause: 'BUDGET',
    })
  })
  it('re-prepares once after E_REQUEST_FROZEN and rethrows E_CLOSED', async () => {
    let frozen = true
    const port = fakeJev(() => {
      if (!frozen) return {}
      frozen = false
      return { invokeThrows: 'E_REQUEST_FROZEN' }
    })
    expect(await callJev(req(), deps(port).d, signal)).toMatchObject({ kind: 'ok' })
    await expect(
      callJev(req(), deps(fakeJev(() => ({ invokeThrows: 'E_CLOSED' }))).d, signal),
    ).rejects.toMatchObject({ code: 'E_CLOSED' })
  })
  it('emits digests, never the state or the questions', async () => {
    const emitted: object[] = []
    await callJev(req(), deps(undefined, { emit: async (data) => void emitted.push(data) }).d, signal)
    expect(JSON.stringify(emitted)).not.toMatch(/"(state|questions|toolUseId)"/)
    expect(emitted[0]).toMatchObject({ request: { stateDigest: expect.stringMatching(/^[0-9a-f]{16}$/) } })
  })
})

describe('resumeJev', () => {
  it('uses a finished record without sending again, and an absent one with the same id', async () => {
    const port = fakeJev(() => ({}))
    await port.invoke(
      await port.prepare({
        label: 'jev.decide',
        target: { route: 'jev', model: 'm' },
        invocationId: 'jev:3:2:d0',
      }),
      signal,
    )
    expect(
      await resumeJev({ ...req(), usedAttempts: 1, lastId: 'jev:3:2:d0' }, deps(port).d, signal),
    ).toMatchObject({ kind: 'ok', invocationId: 'jev:3:2:d0' })
    expect(port.invoked).toEqual(['jev:3:2:d0'])
    const fresh = fakeJev(() => ({}))
    const resumed = deps(fresh)
    expect(
      await resumeJev({ ...req(), usedAttempts: 1, lastId: 'jev:3:2:d0' }, resumed.d, signal),
    ).toMatchObject({ kind: 'ok', invocationId: 'jev:3:2:d0' })
    expect(fresh.invoked).toEqual(['jev:3:2:d0'])
    expect(resumed.log).toEqual(['emit jev:3:2:d0 ok'])
  })
  it('treats an interrupted record as spent', async () => {
    const port = fakeJev(() => ({ unknown: true }))
    await port.invoke(
      await port.prepare({
        label: 'jev.decide',
        target: { route: 'jev', model: 'm' },
        invocationId: 'jev:3:2:d0',
      }),
      signal,
    )
    expect(
      await resumeJev({ ...req(), usedAttempts: 1, lastId: 'jev:3:2:d0' }, deps(port).d, signal),
    ).toMatchObject({ code: 'MODEL_UNAVAILABLE', cause: 'interrupted' })
  })
})

describe('callJev edges', () => {
  const rateLimited = { failed: { reason: 'adapter-error', code: 'RATE_LIMIT', retryable: true } } as const
  it('shrinks to the next level and prepares the same id again when the estimate is over 60,000 tokens', async () => {
    const base = fakeJev(() => ({}))
    let big = true
    const port = {
      ...base,
      prepare: async (options: Parameters<typeof base.prepare>[0]) => {
        const prepared = await base.prepare(options)
        if (!big) return prepared
        big = false
        return { ...prepared, estimate: { ...prepared.estimate, inputTokens: 60001 } } as typeof prepared
      },
    }
    const levels: number[] = []
    const { d, log } = deps(port)
    const out = await callJev(
      req({
        level: 2,
        build: (level: number) => {
          levels.push(level)
          return payload
        },
      }),
      d,
      signal,
    )
    expect(out).toMatchObject({ kind: 'ok', invocationId: 'jev:3:2:d0', level: 3 })
    expect(levels).toEqual([2, 3])
    expect(base.prepared.map((o) => o.invocationId)).toEqual(['jev:3:2:d0', 'jev:3:2:d0'])
    expect(log).toEqual(['record jev:3:2:d0', 'emit jev:3:2:d0 ok'])
  })
  it('maps refused, unrecognized, missing JSON and a refused envelope', async () => {
    const wrap = (result: object) => ({ ...fakeJev(() => ({})), invoke: async () => result as never })
    expect(
      await callJev(req(), deps(wrap({ status: 'refused', invocationId: 'x', reason: 'budget' })).d, signal),
    ).toEqual({ kind: 'budget', message: 'the Jev call was refused: budget' })
    expect(
      await callJev(
        req(),
        deps(wrap({ status: 'refused', invocationId: 'x', reason: 'usage-unrecorded' })).d,
        signal,
      ),
    ).toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      cause: 'refused:usage-unrecorded',
      invocationId: 'jev:3:2:d0',
    })
    expect(await callJev(req(), deps(wrap({ status: 'later', invocationId: 'x' })).d, signal)).toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      cause: 'unrecognized',
    })
    expect(
      await callJev(
        req(),
        deps(wrap({ status: 'ok', invocationId: 'x', text: '', latencyMs: 1, replayed: false })).d,
        signal,
      ),
    ).toMatchObject({ code: 'INVALID_PROPOSAL', cause: 'no-json' })
    expect(
      await callJev(req(), deps(fakeJev(() => ({ prepareThrows: 'E_ENVELOPE' }))).d, signal),
    ).toMatchObject({ code: 'INVALID_PROPOSAL', cause: 'E_ENVELOPE', invocationId: null })
  })
  it('gives up after a second E_REQUEST_FROZEN and records the id once', async () => {
    const { d, log } = deps(fakeJev(() => ({ invokeThrows: 'E_REQUEST_FROZEN' })))
    expect(await callJev(req(), d, signal)).toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      cause: 'E_REQUEST_FROZEN',
    })
    expect(log).toEqual(['record jev:3:2:d0'])
  })
  it('stops retrying when the step is cancelled during the wait', async () => {
    const controller = new AbortController()
    const delay = async () => {
      controller.abort()
      throw new Error('aborted')
    }
    expect(
      await callJev(
        req(),
        deps(
          fakeJev(() => rateLimited),
          { delay },
        ).d,
        controller.signal,
      ),
    ).toEqual({ kind: 'cancelled' })
  })
  it('emits the attempt, the outcome and the usage of each call', async () => {
    const emitted: Record<string, unknown>[] = []
    await callJev(
      req(),
      deps(
        fakeJev((n) => (n === 0 ? { failed: { ...rateLimited.failed, retryAfterMs: 10 } } : {})),
        { emit: async (data) => void emitted.push(data) },
      ).d,
      signal,
    )
    expect(emitted).toMatchObject([
      {
        attempt: 0,
        invocationId: 'jev:3:2:d0',
        status: 'failed',
        reason: 'adapter-error',
        code: 'RATE_LIMIT',
        retryable: true,
        retryAfterMs: 10,
        usage: { inputTokens: 0, credits: 0 },
      },
      {
        attempt: 1,
        invocationId: 'jev:3:2:d1',
        status: 'ok',
        latencyMs: 5,
        usage: { inputTokens: 100, credits: 0 },
        request: { headIds: ['phase'], preparedInputTokens: 100 },
      },
    ])
  })
})

describe('resumeJev edges', () => {
  it('retries a recorded rate limit with the next attempt number', async () => {
    const port = fakeJev((n) =>
      n === 0 ? { failed: { reason: 'adapter-error', code: 'RATE_LIMIT', retryable: true } } : {},
    )
    await port.invoke(
      await port.prepare({
        label: 'jev.decide',
        target: { route: 'jev', model: 'm' },
        invocationId: 'jev:3:2:d0',
      }),
      signal,
    )
    const { d, delays } = deps(port)
    expect(await resumeJev({ ...req(), usedAttempts: 1, lastId: 'jev:3:2:d0' }, d, signal)).toMatchObject({
      kind: 'ok',
      invocationId: 'jev:3:2:d1',
    })
    expect(delays).toEqual([500])
    expect(port.invoked).toEqual(['jev:3:2:d0', 'jev:3:2:d1'])
  })
  it('polls a call still in flight every 200 ms until the Jev deadline', async () => {
    const port = {
      ...fakeJev(() => ({})),
      status: async (invocationId: string) => ({ status: 'in-flight', invocationId }) as const,
    }
    const { d, delays } = deps(port)
    expect(
      await resumeJev({ ...req({ deadlineMs: 1000 }), usedAttempts: 1, lastId: 'jev:3:2:d0' }, d, signal),
    ).toMatchObject({ code: 'MODEL_UNAVAILABLE', cause: 'in-flight', invocationId: 'jev:3:2:d0' })
    expect(delays).toEqual([200, 200, 200, 200, 200])
  })
})

describe('review follow-ups', () => {
  it('ends the step on an ABORTED code', async () => {
    const { d } = deps(
      fakeJev(() => ({ failed: { reason: 'adapter-error', code: 'ABORTED', retryable: false } })),
    )
    expect(await callJev(req(), d, signal)).toEqual({ kind: 'cancelled' })
  })
  it('sends nothing when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { d, port, log } = deps()
    expect(await callJev(req(), d, controller.signal)).toEqual({ kind: 'cancelled' })
    expect(port.prepared).toEqual([])
    expect(log).toEqual([])
  })
  it('keeps the paid answers when the event cannot be emitted', async () => {
    const dropped: unknown[] = []
    const failure = Object.assign(new Error('quota'), { code: 'E_ENVELOPE' })
    const { d } = deps(undefined, {
      emit: async () => {
        throw failure
      },
      dropped: (error) => void dropped.push(error),
    })
    expect(await callJev(req(), d, signal)).toMatchObject({ kind: 'ok', invocationId: 'jev:3:2:d0' })
    expect(dropped).toEqual([failure])
    const { d: silent } = deps(undefined, {
      emit: async () => {
        throw failure
      },
    })
    expect(await callJev(req(), silent, signal)).toMatchObject({ kind: 'ok' })
  })
  it('refuses to replay a recorded id with a different request', async () => {
    const port = fakeJev(() => ({}))
    await port.invoke(
      await port.prepare({
        label: 'jev.decide',
        target: { route: 'jev', model: 'm' },
        invocationId: 'jev:3:2:d0',
      }),
      signal,
    )
    const other = await port.prepare({
      label: 'jev.decide',
      target: { route: 'jev', model: 'n' },
      invocationId: 'jev:3:2:d0',
    })
    await expect(port.invoke(other, signal)).rejects.toMatchObject({
      code: 'E_RELATION',
      detail: { reason: 'invocation-reused' },
    })
    const same = await port.prepare({
      label: 'jev.decide',
      target: { route: 'jev', model: 'm' },
      invocationId: 'jev:3:2:d0',
    })
    expect(await port.invoke(same, signal)).toMatchObject({ status: 'ok', replayed: true })
  })
})

describe('answersFor', () => {
  it('answers choice heads with the pick or the first option and the meta heads with defaults', () => {
    const questions = {
      phase: { type: 'choice', criteria: { INSPECT: 'i', RESPOND: 'r' } },
      action__respond: { type: 'choice', criteria: { ANSWER: 'a' } },
      meta_ambiguity: { type: 'noul' },
      meta_progress: { type: 'score' },
    }
    expect(answersFor(questions, { pick: PICK_RESPOND, confidence: 0.8 })).toEqual({
      phase: {
        choice: 'RESPOND',
        confidence: 0.8,
        probabilities: { INSPECT: expect.closeTo(0.2), RESPOND: 0.8 },
      },
      action__respond: { choice: 'ANSWER', confidence: 0.8, probabilities: { ANSWER: 1 } },
      meta_ambiguity: { type: 'noul', noul: 0.1 },
      meta_progress: { type: 'score', score: 1, confidence: 0.6 },
    })
  })
})
