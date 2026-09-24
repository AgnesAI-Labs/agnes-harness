import { defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'

export const compactTool = defineTool({
  name: 'compact',
  description: 'Ask the harness to compact conversation history now, optionally preserving specific context.',
  parameters: Type.Object(
    { instructions: Type.Optional(Type.String({ maxLength: 4000 })) },
    { additionalProperties: false },
  ),
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: 'safe',
    costHint: {},
    deferLoading: false,
    requiresApproval: 'never',
  },
  async execute(args, context) {
    context.requestCompaction(args.instructions)
    return { content: [{ type: 'text' as const, text: 'compaction requested' }] }
  },
})
