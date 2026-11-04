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
  RefineTarget,
  SessionProposal,
} from './port.js'

export type RefineExtensionDeps = {
  /** The host's managed refinement: given this plugin's planner, it answers for each session. */
  runs?: ConnectRefinement
  /** Where the tools hand their input; overrides `runs` (tests). */
  port?: RefinementToolPort
}

/**
 * The refinement tools, registered whenever the host runs refinement, whatever the profile switch
 * says: every apply (including a row remount) registers the same set. Which sessions are offered
 * them is Core's decision, made once per session as it opens, so a running session's tools never
 * change and a session opened while the switch is off never sees them. Connecting hands the host
 * this plugin's planner.
 */
export function createRefineExtension(deps: RefineExtensionDeps = {}) {
  return defineAgnesPlugin({
    inject: ['tools'],
    apply(ctx: Context) {
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
