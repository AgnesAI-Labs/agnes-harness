import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

export default defineAgnesPlugin({
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.tools.register(
      defineTool({
        name: 'hello_ping',
        description: 'ping',
        parameters: Type.Object({}, { additionalProperties: false }),
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'safe',

          deferLoading: false,
          requiresApproval: 'never',
        },
        execute: async () => ({ content: [{ type: 'text', text: 'pong' }], isError: false }),
      }),
    )
  },
})
