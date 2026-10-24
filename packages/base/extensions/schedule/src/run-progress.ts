import type { DecisionSnapshot, EventEnvelope } from '@agnes/protocol'

/** Durable observation only: this never answers a decision or dispatches an effect. */
export type RunProgress = {
  outcome: 'running' | 'waiting_approval' | 'needs_attention' | 'ran' | 'failed'
  needsAttention: boolean
  pending: Record<string, number>
  turn?: number
  reason?: string
}
/** Refuse corrupt persisted attention state rather than losing a pending run. */
export function isRunProgress(value: unknown): value is RunProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as RunProgress
  return (
    ['running', 'waiting_approval', 'needs_attention', 'ran', 'failed'].includes(state.outcome) &&
    typeof state.needsAttention === 'boolean' &&
    !!state.pending &&
    typeof state.pending === 'object' &&
    !Array.isArray(state.pending) &&
    Object.values(state.pending).every((deadline) => Number.isSafeInteger(deadline) && deadline >= 0) &&
    (state.turn === undefined || (Number.isSafeInteger(state.turn) && state.turn >= 0)) &&
    (state.reason === undefined || (typeof state.reason === 'string' && state.reason.length <= 64))
  )
}
/** The only event types `observeProgress` reacts to; observers skip every other row before reading state. */
export const RUN_PROGRESS_EVENT_TYPES: readonly string[] = [
  'decision/state',
  'turn/start',
  'turn/end',
  'x/core/unattended-refused',
]
export const startProgress = (): RunProgress => ({ outcome: 'running', needsAttention: false, pending: {} })
export function expireProgress(state: RunProgress, now: number): RunProgress {
  if (
    ['waiting_approval', 'needs_attention'].includes(state.outcome) &&
    Object.values(state.pending).some((deadline) => deadline <= now)
  )
    return { ...state, outcome: 'failed', needsAttention: true, reason: 'approval_expired' }
  return state
}
export function observeProgress(state: RunProgress, event: EventEnvelope, now: number): RunProgress {
  if (state.outcome === 'failed' || state.outcome === 'ran') return state
  let next = { ...state, pending: { ...state.pending } }
  if (event.type === 'decision/state') {
    const decision = event.data as DecisionSnapshot
    const subject = decision.request.spec?.subject as { turn?: number } | null
    if (
      !Object.hasOwn(state.pending, decision.handle.id) &&
      subject?.turn !== undefined &&
      state.turn !== undefined &&
      subject.turn !== state.turn
    )
      return state
    if (state.outcome !== 'running' && !Object.hasOwn(state.pending, decision.handle.id)) return state
    if (!decision.result && !decision.invalidation && !decision.consumption) {
      const deadline = Date.parse(decision.request.expiresAt ?? '')
      if (Number.isFinite(deadline)) next.pending[decision.handle.id] = deadline
    } else {
      if (decision.consumption || decision.invalidation || decision.result?.reason !== 'answered')
        delete next.pending[decision.handle.id]
      if (
        (decision.result && decision.result.reason !== 'answered') ||
        (decision.result?.reason === 'answered' && decision.result.response.option === 'rejected') ||
        decision.invalidation
      ) {
        next = {
          ...next,
          outcome: 'failed',
          needsAttention: true,
          reason:
            decision.result?.reason === 'expired' || decision.invalidation?.code === 'deadline'
              ? 'approval_expired'
              : decision.result?.reason === 'answered' ||
                  (decision.result?.reason === 'unavailable' && decision.result.code === 'unattended-refused')
                ? 'approval_refused'
                : 'approval_unavailable',
        }
      }
    }
  } else if (event.type === 'turn/start') {
    const data = event.data as { turn: number; trigger: string }
    if (
      state.turn === undefined ||
      data.trigger === 'approval-resume' ||
      (state.needsAttention && Object.keys(state.pending).length === 0)
    )
      next = { ...next, turn: data.turn, outcome: 'running', needsAttention: false }
  } else if (event.type === 'turn/end') {
    // turn/end has no turn number. Only an active run (including an approval continuation)
    // can finish; an unrelated user turn must not clear an outstanding approval.
    const data = event.data as { reason: string }
    if (state.outcome !== 'running') return state
    if (data.reason === 'parked')
      next = {
        ...next,
        outcome: Object.keys(next.pending).length ? 'waiting_approval' : 'needs_attention',
        needsAttention: true,
      }
    else
      next = {
        ...next,
        outcome: data.reason === 'completed' ? 'ran' : 'failed',
        ...(data.reason === 'completed'
          ? { needsAttention: false }
          : { needsAttention: true, reason: data.reason }),
      }
  } else if (event.type === 'x/core/unattended-refused')
    next = { ...next, outcome: 'failed', needsAttention: true, reason: 'approval_refused' }
  return expireProgress(next, now)
}
