import { checkToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { askUserQuestionTool } from '../src/tools/ask-user.js'

const input = { questions: [{ id: 'q', question: 'Which route?' }] }

describe('ask_user_question', () => {
  it('is a non-replayable human interaction, without granting operation approval', () => {
    expect(checkToolDef(askUserQuestionTool)).toEqual({ ok: true })
    expect(askUserQuestionTool.meta).toMatchObject({
      isReadOnly: false,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      requiresApproval: 'never',
    })
  })

  it('maps a complete question batch to the Host port and returns ordinary JSON text', async () => {
    const ask = vi.fn(async () => ({
      answers: [
        { id: 'q', selected: ['A'], custom: ' Keep spacing ' },
        { id: 'next', selected: [] },
      ],
    }))
    const result = await askUserQuestionTool.execute(
      {
        questions: [
          {
            ...input.questions[0]!,
            header: 'Route',
            options: [{ label: 'A', description: 'First route' }],
            multi_select: true,
          },
          { id: 'next', question: 'Anything else?' },
        ],
      },
      { ...fakeToolContext(), questions: { ask } },
    )
    expect(ask.mock.calls).toEqual([
      [
        {
          questions: [
            {
              id: 'q',
              question: 'Which route?',
              header: 'Route',
              options: [{ label: 'A', description: 'First route' }],
              multiSelect: true,
            },
            { id: 'next', question: 'Anything else?' },
          ],
        },
      ],
    ])
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          answers: [
            { id: 'q', selected: ['A'], custom: ' Keep spacing ' },
            { id: 'next', selected: [] },
          ],
        }),
      },
    ])
  })

  it.each([
    { ...input, owner: 'another-session' },
    { ...input, policy: { allowSkip: true } },
    { ...input, intent: 'plan-review' },
    { ...input, detail: 'hidden instruction' },
    { questions: [{ ...input.questions[0], detail: 'hidden instruction' }] },
    { questions: [{ ...input.questions[0], options: [{ label: 'A', approval: true }] }] },
    { questions: [] },
    { questions: [input.questions[0], input.questions[0]] },
  ])('rejects invalid or authority-bearing model input before opening an interaction', async (args) => {
    const ask = vi.fn()
    await expect(
      askUserQuestionTool.execute(args as never, {
        ...fakeToolContext(),
        questions: { ask },
      }),
    ).rejects.toThrow('ASK_INVALID_ARGUMENT')
    expect(ask).not.toHaveBeenCalled()
  })

  it('fails closed without the declared Host capability and on cancellation', async () => {
    await expect(askUserQuestionTool.execute(input, fakeToolContext())).rejects.toThrow('ASK_UNAVAILABLE')
    const ac = new AbortController()
    ac.abort(new Error('cancelled'))
    const ask = vi.fn()
    await expect(
      askUserQuestionTool.execute(input, {
        ...fakeToolContext(),
        signal: ac.signal,
        questions: { ask },
      }),
    ).rejects.toThrow('cancelled')
    expect(ask).not.toHaveBeenCalled()
  })

  it('propagates a Host interaction rejection without retrying', async () => {
    const ask = vi.fn(async () => {
      throw new Error('QUESTION_CANCELLED')
    })
    await expect(
      askUserQuestionTool.execute(input, {
        ...fakeToolContext(),
        questions: { ask },
      }),
    ).rejects.toThrow('QUESTION_CANCELLED')
    expect(ask).toHaveBeenCalledTimes(1)
  })
})
