import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

const childKey = Type.String({ minLength: 1 })
const target = Type.Object({ childKey }, { additionalProperties: false })
const meta = {
  isReadOnly: false,
  isConcurrencySafe: true,
  isDestructive: false,
  isOpenWorld: false,
  replay: 'never' as const,
  deferLoading: 'auto' as const,
}
type Result = Awaited<ReturnType<NonNullable<ToolContext['subagent']['pause']>>>

function unsupported(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }], details: { code: 'E_UNSUPPORTED' } }
}
function report(result: Result): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { ...result } }
}

export const subagentPauseTool = defineTool({
  name: 'subagent_pause',
  description: 'Pause a child at a checkpoint and keep its work for resume.',
  parameters: Type.Object(
    {
      childKey,
      reason: Type.Optional(
        Type.Union([Type.Literal('parent_pause'), Type.Literal('user_pause'), Type.Literal('budget_pause')]),
      ),
    },
    { additionalProperties: false },
  ),
  meta,
  async execute({ childKey, reason }, ctx) {
    if (!ctx.subagent.pause) return unsupported('Checkpoint pause is unavailable. Use interrupt or cancel.')
    return report(await ctx.subagent.pause(childKey, reason ? { reason } : {}))
  },
})

export const subagentResumeTool = defineTool({
  name: 'subagent_resume',
  description: 'Resume a child from its checkpoint.',
  parameters: target,
  meta,
  async execute({ childKey }, ctx) {
    const { previousStatus, status, executionState } = await ctx.subagent.resume(childKey)
    if (!previousStatus || !status || !executionState)
      return unsupported('The child backend did not report the resume outcome.')
    return report({ childKey, previousStatus, status, executionState })
  },
})

export const subagentCloseTool = defineTool({
  name: 'subagent_close',
  description: 'Close a stopped or unstarted child and preserve its artifacts.',
  parameters: target,
  meta,
  async execute({ childKey }, ctx) {
    if (!ctx.subagent.close) return unsupported('Graceful close is unavailable.')
    return report(await ctx.subagent.close(childKey))
  },
})
