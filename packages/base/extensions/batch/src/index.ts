import { defineExtension, type ExtensionFactory } from '@agnes/extension-api'
import { BATCH_ITEM_SESSION_PATTERN } from '@agnes/protocol'
import { type BatchBridgePort, batchTools } from './tools.js'

export const BATCH_TOOLS = batchTools(undefined)

export function createBatchExtension(bridge: BatchBridgePort | undefined): ExtensionFactory {
  return defineExtension((agnes) => {
    for (const tool of batchTools(bridge)) agnes.registerTool(tool)
    // A batch item reads its one file and answers. Text inside that file must not reach any other tool.
    // registerHook, as agnes/hooks-runner does; agnes.on is refused for row extensions.
    agnes.registerHook('tool_call', (call, ctx) =>
      BATCH_ITEM_SESSION_PATTERN.test(ctx.session.key) && call.name !== 'read'
        ? { allow: false, reason: 'A batch item may only use the read tool.' }
        : { allow: true },
    )
  })
}

export default createBatchExtension(undefined)
