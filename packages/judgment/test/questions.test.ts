import { expect, it } from 'vitest'
import { parseNativeAnswers, validateRequest } from '../src/questions.js'

const req = { state: { text: 'work' }, questions: { q: { type: 'noul' as const, instructions: 'done?' } } }
it('rejects the whole request when one question is invalid', () => {
  expect(validateRequest(req)).toEqual({ ok: true })
  expect(
    validateRequest({
      ...req,
      questions: { ...req.questions, bad: { type: 'score', instructions: 'rate', criteria: ['one'] } },
    } as any).ok,
  ).toBe(false)
})
it('keeps option order', () => {
  const criteria = { zebra: null, apple: 'second' }
  expect(
    validateRequest({ ...req, questions: { q: { type: 'choice', instructions: 'pick', criteria } } }).ok,
  ).toBe(true)
  expect(Object.keys(criteria)).toEqual(['zebra', 'apple'])
})
it.each([
  {},
  { state: NaN, questions: req.questions },
  { ...req, questions: {} },
  { ...req, questions: { q: { type: 'noul', instructions: '' } } },
])('rejects malformed requests %j', (value) => {
  expect(validateRequest(value as any).ok).toBe(false)
})
it('requires complete finite answers matching every question', () => {
  expect(parseNativeAnswers({ q: { type: 'noul', noul: 0.5 } }, req)).toEqual({
    q: { type: 'noul', noul: 0.5 },
  })
  for (const answers of [{}, { q: { type: 'noul', noul: 2 } }, { q: { type: 'noul', noul: NaN } }])
    expect(parseNativeAnswers(answers, req)).toBeNull()
})
