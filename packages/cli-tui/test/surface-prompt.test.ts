import { describe, expect, it } from 'vitest'
import { numberedSurfaceInput } from '@agnes/protocol/intelligent-ui'
import { questionSurface } from '../../base/extensions/interaction/src/question.js'
import { pendingSurface } from '../src/surface-prompt.js'

describe('surface prompt', () => {
  it('submits numbered single/multiple choice and free text as ordinary form input', () => {
    const single = questionSurface('question', [{ id: 'pick', question: 'Choose', options: ['A', 'B'] }])
    expect(numberedSurfaceInput(single, '2')).toEqual({
      actionId: 'submit',
      input: { answers: { pick: 'B' } },
      selection: {},
    })
    const multi = questionSurface('multi', [
      { id: 'pick', question: 'Choose', options: ['A', 'B'], multiple: true },
    ])
    expect(numberedSurfaceInput(multi, '1, 2').input).toEqual({ answers: { pick: ['A', 'B'] } })
    const free = questionSurface('text', [{ id: 'explain', question: 'Explain' }])
    expect(numberedSurfaceInput(free, 'hello').input).toEqual({ answers: { explain: 'hello' } })
    expect(() => numberedSurfaceInput(single, '3')).toThrow('Choose the listed')
    expect(() => numberedSurfaceInput(multi, '1,1')).toThrow('Choose the listed')
  })
  it('recovers open forms and locks an admitted action after refresh', () => {
    const record = {
      surface: questionSurface('q', [{ id: 'pick', question: 'Pick' }]),
      status: 'open' as const,
      owner: 'agnes/intelligent-ui',
      lane: 'main',
      taskId: 'task',
      createdSeq: 1,
      updatedSeq: 1,
    }
    const page = { sessionId: 'session', lastSeq: 1, surfaces: [record], actions: [] }
    expect(pendingSurface(page)).toEqual(record)
    expect(
      pendingSurface({
        ...page,
        actions: [
          {
            sessionId: 'session',
            surfaceId: 'q',
            revision: 1,
            actionId: 'submit',
            commandId: 'one',
            status: 'received',
            seq: 2,
            duplicate: false,
          },
        ],
      }),
    ).toBeUndefined()
    expect(pendingSurface({ ...page, surfaces: [{ ...record, status: 'closed' }] })).toBeUndefined()
  })
})
