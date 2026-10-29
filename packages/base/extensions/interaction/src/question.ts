import { UI_SUBMIT_TOOL } from '@agnes/intelligent-ui-contract'
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
          label: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 32,
              description:
                'Optional short name for the question (a few words), shown on its step and in the answer summary. Defaults to a shortened question.',
            }),
          ),
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

/**
 * Marks a surface as an ask_user_question form, so clients can show it as a question card. `deadline`
 * (epoch ms) is when the tool stops waiting; at or before render time the agent did not wait.
 */
export const QUESTION_MARKER_KEY = 'question'
export type QuestionMarker = { kind: 'ask_user_question'; deadline: number; labels?: Record<string, string> }

export function questionSurface(
  id: string,
  questions: Questions,
  deadline = 0,
): import('@agnes/protocol').UiSurface {
  const labels = Object.fromEntries(questions.flatMap((q) => (q.label ? [[q.id, q.label]] : [])))
  const marker: QuestionMarker = {
    kind: 'ask_user_question',
    deadline,
    ...(Object.keys(labels).length ? { labels } : {}),
  }
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
    // Plain fallback for text clients; Web shows the localized `titleKey`.
    title: 'Questions',
    titleKey: 'ui.question.title',
    placement: { inline: true, workbench: false, preferred: 'inline' },
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
    data: { draft: {}, [QUESTION_MARKER_KEY]: marker },
    actions: [
      {
        id: 'submit',
        label: 'Submit',
        tool: UI_SUBMIT_TOOL,
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
