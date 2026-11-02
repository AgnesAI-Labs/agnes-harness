import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { parsePlannerOutput } from './planner/parse.js'
import { buildPlannerPrompt } from './planner/prompt.js'

export type EntryKind = 'prompt' | 'memory' | 'skill' | 'subagent'

/**
 * A change the model proposes for this session, as the host receives it. Until saved entries can be
 * read with a snapshot to change against, only new entries are accepted.
 */
export type SessionProposal = {
  rationale: string
  evidenceSeqs: number[]
  edits: (
    | { op: 'upsert'; kind: EntryKind; id: string; title: string; content: string }
    | { op: 'delete'; kind: EntryKind; id: string }
  )[]
}

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
 * Where the refinement tools hand their validated input (`inspect` has no tool yet and answers
 * REFINEMENT_NOT_IMPLEMENTED). The extension owns only the tool
 * surface; whoever supplies this port owns identity, state and effects. Each call gets the calling
 * tool's context so the port can tell which session asked.
 */
export type RefinementToolPort = {
  propose(proposal: SessionProposal, ctx: ToolContext): Promise<ToolResult>
  refine(request: RefineRequest, ctx: ToolContext): Promise<ToolResult>
  inspect(request: InspectRequest, ctx: ToolContext): Promise<ToolResult>
}

/** A run the host accepted, or why it wrote nothing. */
export type RefinementOutcome = { runId: string } | { refused: string; detail?: string }

/** The host's managed refinement for a session, found by its key and lane. */
export type RefinementRuns = Readonly<{
  propose(session: { key: string; lane: string }, proposal: SessionProposal): Promise<RefinementOutcome>
  request(session: { key: string; lane: string }, request: { focus?: string }): Promise<RefinementOutcome>
}>

/** The planner this plugin writes, handed to the host once in exchange for the session runs. */
export const REFINEMENT_PLANNER = Object.freeze({
  buildPrompt: buildPlannerPrompt,
  parseOutput: parsePlannerOutput,
})
export type ConnectRefinement = (planner: typeof REFINEMENT_PLANNER) => RefinementRuns

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

const LIMITS = new Set(['cooldown', 'turns', 'hourly', 'session-limit', 'unpriced'])

/** Why the host wrote nothing, in words the model can act on. */
function refused(why: string, detail?: string): ToolResult {
  if (why === 'refinement-off') return toolError('REFINEMENT_OFF', 'refinement is off for this profile')
  if (why === 'manual-mode')
    return toolError('REFINEMENT_MANUAL', 'refinement is set to manual; only the user can ask for a review')
  if (why === 'read-first')
    return toolError(
      'REFINEMENT_READ_FIRST',
      `${detail ?? 'that entry'} is already saved or cannot be read yet; propose a new entry under a new id instead`,
    )
  if (why === 'invalid')
    return toolError('REFINEMENT_INVALID', `the proposal is not valid (${detail ?? 'input'})`)
  if (LIMITS.has(why))
    return toolError('REFINEMENT_LIMIT', `no review now (${why}); try again after later turns`)
  return toolError('REFINEMENT_UNAVAILABLE', `refinement is unavailable in this session (${why})`)
}

const said = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })

/** The tool port backed by the host's session runs. */
export function connectedToolPort(runs: RefinementRuns): RefinementToolPort {
  const session = (ctx: ToolContext) => ({ key: ctx.session.key, lane: ctx.session.lane })
  return {
    async propose(proposal, ctx) {
      const outcome = await runs.propose(session(ctx), proposal)
      if ('refused' in outcome) return refused(outcome.refused, outcome.detail)
      return said(
        `Proposal recorded (run ${outcome.runId}). It is checked and applied between turns, so it takes effect from a later turn.`,
      )
    },
    async refine(request, ctx) {
      const outcome = await runs.request(
        session(ctx),
        request.focus === undefined ? {} : { focus: request.focus },
      )
      if ('refused' in outcome) return refused(outcome.refused, outcome.detail)
      return said(
        `Review requested (run ${outcome.runId}). It runs in the background; any result takes effect from a later turn. Carry on with the task.`,
      )
    },
    async inspect() {
      return toolError('REFINEMENT_NOT_IMPLEMENTED', 'harness_inspect is not implemented yet')
    },
  }
}
