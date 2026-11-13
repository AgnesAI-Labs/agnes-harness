import type { PreparedSideCall, SideCallOptions, SideCallPort, SideCallResult } from '@agnes/extension-api'
import { expect, it, vi } from 'vitest'
import { createAnswerCache } from '../src/cache.js'
import { createJudge, type Judge, type JudgeOutcome } from '../src/judge.js'
import { createJudgmentScheduler } from '../src/scheduler.js'
import { judgeBatch } from '../src/uses/judge-batch.js'
import { batchInput } from '../src/uses/tool-input.js'

const accepted = (value: unknown) => {
  const input = batchInput(value)
  if (!input) throw new Error('Input refused')
  return input
}
const questions = {
  q: {
    type: 'choice' as const,
    instructions: 'Choose a category.',
    criteria: { yes: 'yes', other: 'none', mixed: 'multiple' },
  },
}
const ok = (choice = 'yes', max = 0.7, native = true): JudgeOutcome => ({
  status: 'ok',
  answers: {
    q: { type: 'choice', choice, probabilities: { yes: max, other: 1 - max, mixed: 0 }, confidence: 0.99 },
  },
  cached: false,
  model: 'm',
  backend: native ? 'native' : 'text',
  probabilityAvailable: native,
  accounting: { calls: [] },
})
it('keeps 500 independent ids, freezes ordered questions, and redacts arbitrary JSON before dispatch', async () => {
  const suppliedQuestions = structuredClone(questions)
  suppliedQuestions.q.instructions += ' password="q-pass"'
  suppliedQuestions.q.criteria.yes = 'yes token="option-pass"'
  const input = accepted({
    items: Array.from({ length: 500 }, (_, n) => ({
      id: String(n),
      state: {
        password: { nested: 'synthetic-secret' },
        clientSecret: 'camel-sensitive',
        'secret://synthetic': { value: 'reference-sensitive' },
        text: 'password="fixture-pass" tail',
      },
    })),
    questions: suppliedQuestions,
  })
  Reflect.deleteProperty(suppliedQuestions.q.criteria, 'yes')
  suppliedQuestions.q.criteria.yes = 'mutated'
  expect(Object.keys(input.questions.q?.type === 'choice' ? input.questions.q.criteria : {})).toEqual([
    'yes',
    'other',
    'mixed',
  ])
  const seen: unknown[] = []
  const judge: Judge = {
    async judge(_, req, opts) {
      seen.push(req)
      expect(req.questions.q?.type === 'choice' && req.questions.q.criteria.yes).toBe(
        'yes token="[REDACTED]"',
      )
      expect(opts.retry).toBe('once')
      return ok()
    },
  }
  const result = await judgeBatch(judge, input, new AbortController().signal, 'tool-1', Date.now() + 60000)
  expect(
    seen.every(
      (req) => !JSON.stringify(req).includes('q-pass') && !JSON.stringify(req).includes('option-pass'),
    ),
  ).toBe(true)
  expect(result.completed).toHaveLength(500)
  expect(result.pending).toEqual([])
  expect(JSON.stringify(seen)).not.toContain('synthetic-secret')
  expect(seen.every((req) => !JSON.stringify(req).includes('camel-sensitive'))).toBe(true)
  expect(seen.every((req) => !JSON.stringify(req).includes('reference-sensitive'))).toBe(true)
  expect(JSON.stringify(seen)).not.toContain('fixture-pass')
  expect(result.completed[0]).toMatchObject({ id: '0', needsReview: false, probabilityAvailable: true })
})
it('uses maximum native probability with an inclusive 0.7 threshold and reviews other/mixed and text', async () => {
  const input = accepted({ items: [0, 1, 2, 3, 4].map((n) => ({ id: String(n), state: n })), questions })
  const outcomes = [ok(), ok('yes', 0.69), ok('other'), ok('mixed'), ok('yes', 1, false)]
  const judge: Judge = {
    judge: async (_, req) =>
      outcomes[req.state as number] ?? { status: 'failed', reason: 'error', accounting: { calls: [] } },
  }
  const result = await judgeBatch(judge, input, new AbortController().signal, 'tool-2', Date.now() + 60000)
  expect(result.completed.map((row) => row.needsReview)).toEqual([false, true, true, true, true])
  expect(result.completed[4]).toMatchObject({
    probabilityAvailable: false,
    answers: { q: { type: 'choice', choice: 'yes' } },
  })
  expect(JSON.stringify(result.completed[4])).not.toContain('probabilities')
  expect(JSON.stringify(result.completed[4])).not.toContain('confidence')
})
it('returns completed answers and preserves failed accounting when cancellation interrupts remaining items', async () => {
  const input = accepted({
    items: [
      { id: 'done', state: 0 },
      { id: 'pending', state: 1 },
    ],
    questions,
  })
  const controller = new AbortController()
  const judge: Judge = {
    async judge(_, req) {
      if (req.state === 0) return ok()
      controller.abort()
      return {
        status: 'failed',
        reason: 'timeout',
        accounting: {
          calls: [
            {
              invocationId: 'late',
              target: { route: 'r', model: 'm' },
              replayed: false,
              dispatch: 'may-have-sent',
              usage: {
                tokens: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
                credits: 2,
                creditSource: 'estimated',
              },
            },
          ],
        },
      } as JudgeOutcome
    },
  }
  const result = await judgeBatch(judge, input, controller.signal, 'tool-3', Date.now() + 60000)
  expect(result.completed.map((row) => row.id)).toEqual(['done'])
  expect(result.pending).toEqual(['pending'])
  expect(result.partial).toBe(true)
  expect(result.accounting.calls).toHaveLength(1)
})
it('rejects indivisible oversized state and any malformed member before processing the batch', () => {
  expect(batchInput({ items: [{ id: 'huge', state: '漢'.repeat(150000) }], questions })).toBeNull()
  expect(
    batchInput({
      items: [
        { id: 'a', state: null },
        { id: 'b', state: undefined },
      ],
      questions,
    }),
  ).toBeNull()
  expect(batchInput({ items: [{ id: 'x'.repeat(129), state: null }], questions })).toBeNull()
})

it('shares the real sixteen-slot scheduler and preserves accounting from concurrent terminal retries', async () => {
  vi.useFakeTimers()
  const scheduler = createJudgmentScheduler(16)
  const prepared = new Map<string, SideCallOptions>()
  let active = 0,
    peak = 0
  const usage = {
    tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 },
    credits: 1,
    creditSource: 'gateway' as const,
    billing: { usdMicros: 2, source: 'gateway' as const, subscription: false },
  }
  const port = {
    status: async (invocationId: string) => ({ status: 'absent' as const, invocationId }),
    prepare: async (options: SideCallOptions) => {
      prepared.set(options.invocationId ?? 'missing', options)
      return { ...options, requestHash: JSON.stringify(options) } as unknown as PreparedSideCall
    },
    invoke: async (receipt: PreparedSideCall): Promise<SideCallResult> => {
      active++
      peak = Math.max(peak, active)
      try {
        const options = prepared.get(receipt.invocationId)
        if (!options) throw new Error('Unknown receipt')
        const state = (options.payload as { state: number }).state
        if (state === 0)
          return {
            status: 'ok',
            invocationId: receipt.invocationId,
            text: '',
            json: { q: { type: 'noul', noul: 0.9 } },
            usage,
            latencyMs: 0,
            replayed: false,
          }
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return {
          status: 'failed',
          invocationId: receipt.invocationId,
          reason: 'adapter-error',
          retryable: true,
          dispatch: 'may-have-sent',
          usage,
          latencyMs: 1000,
          replayed: false,
        }
      } finally {
        active--
      }
    },
  } satisfies SideCallPort
  const judge = createJudge({
    port,
    chain: [{ route: 'r', model: 'm', native: true }],
    scheduler,
    cache: createAnswerCache(null, { ttlMs: 1000, maxEntries: 2000 }),
    now: Date.now,
  })
  const input = batchInput({
    items: Array.from({ length: 21 }, (_, n) => ({ id: String(n), state: n })),
    questions: { q: { type: 'noul', instructions: 'Synthetic?' } },
  })
  if (!input) throw new Error('input refused')
  try {
    const pending = judgeBatch(judge, input, new AbortController().signal, 'concurrent', Date.now() + 60000)
    await vi.advanceTimersByTimeAsync(20000)
    const result = await pending
    expect(peak).toBe(16)
    expect(result.completed).toHaveLength(21)
    expect(result.completed[0]).toMatchObject({ id: '0', needsReview: false })
    expect(result.completed.filter((row) => row.failure === 'error')).toHaveLength(20)
    expect(result.accounting.calls).toHaveLength(41)
    expect(result.accounting.calls.every((call) => call.usage?.billing?.usdMicros === 2)).toBe(true)
  } finally {
    scheduler.dispose()
    vi.useRealTimers()
  }
})
