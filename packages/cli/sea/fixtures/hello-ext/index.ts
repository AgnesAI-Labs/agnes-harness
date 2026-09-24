import { defineExtension, defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'

export default defineExtension((api) => {
  api.registerTool(
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
        costHint: undefined,
        deferLoading: false,
        requiresApproval: 'never',
      },
      execute: async () => ({ content: [{ type: 'text', text: 'pong' }], isError: false }),
    }),
  )
})
