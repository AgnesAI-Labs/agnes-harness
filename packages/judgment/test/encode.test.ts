import { estimateTokens } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { nativePayload, planRequest, splitRequest } from '../src/encode.js'
import type { JudgmentRequest } from '../src/questions.js'

it('omits optional undefined noul criteria at the same exact budget in both planners', async () => {
  const supplied = {
    state: { text: '汉🙂' },
    questions: {
      first: { type: 'noul' as const, instructions: 'Synthetic?', criteria: undefined },
      second: { type: 'noul' as const, instructions: 'Next?' },
    },
  }
  const req = supplied as unknown as JudgmentRequest
  const expected =
    '{"state":{"text":"汉🙂"},"questions":{"first":{"type":"noul","instructions":"Synthetic?"},"second":{"type":"noul","instructions":"Next?"}}}'
  const size = estimateTokens(expected)
  const budgets = { state: size, request: size }
  const sync = splitRequest(req, budgets)
  const cooperative = await planRequest(req, budgets, {
    signal: new AbortController().signal,
    end: Date.now() + 60000,
  })
  expect(sync).toEqual([req])
  expect(cooperative).toEqual(sync)
  expect(JSON.stringify(nativePayload(cooperative[0] as JudgmentRequest))).toBe(expected)
  expect(Object.keys(cooperative[0]?.questions ?? {})).toEqual(['first', 'second'])
  expect(Object.hasOwn(supplied.questions.first, 'criteria')).toBe(true)
})

it.each([
  { state: { value: undefined }, questions: { q: { type: 'noul', instructions: 'Synthetic?' } } },
  {
    state: null,
    questions: { q: { type: 'noul', instructions: 'Synthetic?', criteria: { true: undefined } } },
  },
])('keeps state and nested undefined criteria invalid in both planners', async (value) => {
  const req = value as unknown as JudgmentRequest
  const budgets = { state: 24000, request: 48000 }
  expect(() => splitRequest(req, budgets)).toThrow()
  await expect(
    planRequest(req, budgets, { signal: new AbortController().signal, end: Date.now() + 60000 }),
  ).rejects.toThrow()
})

it('rejects an unsplittable state plus single question over 24000 tokens', () => {
  const req = { state: 'x'.repeat(150000), questions: { q: { type: 'noul' as const, instructions: 'yes?' } } }
  expect(() => splitRequest(req, { state: 24000, request: 48000 })).toThrow(/fit/)
})
it('splits when the request exceeds 48000 tokens', () => {
  const req = {
    state: 'shared',
    questions: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `q${i}`,
        { type: 'noul' as const, instructions: 'x'.repeat(24000) },
      ]),
    ),
  }
  const parts = splitRequest(req, { state: 24000, request: 48000 })
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.flatMap((p) => Object.keys(p.questions))).toEqual(Object.keys(req.questions))
  for (const part of parts) {
    expect(part.state).toBe(req.state)
    expect(estimateTokens(JSON.stringify(nativePayload(part)))).toBeLessThanOrEqual(48000)
  }
})
it('preserves state and option order at exact token boundaries', () => {
  const req = {
    state: { a: 1 },
    questions: {
      q: { type: 'choice' as const, instructions: 'pick', criteria: { zebra: null, apple: null } },
    },
  }
  const size = estimateTokens(JSON.stringify(nativePayload(req)))
  expect(splitRequest(req, { state: size, request: size })).toEqual([req])
  expect(Object.keys((nativePayload(req) as any).questions.q.criteria)).toEqual(['zebra', 'apple'])
})

it('keeps cooperative planning identical at mixed CJK/emoji exact atomic and request boundaries', async () => {
  const { planRequest } = await import('../src/encode.js')
  const req = {
    state: { text: '汉🙂' },
    questions: {
      first: { type: 'choice' as const, instructions: '选🙂', criteria: { zebra: '甲', apple: '乙' } },
      second: { type: 'score' as const, instructions: '评', criteria: ['低', '高'] },
    },
  }
  const atomic = Math.max(
    ...Object.entries(req.questions).map(([id, q]) =>
      estimateTokens(JSON.stringify({ state: req.state, questions: { [id]: q } })),
    ),
  )
  const complete = estimateTokens(JSON.stringify({ state: req.state, questions: req.questions }))
  const budgets = { state: atomic, request: complete - 1 }
  const parts = await planRequest(req, budgets, {
    signal: new AbortController().signal,
    end: Date.now() + 60000,
  })
  expect(parts.map((part) => Object.keys(part.questions))).toEqual([['first'], ['second']])
  expect(parts).toEqual(splitRequest(req, budgets))
  const first = parts[0]?.questions.first
  if (first?.type !== 'choice') throw new Error('Missing first choice')
  expect(Object.keys(first.criteria)).toEqual(['zebra', 'apple'])
  await expect(
    planRequest(
      req,
      { state: atomic - 1, request: complete },
      { signal: new AbortController().signal, end: Date.now() + 60000 },
    ),
  ).rejects.toThrow(/fit/)
})

it('yields per-question planning and stops before reading the remaining questions on cancellation', async () => {
  const { planRequest } = await import('../src/encode.js')
  let inspected = 0
  const questions = Object.fromEntries(
    Array.from({ length: 200 }, (_, n) => [
      `q${n}`,
      {
        type: 'noul' as const,
        get instructions() {
          inspected++
          return 'Synthetic?'
        },
      },
    ]),
  )
  const controller = new AbortController()
  const cancel = setImmediate(() => controller.abort())
  try {
    await expect(
      planRequest(
        { state: null, questions },
        { state: 24000, request: 48000 },
        { signal: controller.signal, end: Date.now() + 60000 },
      ),
    ).rejects.toThrow()
    expect(inspected).toBeGreaterThan(0)
    expect(inspected).toBeLessThan(200)
  } finally {
    clearImmediate(cancel)
  }
})
