import { type Disposer, defineExtension } from '@agnes/extension-api'
import {
  resetSubagentRuntime,
  type SubagentDeps,
  subagentCancelTool,
  subagentCollectTool,
  subagentForkTool,
  subagentSpawnTool,
} from './tools.js'

export * from './tools.js'
export * from './worktree.js'

/**
 * Explicit assembly seam for a host that has resolved the session's subagent preset. Keeping the
 * limits in dependencies avoids a process-global default and lets all three tools share accounting.
 */
export function createSubagentExtension(deps: SubagentDeps) {
  return defineExtension((agnes) => {
    const disposers: Disposer[] = [
      agnes.registerTool(subagentForkTool),
      agnes.registerTool(subagentSpawnTool(deps)),
      agnes.registerTool(subagentCollectTool(deps)),
      agnes.registerTool(subagentCancelTool(deps)),
    ]
    return () => {
      for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.()
      resetSubagentRuntime(deps)
    }
  })
}

// ExtensionContext currently exposes only a preset name, not resolved subagent limits. The default
// entry stays staged until Host can supply those values; hard-coded limits would be a false policy.
export default defineExtension(() => undefined)
