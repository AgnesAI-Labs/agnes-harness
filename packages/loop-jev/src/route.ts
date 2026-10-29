// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import {
  ANSWER,
  type Decision,
  type HistoryEntry,
  type JevLoopConfig,
  LLM_PARAMETERS,
  type ResolvedTool,
  type Route,
} from './types.js'

export type RouteInput = {
  decision: Decision
  /** `null` stands for the synthetic ANSWER operation. */
  tool: ResolvedTool | null
  /** The last history entry of the current turn. */
  latest: HistoryEntry | null
  turnHasAttempts: boolean
  thresholds: JevLoopConfig['thresholds']
}

/**
 * Decides who finishes a Jev decision: a direct dispatch, the main model for parameters, an
 * arbitration, or the answer route. Checks run in a fixed order; the first arbitration wins.
 */
export function routeDecision(input: RouteInput): Route {
  const { decision, tool, latest, turnHasAttempts, thresholds } = input
  let threshold = thresholds.escalate
  if (tool?.writeClass === 'external') threshold = Math.max(threshold, thresholds.externalWriteMin)

  // The ambiguity gate may relax only genuinely read-only choices in INSPECT/VERIFY; writes, shell
  // and the final answer keep the full confidence net.
  const gate =
    tool?.readOnly === true &&
    (decision.phase === 'INSPECT' || decision.phase === 'VERIFY') &&
    thresholds.ambiguityGate !== null
      ? thresholds.ambiguityGate
      : null
  const relaxed = gate !== null && decision.ambiguity !== null && decision.ambiguity <= gate
  if (decision.operationPathConfidence < threshold && !relaxed) {
    return { kind: 'arbitration', reason: 'low_confidence', decision }
  }

  if (latest?.error?.recoverability === 'recoverable') {
    return { kind: 'arbitration', reason: 'recoverable_observation', decision }
  }

  const floor = thresholds.answerProgressFloor
  if (
    decision.op === ANSWER &&
    !turnHasAttempts &&
    floor !== null &&
    decision.progress !== null &&
    decision.progress < floor
  ) {
    return { kind: 'arbitration', reason: 'premature_answer', decision }
  }

  let routed = decision
  let weak = false
  if (decision.confidence < threshold) {
    // A weak binding does not re-choose the operation; it only drops the executable arguments (and any batch).
    const { batch: _batch, ...rest } = decision
    routed = { ...rest, bindingMode: 'llm_parameters', args: {}, target: LLM_PARAMETERS }
    weak = true
  }
  if (routed.op === ANSWER) return { kind: 'answer', reason: null, decision: routed }
  if (routed.bindingMode === 'llm_parameters')
    return { kind: 'parameters', reason: weak ? 'weak_binding' : null, decision: routed }
  return { kind: 'direct', reason: null, decision: routed }
}
