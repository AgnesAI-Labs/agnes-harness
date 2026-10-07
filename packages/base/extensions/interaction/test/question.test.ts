import { readFileSync } from 'node:fs'
import { checkManifest } from '@agnes/extension-api'
import { answerPrefix, parseAnswer } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { questionProjection } from '../src/index.js'

const questions = [
  { id: 'single', question: 'Pick one', options: ['A', 'B'] },
  { id: 'multi', question: 'Pick several', options: ['A', 'B'], multiple: true },
  { id: 'text', question: 'Explain' },
]
describe('persisted user questions', () => {
  it('validates full single/multiple/free text answers and refuses malformed or mismatched replies', () => {
    expect(
      checkManifest(JSON.parse(readFileSync(new URL('../agnes.extension.json', import.meta.url), 'utf8'))).ok,
    ).toBe(true)
    const answers = { single: 'A', multi: ['A', 'B'], text: 'Free answer' }
    expect(parseAnswer('q', questions, answerPrefix('q') + JSON.stringify(answers))).toEqual(answers)
    for (const invalid of [
      { ...answers, single: 'C' },
      { ...answers, multi: 'A' },
      { ...answers, multi: ['A', 'A'] },
      { ...answers, text: '' },
      { single: 'A' },
      { ...answers, extra: 'x' },
    ])
      expect(parseAnswer('q', questions, answerPrefix('q') + JSON.stringify(invalid))).toBeUndefined()
    expect(parseAnswer('other', questions, answerPrefix('q') + JSON.stringify(answers))).toBeUndefined()
  })
  it('rebuilds questions and answers entirely from ledger events, without process-local state', () => {
    const request = {
      type: 'x/agnes/interaction/requested',
      data: { id: 'q', toolUseId: 'q', questions, answer: null },
    }
    const answer = {
      type: 'user/message',
      data: {
        content: [
          {
            type: 'text',
            text: answerPrefix('q') + JSON.stringify({ single: 'B', multi: ['A'], text: 'Yes' }),
          },
        ],
      },
    }
    const fold = questionProjection.apply
    const event = (value: unknown) => value as Parameters<typeof fold>[1]
    const state = fold(fold(questionProjection.init(), event(request)), event(answer))
    expect(state.questions[0]?.answer).toEqual({ single: 'B', multi: ['A'], text: 'Yes' })
    expect(fold(state, event(request))).toEqual(state)
  })
})
