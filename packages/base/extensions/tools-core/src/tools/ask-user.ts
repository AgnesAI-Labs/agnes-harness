import { defineTool } from '@agnes/extension-api'
import { validateAgainst, validateQuestionRequest } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'

// Model-facing shape follows DSH tool-ask-user; host-only intent and authority fields stay absent.
export const AskUserQuestionParams = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          question: Type.String(),
          header: Type.Optional(Type.String()),
          options: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  label: Type.String(),
                  description: Type.Optional(Type.String()),
                },
                { additionalProperties: false },
              ),
            ),
          ),
          multi_select: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
)

export const askUserQuestionTool = defineTool({
  name: 'ask_user_question',
  description:
    'Ask the user a concise question when a choice or missing information is needed before proceeding. Offer concise options; put a recommended option first and append "(Recommended)" to its label. An answer does not grant permission to execute another operation.',
  parameters: AskUserQuestionParams,
  meta: {
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    isOpenWorld: true,
    replay: 'never',
    costHint: {},
    deferLoading: false,
    requiresApproval: 'never',
  },
  async execute(args, ctx) {
    if (!validateAgainst(AskUserQuestionParams, args).ok) throw new Error('ASK_INVALID_ARGUMENT')
    const request = {
      questions: args.questions.map((question) => ({
        id: question.id,
        question: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.options === undefined
          ? {}
          : { options: question.options.map((option) => ({ ...option })) }),
        ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
      })),
    }
    if (!validateQuestionRequest(request).ok) throw new Error('ASK_INVALID_ARGUMENT')
    ctx.signal.throwIfAborted()
    if (!ctx.questions) throw new Error('ASK_UNAVAILABLE')
    // Host binds this port to the current call, cancellation lifetime and human-answer policy.
    const answer = await ctx.questions.ask(request)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            answers: answer.answers.map((item) => ({
              id: item.id,
              selected: [...item.selected],
              ...(item.custom === undefined ? {} : { custom: item.custom }),
            })),
          }),
        },
      ],
    }
  },
})
