import type { DispatchPhase, ResolvedToolCallPolicy } from '@agnes/protocol'

export type ToolRecoveryMode = 'resume' | 'close' | 'cancel'

export type RecoverableToolCall = Readonly<{
  status:
    | 'planned'
    | 'awaiting_approval'
    | 'approved'
    | 'dispatch_pending'
    | 'effect_pending'
    | 'dispatched'
    | 'responded'
    | 'completed'
  replay: 'safe' | 'never' | 'idempotent'
  executionDomain?: 'workspace' | 'host-computer-use'
  effectId?: string
  dispatchAttempt?: 1 | 2
  dispatchPhase?: DispatchPhase
}>

export type ToolRecoveryDecision =
  | 'continue'
  | 'not-started'
  | 'cancelled'
  | 'settle-only'
  | 'retry-same-effect'
  | 'unknown'
  | 'complete'

export type ToolRecoveryInput = Readonly<{
  mode: ToolRecoveryMode
  call: RecoverableToolCall
  policy: Pick<ResolvedToolCallPolicy, 'isReadOnly' | 'isDestructive' | 'replay'> | undefined
  policyBinding: 'trusted' | 'untrusted'
  hasMatchingResult: boolean
  /** A durable, provider-specific proof. An absent value is deliberately not treated as a proof. */
  reconciliation?: 'not-applied' | 'applied'
}>

const PRE_DISPATCH = new Set<RecoverableToolCall['status']>(['planned', 'awaiting_approval', 'approved'])

/**
 * Pure crash classification for a persisted tool call. This function grants no authority and does
 * no I/O: callers must still verify the policy envelope, definition fingerprint, effect binding,
 * and matching ledger result before passing `trusted`/`true` here.
 */
export function classifyToolRecovery(input: ToolRecoveryInput): ToolRecoveryDecision {
  const { call } = input
  if (call.status === 'completed') return 'complete'

  if (PRE_DISPATCH.has(call.status)) {
    if (input.mode === 'close') return 'not-started'
    if (input.mode === 'cancel') return 'cancelled'
  }

  // No policy-derived recovery decision is valid if the durable policy/effect binding is missing,
  // changed, or internally contradictory.
  if (input.policyBinding !== 'trusted' || !input.policy || input.policy.replay !== call.replay)
    return 'unknown'

  if (PRE_DISPATCH.has(call.status)) return 'continue'

  if (call.status === 'responded') {
    return call.dispatchPhase === 'responded' && input.hasMatchingResult ? 'settle-only' : 'unknown'
  }

  if (input.mode === 'close') return 'unknown'

  if (input.mode === 'cancel') {
    // An intent plus a durable Host attestation that no bytes left the process can be cancelled
    // without inventing an external outcome. Anything weaker remains unknown.
    return call.status === 'dispatch_pending' &&
      call.executionDomain === 'host-computer-use' &&
      call.dispatchPhase === 'not_sent'
      ? 'cancelled'
      : 'unknown'
  }

  if (call.status === 'dispatch_pending') {
    // The same effect may cross the dispatch boundary at most one more time. A caller unable to
    // preserve the effect identity and attempt number must fail closed instead of translating this
    // into an ordinary fresh replay. The budget holds across a process crash, where every committed
    // transaction survives. Commits are not flushed to disk one by one, so a power loss can drop the
    // commit that moved the call to attempt two (or its intent) and allow another crossing.
    return call.executionDomain === 'host-computer-use' &&
      call.dispatchPhase === 'not_sent' &&
      call.dispatchAttempt === 1
      ? 'retry-same-effect'
      : 'unknown'
  }

  const mutation = input.policy.isDestructive || call.replay === 'never'
  if (mutation) return 'unknown'

  const safeRead = input.policy.isReadOnly && !input.policy.isDestructive && call.replay === 'safe'
  if (safeRead) {
    // Legacy `effect_pending` has no durable retry budget. Replanning it would mint a fresh effect
    // at attempt one after every crash, so it must fail closed. A v3 attempt-one call may continue
    // only by preserving the same effect and durably advancing to attempt two.
    return call.status === 'dispatched' &&
      call.dispatchPhase === 'may_have_sent' &&
      call.dispatchAttempt === 1
      ? 'retry-same-effect'
      : 'unknown'
  }

  if (call.replay === 'idempotent') {
    if (input.reconciliation !== 'not-applied') return 'unknown'
    return call.status === 'dispatched' &&
      call.dispatchPhase === 'may_have_sent' &&
      call.dispatchAttempt === 1
      ? 'retry-same-effect'
      : 'unknown'
  }

  return 'unknown'
}
