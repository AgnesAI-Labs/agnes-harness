import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

export const subagentRecapTool = defineTool({
  name: 'subagent_recap',
  description: 'Read the runtime recap of all child tasks, verified artifacts, approvals and next actions.',
  parameters: Type.Object({}, { additionalProperties: false }),
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe',
    deferLoading: 'auto',
    requiresApproval: 'never',
  },
  async execute(_args, ctx) {
    if (!ctx.subagent.recap)
      return {
        isError: true,
        content: [{ type: 'text', text: 'Child recap is unavailable in this session.' }],
      }
    const recap = await ctx.subagent.recap()
    return { content: [{ type: 'text', text: recap.markdown }], structured: recap }
  },
})
