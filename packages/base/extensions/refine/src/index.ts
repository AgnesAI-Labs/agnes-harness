import type { Disposer } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { createInspectTool } from './inspect-tool.js'
import {
  type ConnectRefinement,
  connectedToolPort,
  REFINEMENT_PLANNER,
  type RefinementToolPort,
} from './port.js'
import { createProposeTool } from './propose-tool.js'
import { createRefineTool } from './refine-tool.js'

export type {
  ConnectRefinement,
  InspectAnswer,
  InspectOutcome,
  InspectRequest,
  InspectSummary,
  RefinementOutcome,
  RefinementRuns,
  RefinementToolPort,
  RefineRequest,
  SessionProposal,
} from './port.js'

/** The profile's refinement master switch, as the host read it for this container. */
export type RefinementSwitch = {
  current(): { settings: { enabled: boolean; mode: 'manual' | 'auto' } }
}

export type RefineExtensionDeps = {
  /** Absent means off: nothing but the switch can turn the tools on. */
  settings?: RefinementSwitch
  /** The host's managed refinement: given this plugin's planner, it answers for each session. */
  runs?: ConnectRefinement
  /** Where the tools hand their input; overrides `runs` (tests). */
  port?: RefinementToolPort
}

/**
 * The refinement tools, registered only while the profile switch is on and the host runs refinement.
 * Connecting hands the host this plugin's planner. The host hands over the switch value it read when
 * it assembled the container, so every apply in that container (including a row
 * remount) registers the same set and a running session's tools never change; a new assembly reads
 * the switch again.
 */
export function createRefineExtension(deps: RefineExtensionDeps = {}) {
  return defineAgnesPlugin({
    inject: ['tools'],
    apply(ctx: Context) {
      if (deps.settings?.current().settings.enabled !== true) return
      // With nothing to run them, the tools would only ever fail: none are registered.
      const port = deps.port ?? (deps.runs ? connectedToolPort(deps.runs(REFINEMENT_PLANNER)) : undefined)
      if (!port) return
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
