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
export type Answers = Record<string, string | string[]>

export function questionSurface(id: string, questions: Questions): import('@agnes/protocol').UiSurface {
  const properties = Object.fromEntries(
    questions.map((q) => {
      const item = {
        type: 'string',
        minLength: 1,
        maxLength: 8192,
        ...(q.options && !q.allowFreeText ? { enum: q.options } : {}),
      }
      return [
        q.id,
        {
          title: q.question,
          ...(q.multiple
            ? { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: item }
            : item),
          ...(q.options ? { 'x-ui-choices': q.options } : {}),
        },
      ]
    }),
  )
  return {
    id,
    revision: 1,
    title: 'Questions / 问题',
    placement: { inline: true, workbench: true, preferred: 'inline' },
    components: [
      {
        id: 'answers',
        kind: 'form',
        dataKey: 'draft',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: questions.map((q) => q.id),
          properties,
        },
        actionIds: ['submit'],
      },
    ],
    data: { draft: {} },
    actions: [
      {
        id: 'submit',
        label: 'Submit / 提交',
        tool: 'ui_submit',
        style: 'primary',
        argsTemplate: { surfaceId: { literal: id }, answers: { from: 'input', key: 'answers' } },
        paramsSchema: {
          type: 'object',
          required: ['surfaceId', 'answers'],
          additionalProperties: false,
          properties: { surfaceId: { const: id }, answers: { type: 'object' } },
        },
      },
    ],
  }
}
