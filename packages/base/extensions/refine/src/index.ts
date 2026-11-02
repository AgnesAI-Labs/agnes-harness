import type { Disposer } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { createInspectTool } from './inspect-tool.js'
import { type RefinementToolPort, unavailableRefinementPort } from './port.js'
import { createProposeTool } from './propose-tool.js'
import { createRefineTool } from './refine-tool.js'

export type { InspectRequest, RefinementToolPort, RefineRequest } from './port.js'

/** The profile's refinement master switch, as the host read it for this container. */
export type RefinementSwitch = {
  current(): { settings: { enabled: boolean; mode: 'manual' | 'auto' } }
}

export type RefineExtensionDeps = {
  /** Absent means off: nothing but the switch can turn the tools on. */
  settings?: RefinementSwitch
  /** Where the tools hand their input; defaults to a port that answers "not available yet". */
  port?: RefinementToolPort
}

/**
 * The refinement tools, registered only while the profile switch is on. The host hands over the
 * value it read when it assembled the container, so every apply in that container (including a row
 * remount) registers the same set and a running session's tools never change; a new assembly reads
 * the switch again.
 */
export function createRefineExtension(deps: RefineExtensionDeps = {}) {
  return defineAgnesPlugin({
    inject: ['tools'],
    apply(ctx: Context) {
      if (deps.settings?.current().settings.enabled !== true) return
      const port = deps.port ?? unavailableRefinementPort
      const disposers: Disposer[] = [
        ctx.tools.register(createProposeTool(port)),
        ctx.tools.register(createRefineTool(port)),
        ctx.tools.register(createInspectTool(port)),
      ]
      return () => {
        for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.()
      }
    },
  })
}

export default createRefineExtension()
