import type { UiSurface } from '@agnes/protocol'

/** A public UI wire fixture, independent of the Harness-private interaction tool. */
export function choiceSurface(id: string): UiSurface {
  return {
    id,
    revision: 1,
    title: 'Pick',
    placement: { inline: true, workbench: false, preferred: 'inline' },
    components: [
      {
        id: 'answers',
        kind: 'form',
        dataKey: 'draft',
        actionIds: ['submit'],
        schema: {
          type: 'object',
          properties: {
            pick: { type: 'string', title: 'Choose', enum: ['A', 'B'], 'x-ui-choices': ['A', 'B'] },
          },
          required: ['pick'],
          additionalProperties: false,
        },
      },
    ],
    data: { draft: {}, question: { kind: 'ask_user_question', deadline: 0 } },
    actions: [
      {
        id: 'submit',
        label: 'Submit',
        tool: 'ui_submit',
        style: 'primary',
        argsTemplate: { surfaceId: { literal: id }, answers: { from: 'input', key: 'answers' } },
        paramsSchema: {
          type: 'object',
          properties: { surfaceId: { const: id }, answers: { type: 'object' } },
          required: ['surfaceId', 'answers'],
          additionalProperties: false,
        },
      },
    ],
  }
}
