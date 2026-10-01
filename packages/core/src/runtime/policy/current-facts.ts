import type { CallContext } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest, type PolicyEvaluateRequest, type TaintSnapshot } from '@agnes/protocol/runtime'

/** Fold the captured boundary against the current acknowledgement before deciding contamination. */
export function effectiveTaint(current: TaintSnapshot, captured: TaintSnapshot): boolean {
  for (const snapshot of [current, captured]) {
    if (
      snapshot.clearedThroughSeq > snapshot.sourceSeq ||
      ![snapshot.recordRevision, snapshot.sourceSeq, snapshot.clearedThroughSeq].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
      ) ||
      snapshot.recordRevision < 1
    )
      throw new Error('invalid taint boundary')
  }
  if (
    captured.sourceSeq > current.sourceSeq ||
    captured.recordRevision > current.recordRevision ||
    captured.clearedThroughSeq > current.clearedThroughSeq
  )
    throw new Error('captured taint boundary is ahead of current state')
  return Math.max(current.sourceSeq, captured.sourceSeq) > current.clearedThroughSeq
}

/** Structural binding checks complement, and never replace, the trusted current-facts authority. */
export function policyFactsMatch(request: PolicyEvaluateRequest, context: CallContext): boolean {
  const facts = request.verifiedFacts
  if (
    request.principalRef !== context.principalRef ||
    canonicalJsonDigest(request.scope) !== canonicalJsonDigest(context.scope) ||
    request.principalRef !== facts.actor.principalRef ||
    request.inputDigest !== facts.inputDigest ||
    request.policyRevision !== facts.authorization.policyRevision ||
    !('runId' in request.scope) ||
    request.scope.runId !== facts.taint.runId ||
    ('actionId' in request.scope && request.scope.actionId !== facts.actionId) ||
    (facts.toolPolicy !== null && facts.toolPolicy.inputDigest !== request.inputDigest)
  )
    return false
  try {
    return facts.taint.tainted === effectiveTaint(facts.taint.current, facts.taint.captured)
  } catch {
    return false
  }
}
