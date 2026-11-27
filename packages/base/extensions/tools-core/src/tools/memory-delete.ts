import { defineTool } from '@agnes/plugin-runtime'
import { failureCode } from '../guards/feedback.js'
import { isAttestedPreEffect } from './hidden-paragraphs.js'
import { MemoryDeleteParams } from './schemas.js'

export const memoryDeleteTool = defineTool({
  name: 'memory_delete',
  description:
    'Delete an agent-authored workspace memory topic. MEMORY.md, linked topics, and topics containing hidden or human-authored content are protected.',
  parameters: MemoryDeleteParams,
  meta: {
    paths: [{ arg: 'path', access: 'write' }],
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: 'never',
    deferLoading: true,
    requiresApproval: 'destructive',
  },
  async execute(args, ctx) {
    if (!ctx.fs.remove)
      return {
        isError: true,
        structured: { code: 'MEMORY_DELETE_UNAVAILABLE' },
        content: [{ type: 'text', text: 'Memory topic deletion is unavailable.' }],
      }
    try {
      await ctx.fs.remove(args.path)
    } catch (error) {
      if (!isAttestedPreEffect(error)) throw error
      const code = failureCode(error, 'MEMORY_SCOPE_DENIED')
      return {
        isError: true,
        structured: { code },
        content: [
          {
            type: 'text',
            text:
              code === 'MEMORY_TOPIC_REFERENCED'
                ? 'Remove the topic link from MEMORY.md first, or ask the user to remove it on the Memory page.'
                : `${code}. Check the topic on the Memory page before trying again.`,
          },
        ],
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: `Deleted memory topic ${args.path}. It is immediately hidden from read, list, and memory_recall in this turn; the injected memory snapshot updates next turn.`,
        },
      ],
    }
  },
})
