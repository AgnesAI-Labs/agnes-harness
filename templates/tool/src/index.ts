import { type Context, defineAgnesPlugin, defineTool, readOnlyTool, toolError } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

export const echo = defineTool({
  name: '__TOOL_NAME__',
  description: 'Echo a nonempty message.',
  parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
  result: Type.Object({ message: Type.String() }, { additionalProperties: false }),
  meta: readOnlyTool,
  async execute({ message }, ctx) {
    ctx.signal.throwIfAborted()
    if (!message.trim()) return toolError('A nonempty message is required')
    // Pass ctx.signal to asynchronous work you add; release per-call resources in finally.
    return { content: [{ type: 'text', text: message }], structured: { message } }
  },
})

export const main = defineAgnesPlugin({
  apply(ctx: Context) {
    ctx.tools.register(echo)
  },
})
