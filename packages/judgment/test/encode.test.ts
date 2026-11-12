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
