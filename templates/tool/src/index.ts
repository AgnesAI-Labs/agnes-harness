import { Type } from '@sinclair/typebox'
import { defineAgnesPlugin, defineTool, toolError, type Context } from '@agnes/plugin-runtime'

export const echo = defineTool({
  name: '__TOOL_NAME__',
  description: 'Echo a nonempty message.',
  parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
  result: Type.Object({ message: Type.String() }, { additionalProperties: false }),
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe',
    costHint: undefined,
    deferLoading: undefined,
    requiresApproval: 'never',
  },
  async execute({ message }, ctx) {
    ctx.signal.throwIfAborted()
    if (!message.trim()) return toolError('A nonempty message is required')
    // Pass ctx.signal to asynchronous work you add; release per-call resources in finally.
    return { content: [{ type: 'text', text: message }], structured: { message } }
  },
})

export const main = defineAgnesPlugin({
  inject: ['extension'],
  apply(ctx: Context) {
    const unregister = ctx.extension().registerTool(echo)
    // Tie clients, subscriptions and connections you add to this lifecycle effect.
    ctx.effect(() => () => unregister())
  },
})
