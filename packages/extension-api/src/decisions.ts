import type { DecisionHandle, DecisionSnapshot, DecisionSpec } from '@agnes/protocol/gen/session-v1'

export type {
  DecisionHandle,
  DecisionResponse,
  DecisionResult,
  DecisionSnapshot,
  DecisionSpec,
} from '@agnes/protocol/gen/session-v1'

/** Existing approval configuration defaults; waiter timeout does not change request validity. */
export const APPROVAL_DEFAULTS = Object.freeze({
  onTimeout: 'rejected' as const,
  timeoutMs: 60000,
  onUnavailable: 'deny' as const,
  pendingTtlMs: 86400000,
})

/** One session-owned request; custom responses never issue tool or management grants. */
export interface DecisionPort {
  request(spec: DecisionSpec): Promise<DecisionHandle>
  get(handle: DecisionHandle): Promise<DecisionSnapshot>
  wait(handle: DecisionHandle, options?: { readonly signal?: AbortSignal }): Promise<DecisionWaitResult>
}
/** One-shot candidate review for an admitted operation; Core delivers and consumes the answer.
 * Detached delivery withdraws the candidate. This port never creates reusable permission grants. */
export interface DecisionReviewPort extends DecisionPort {
  review(spec: DecisionSpec, options?: { readonly signal?: AbortSignal }): Promise<DecisionSnapshot>
}
export type DecisionWaitResult =
  | { readonly status: 'resolved'; readonly snapshot: DecisionSnapshot }
  | { readonly status: 'pending'; readonly handle: DecisionHandle; readonly waitEndedBy: 'detached' }

/** Used without an admitted session; registration never grants a session selector. */
export const unavailableDecisions: DecisionPort = Object.freeze({
  request: async () => {
    throw Object.assign(new Error('No admitted decision session'), { code: 'E_DECISION_SCOPE' })
  },
  get: async () => {
    throw Object.assign(new Error('No admitted decision session'), { code: 'E_DECISION_SCOPE' })
  },
  wait: async () => {
    throw Object.assign(new Error('No admitted decision session'), { code: 'E_DECISION_SCOPE' })
  },
})
