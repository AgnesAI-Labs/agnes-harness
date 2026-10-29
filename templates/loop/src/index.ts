import { defineWorkflowLoop, workflowModelText } from '@agnes/plugin-runtime'

// Add business stages, tools, confirmation and deliverables to this definition.
const workflow = defineWorkflowLoop({
  id: '__PACKAGE_NAME__',
  version: '0.1.0',
  stages: [
    {
      name: 'answer',
      async run(ctx, state, signal) {
        return { answer: await workflowModelText(ctx, 'Answer the user briefly.', state.input, signal) }
      },
    },
  ],
})

export const main = workflow.main
export const loop = workflow.factory
