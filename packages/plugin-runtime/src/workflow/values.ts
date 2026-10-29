import type { LoopContext, ToolContext, ToolMeta, ToolResult } from '@agnes/extension-api'
import type { Static, TSchema } from '@sinclair/typebox'
import { defineTool, readOnlyTool, toolError } from '../author/tool.js'
import type { JsonValue } from './types.js'

export const workflowResult = (data: JsonValue): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structured: data,
})
export function workflowText(output: ToolResult): string {
  return output.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}
export function workflowChecked(output: ToolResult): ToolResult {
  if (output.isError) throw new Error(workflowText(output))
  return output
}
export function workflowValue(output: ToolResult): JsonValue {
  workflowChecked(output)
  return output.structured ?? JSON.parse(workflowText(output))
}
/** JSON business tools retain the normal schema, policy and cancellation contracts. */
export function workflowTool<P extends TSchema>(
  name: string,
  description: string,
  parameters: P,
  execute: (args: Static<P>, ctx: ToolContext) => JsonValue | Promise<JsonValue>,
  meta: ToolMeta = readOnlyTool,
) {
  return defineTool({
    name,
    description,
    parameters,
    meta,
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      try {
        const data = await execute(args, ctx)
        ctx.signal.throwIfAborted()
        return workflowResult(data)
      } catch (error) {
        ctx.signal.throwIfAborted()
        return toolError(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
export async function workflowModelText(
  ctx: LoopContext,
  system: string,
  data: JsonValue,
  signal: AbortSignal,
): Promise<string> {
  const request = await ctx.prepareRequest({
    slot: 'primary',
    system,
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(data) }] }],
  })
  const events = await ctx.model.complete(request, signal)
  signal.throwIfAborted()
  const failure = events.find((event) => event.type === 'error')
  if (failure) throw new Error(`Business model request failed: ${failure.message}`)
  const prose = events.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : [])).join('')
  if (!prose.trim()) throw new Error('Business model returned no text')
  return prose
}
