import { readFileSync } from 'node:fs'
import { bundledExtensionManifest, checkManifest } from '@agnes/extension-api'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { interactionSurfaceId } from '../../../src/interaction-surfaces.js'
import { pendingQuestionText, questionProjection } from '../src/index.js'
import { questionSurface } from '../src/question.js'

const questions = [
  { id: 'single', question: 'Pick one', options: ['A', 'B'] },
  { id: 'multi', question: 'Pick several', options: ['A', 'B'], multiple: true },
  { id: 'text', question: 'Explain' },
]
describe('surface questions', () => {
  it('validates single/multiple/free text and rejects incomplete or invalid answers', () => {
    expect(
      checkManifest(
        bundledExtensionManifest(
          JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
        ),
      ).ok,
    ).toBe(true)
    const surface = questionSurface('question', questions)
    const form = surface.components[0]!
    if (form.kind !== 'form' || !('schema' in form)) throw new Error('Expected form')
    const validate = new Ajv2020({ strict: false }).compile(form.schema)
    const answers = { single: 'A', multi: ['A', 'B'], text: 'Free answer' }
    expect(validate(answers)).toBe(true)
    for (const invalid of [
      { ...answers, single: 'C' },
      { ...answers, multi: 'A' },
      { ...answers, multi: ['A', 'A'] },
      { ...answers, text: '' },
      { single: 'A' },
      { ...answers, extra: 'x' },
    ])
      expect(validate(invalid)).toBe(false)
    expect(surface.actions[0]?.tool).toBe('ui_submit')
  })
  it('marks an inline-only, localizable question card with its deadline and optional labels', () => {
    const surface = questionSurface(
      'question',
      [...questions, { id: 'named', question: 'Pick a city', label: 'City' }],
      42,
    )
    expect(surface.placement).toEqual({ inline: true, workbench: false, preferred: 'inline' })
    expect(surface.titleKey).toBe('ui.question.title')
    expect(JSON.stringify(surface)).not.toMatch(/问题|提交|\/ /)
    expect(surface.data.question).toEqual({
      kind: 'ask_user_question',
      deadline: 42,
      labels: { named: 'City' },
    })
    expect(questionSurface('question', questions).data.question).toEqual({
      kind: 'ask_user_question',
      deadline: 0,
    })
  })
  it('tells the model the questions are shown without listing them', () => {
    const text = pendingQuestionText(questions.length)
    expect(text).toContain('All 3 questions are shown to the user')
    expect(text).toMatch(/Do not repeat/)
    for (const question of questions) expect(text).not.toContain(question.question)
    expect(text).not.toMatch(/\n1\.|\]\(/)
    expect(pendingQuestionText(1)).toMatch(/^The question is shown/)
  })
  it('recovers late answers from authenticated action facts and ignores refusals and user prose', () => {
    const fold = questionProjection.apply
    const event = (type: string, data: unknown, origin = 'ext:agnes/intelligent-ui') =>
      ({ type, data, origin }) as Parameters<typeof fold>[1]
    const request = event(
      'x/agnes/interaction/requested',
      { id: 'q', toolUseId: 'q', questions, answer: null },
      'ext:agnes/interaction',
    )
    let state = fold(questionProjection.init(), request)
    const answers = { single: 'B', multi: ['A'], text: 'Late' }
    const received = event('x/agnes/intelligent-ui/action.received', {
      record: {
        request: { commandId: 'cmd' },
        invocation: { tool: 'ui_submit', args: { surfaceId: interactionSurfaceId('q'), answers } },
      },
    })
    state = fold(state, received)
    expect(
      fold(state, event('x/agnes/intelligent-ui/action.rejected', { commandId: 'cmd' })).questions[0]?.answer,
    ).toBeNull()
    expect(
      fold(
        state,
        event('user/message', { content: [{ type: 'text', text: JSON.stringify(answers) }] }, 'user'),
      ).questions[0]?.answer,
    ).toBeNull()
    expect(
      fold(state, event('x/agnes/intelligent-ui/action.succeeded', { commandId: 'cmd' }, 'user')).questions[0]
        ?.answer,
    ).toBeNull()
    const completed = fold(state, event('x/agnes/intelligent-ui/action.succeeded', { commandId: 'cmd' }))
    expect(completed.questions[0]?.answer).toEqual(answers)
    expect(fold(completed, request)).toEqual(completed)
  })
})
