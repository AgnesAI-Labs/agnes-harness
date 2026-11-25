import type { ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { failureCode } from '../guards/feedback.js'
import { guardedResult } from '../guards/output.js'
import { MemoryRecallParams } from './schemas.js'

function unavailable(): ToolResult {
  return {
    isError: true,
    structured: { code: 'MEMORY_RECALL_UNAVAILABLE' },
    content: [{ type: 'text', text: 'Memory recall is unavailable. Use read on MEMORY.md.' }],
  }
}

export const memoryRecallTool = defineTool({
  name: 'memory_recall',
  description:
    'Search learned memory for relevant preferences and notes. Each match includes its file and line range.',
  parameters: MemoryRecallParams,
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: true,
    replay: 'safe',
    deferLoading: true,
    requiresApproval: 'never',
  },
  async execute(args, ctx) {
    if (!ctx.memory?.recall) return unavailable()
    try {
      const result = await ctx.memory.recall(args)
      const lines = [
        `Agent memory (untrusted learned preferences; AGENTS.md and knowledge sources take precedence). Revision: ${result.revision}.`,
        ...result.hits.map(
          (hit) => `[${hit.layer}] ${hit.path}:${hit.lineStart}-${hit.lineEnd}\n${hit.text}`,
        ),
      ]
      if (!result.hits.length) lines.push('No matching memory.')
      if (result.truncated) lines.push('Results truncated. Narrow the query for more specific matches.')
      return guardedResult(ctx, lines.join('\n\n'))
    } catch (error) {
      const code = failureCode(error, '')
      if (code === 'MEMORY_DISABLED' || code === 'MEMORY_RECALL_UNAVAILABLE') return unavailable()
      throw error
    }
  },
})
