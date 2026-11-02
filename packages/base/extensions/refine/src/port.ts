import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { SessionProposal } from './propose-tool.js'

export type EntryKind = 'prompt' | 'memory' | 'skill' | 'subagent'

/** What `harness_refine` asks for. Only this session is a target until saving to the workspace exists. */
export type RefineRequest = { focus?: string; target: 'session' }

/** What `harness_inspect` asks for, exactly as the model sent it. */
export type InspectRequest = {
  op: 'search' | 'list' | 'get'
  query?: string
  kind?: EntryKind
  cursor?: string
  id?: string
}

/**
 * Where the three refinement tools hand their validated input. The extension owns only the tool
 * surface; whoever supplies this port owns identity, state and effects. Each call gets the calling
 * tool's context so the port can tell which session asked.
 */
export type RefinementToolPort = {
  propose(proposal: SessionProposal, ctx: ToolContext): Promise<ToolResult>
  refine(request: RefineRequest, ctx: ToolContext): Promise<ToolResult>
  inspect(request: InspectRequest, ctx: ToolContext): Promise<ToolResult>
}

/** A tool error the model can read and a client can branch on: `CODE: message`, with the code structured. */
export function toolError(code: string, message: string): ToolResult {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], structured: { code }, isError: true }
}

/** The model asked for the workspace target, which this release does not offer yet. */
export const workspaceTargetUnavailable = (): ToolResult =>
  toolError(
    'REFINEMENT_TARGET_UNAVAILABLE',
    'saving to the workspace is available in a later release; omit target to keep it in this session',
  )

/** The port used until a real one is supplied: it changes nothing and says so. */
export const unavailableRefinementPort: RefinementToolPort = {
  async propose() {
    return toolError('REFINEMENT_UNAVAILABLE', 'refinement is not available yet')
  },
  async refine() {
    return toolError('REFINEMENT_UNAVAILABLE', 'refinement is not available yet')
  },
  async inspect() {
    return toolError('REFINEMENT_NOT_IMPLEMENTED', 'harness_inspect is not implemented yet')
  },
}
