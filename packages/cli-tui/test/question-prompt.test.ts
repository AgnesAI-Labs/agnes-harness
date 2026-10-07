import { describe, expect, it } from 'vitest'
import { answerQuestion } from '../src/question-prompt.js'

describe('question prompt', () => {
  it('accepts numbered single/multiple choice and free text, and rejects invalid choices', () => {
    const q = { id: 'call', questions: [{ id: 'q', question: 'Choose', options: ['A', 'B'] }] }
    expect(answerQuestion(q, '2')).toBe('[question-answer call] {"q":"B"}')
    expect(answerQuestion({ ...q, questions: [{ ...q.questions[0]!, multiple: true }] }, '1, 2')).toBe(
      '[question-answer call] {"q":["A","B"]}',
    )
    expect(answerQuestion({ id: 'call', questions: [{ id: 'q', question: 'Explain' }] }, 'hello')).toBe(
      '[question-answer call] {"q":"hello"}',
    )
    expect(() => answerQuestion(q, '3')).toThrow('Choose the listed')
  })
})
