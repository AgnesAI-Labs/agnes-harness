import { Type } from '@sinclair/typebox'
import { defineWorkflowLoop, workflowTool, workflowValue } from '@agnes/plugin-runtime'

const inspect = workflowTool(
  'acme_inspect',
  'Read a synthetic ACME-001 maintenance record. No external systems or files.',
  Type.Object({}, { additionalProperties: false }),
  () => ({ asset: 'ACME-001', status: 'inspection-due', recommendation: 'Inspect filter', revision: '1.0.0' }),
)
export const { main } = defineWorkflowLoop({
  id: 'acme.maintenance', version: '1.0.0', name: 'Acme maintenance', readOnly: true,
  tools: [inspect],
  stages: [{
    name: 'inspection',
    async run(ctx, _state, signal) {
      return { record: workflowValue(await ctx.tools.execute({ name: 'acme_inspect', args: {} }, signal)) }
    },
  }],
})
