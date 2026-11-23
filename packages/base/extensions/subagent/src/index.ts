import { applyChildAgentConfig } from '@agnes/core'
import type { Disposer } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { subagentCloseTool, subagentPauseTool, subagentResumeTool } from './lifecycle-tools.js'
import { subagentRecapTool } from './recap-tool.js'
import {
  listSubagentModelsTool,
  resetSubagentRuntime,
  type SubagentDeps,
  subagentCancelTool,
  subagentCollectTool,
  subagentForkToolWithDeps,
  subagentInterruptTool,
  subagentListTool,
  subagentSendMessageTool,
  subagentSpawnTool,
} from './tools.js'

export * from './lifecycle-tools.js'
export * from './recap-tool.js'
export * from './tools.js'
export * from './worktree.js'

/**
 * Explicit assembly seam for a host that has resolved the session's subagent preset. Keeping the
 * limits in dependencies avoids a process-global default and lets the subagent tools share accounting.
 */
export function createSubagentExtension(deps: SubagentDeps) {
  return defineAgnesPlugin({
    inject: ['tools'],
    apply(ctx: Context) {
      if (deps.allowlist) applyChildAgentConfig(deps.allowlist)
      const disposers: Disposer[] = [
        ctx.tools.register(subagentForkToolWithDeps(deps)),
        ctx.tools.register(subagentSpawnTool(deps)),
        ctx.tools.register(subagentCollectTool(deps)),
        ctx.tools.register(subagentCancelTool(deps)),
        ctx.tools.register(subagentListTool),
        ctx.tools.register(subagentSendMessageTool),
        ctx.tools.register(subagentInterruptTool),
        ctx.tools.register(subagentPauseTool),
        ctx.tools.register(subagentResumeTool),
        ctx.tools.register(subagentCloseTool),
        ctx.tools.register(subagentRecapTool),
        ctx.tools.register(listSubagentModelsTool),
      ]
      return () => {
        for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.()
        resetSubagentRuntime(deps)
      }
    },
  })
}

// ExtensionContext currently exposes only a preset name, not resolved subagent limits. The default
// entry stays staged until Host can supply those values; hard-coded limits would be a false policy.
export default defineAgnesPlugin({
  apply() {},
})
