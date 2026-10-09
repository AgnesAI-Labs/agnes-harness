import { readFileSync } from 'node:fs'
import { checkManifest } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { questionProjection } from '../src/index.js'
import { questionSurface } from '../src/question.js'
import { interactionSurfaceId } from '../../../src/interaction-surfaces.js'

const questions = [
  { id: 'single', question: 'Pick one', options: ['A', 'B'] },
  { id: 'multi', question: 'Pick several', options: ['A', 'B'], multiple: true },
  { id: 'text', question: 'Explain' },
]
describe('surface questions', () => {
  it('validates single/multiple/free text and rejects incomplete or invalid answers', () => {
    expect(
      checkManifest(JSON.parse(readFileSync(new URL('../agnes.extension.json', import.meta.url), 'utf8'))).ok,
    ).toBe(true)
    const surface = questionSurface('question', questions)
    const form = surface.components[0]!
    if (form.kind !== 'form') throw new Error('Expected form')
    const schema = Type.Unsafe(typeof form.schema === 'boolean' ? {} : form.schema)
    const answers = { single: 'A', multi: ['A', 'B'], text: 'Free answer' }
    expect(validateAgainst(schema, answers).ok).toBe(true)
    for (const invalid of [
      { ...answers, single: 'C' },
      { ...answers, multi: 'A' },
      { ...answers, multi: ['A', 'A'] },
      { ...answers, text: '' },
      { single: 'A' },
      { ...answers, extra: 'x' },
    ])
      expect(validateAgainst(schema, invalid).ok).toBe(false)
    expect(surface.actions[0]?.tool).toBe('ui_submit')
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
