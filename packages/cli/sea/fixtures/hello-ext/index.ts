import { defineExtension } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
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

        deferLoading: false,
        requiresApproval: 'never',
      },
      execute: async () => ({ content: [{ type: 'text', text: 'pong' }], isError: false }),
    }),
  )
})
