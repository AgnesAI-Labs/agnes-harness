import { type Static, Type } from '@sinclair/typebox'

export const QuestionParams = Type.Object(
  {
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 60000,
        description:
          'Wait at most this many milliseconds. Default 0 continues immediately; late answers arrive as new user input.',
      }),
    ),
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
          question: Type.String({ minLength: 1, maxLength: 1024 }),
          options: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
              minItems: 1,
              maxItems: 12,
              uniqueItems: true,
            }),
          ),
          multiple: Type.Optional(Type.Boolean()),
          allowFreeText: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 4 },
    ),
  },
  { additionalProperties: false },
)
export type Questions = Static<typeof QuestionParams>['questions']
export { answerPrefix, parseAnswer, type QuestionAnswers as Answers } from '@agnes/protocol'
