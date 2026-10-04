/** Purpose/operation path admission, independent binding, recovery priority and answer review. */

import type { SelectedDecision } from './decision.js'
import type { RuntimeConfig, ToolDescriptor } from './types.js'

function operationThreshold(
  decision: SelectedDecision,
  tool: ToolDescriptor | undefined,
  config: RuntimeConfig,
): number {
  return decision.kind === 'tool' && tool?.effectClass === 'read_only'
    ? config.escalateBelow
    : Math.max(config.escalateBelow, config.mutationEscalateBelow)
}

/**
 * Determine whether equivalent-operation support supplies a missing Purpose threshold.
 * @param decision - Validated selected path and optional supporting branches.
 * @param tool - Selected tool and its trusted effect classification.
 * @param config - Resolved selection and support thresholds.
 * @returns True only for a tool with adequate O, insufficient P and adequate support; recovery remains independent.
 */
export function operationSupportUsed(
  decision: SelectedDecision,
  tool: ToolDescriptor | undefined,
  config: RuntimeConfig,
): boolean {
  const threshold = operationThreshold(decision, tool, config)
  return (
    decision.kind === 'tool' &&
    decision.operationConfidence !== null &&
    decision.operationConfidence >= threshold &&
    decision.purposeConfidence < threshold &&
    decision.equivalentSupport !== null &&
    decision.equivalentSupport >= config.equivalentSupportThreshold
  )
}

/**
 * Report all operation-arbitration triggers in recovery-first order.
 * @param decision - Validated selected-path answers.
 * @param tool - Current selected tool; missing effect metadata receives the mutation threshold.
 * @param config - Resolved selection and equivalent-operation support thresholds.
 * @param recoverable - Whether the latest current-turn failure awaits recovery arbitration.
 * @returns Trigger reasons; an empty list admits the operation to parameter routing or answer review.
 */
export function operationGateReasons(
  decision: SelectedDecision,
  tool: ToolDescriptor | undefined,
  config: RuntimeConfig,
  recoverable: boolean,
): readonly string[] {
  const threshold = operationThreshold(decision, tool, config)
  // Support can rescue only a weak Purpose for the same tool. It neither supplies O nor changes B or arguments.
  // It sums matching Purpose mass, not independent votes or calibrated confidence. See ../README.md.
  const admitted =
    decision.kind === 'respond'
      ? decision.purposeConfidence >= threshold
      : decision.operationConfidence !== null &&
        decision.operationConfidence >= threshold &&
        (decision.purposeConfidence >= threshold || operationSupportUsed(decision, tool, config))
  const reasons: string[] = []
  if (recoverable) reasons.push('recoverable_observation')
  if (!admitted) reasons.push('low_confidence')
  return reasons
}

/**
 * Select the highest-priority operation arbitration reason without consuming binding or progress scores.
 * @param decision - Validated selected-path answers.
 * @param tool - Current selected tool, if any.
 * @param config - Resolved operation thresholds.
 * @param recoverable - Whether the latest current-turn failure awaits arbitration.
 * @returns Recovery or low-operation-confidence reason, or undefined when operation routing accepts it.
 */
export function escalationReason(
  decision: SelectedDecision,
  tool: ToolDescriptor | undefined,
  config: RuntimeConfig,
  recoverable: boolean,
): string | undefined {
  return operationGateReasons(decision, tool, config, recoverable)[0]
}

/**
 * Determine whether an accepted response needs the configured progress review.
 * @param decision - Accepted operation and available progress signal.
 * @param config - Resolved review mode; review requires a numeric progress floor.
 * @returns True for low or unavailable progress in review mode; the caller enforces durable checkpoint limits.
 */
export function requiresResponseReview(decision: SelectedDecision, config: RuntimeConfig): boolean {
  return (
    decision.kind === 'respond' &&
    config.responseReviewMode === 'review' &&
    (decision.progress === undefined ||
      (config.answerProgressFloor !== null && decision.progress < config.answerProgressFloor))
  )
}
