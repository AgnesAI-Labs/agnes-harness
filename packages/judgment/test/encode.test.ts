import { estimateTokens } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { nativePayload, splitRequest } from '../src/encode.js'

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
