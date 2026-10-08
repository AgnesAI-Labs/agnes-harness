import type { ApprovalAnswer, ApprovalReason, Pending, Verdict } from './seams.js'

const VERDICTS: ReadonlySet<string> = new Set([
  'allowed-once',
  'allowed-session',
  'allowed-permanent',
  'rejected',
  'cancelled',
  'unavailable',
])
const REASONS: ReadonlySet<string> = new Set<ApprovalReason>([
  'user_rejected',
  'timeout',
  'no_approver',
  'stopped',
  'policy_denied',
  'subagent_scope',
])

export const isApprovalReason = (value: unknown): value is ApprovalReason =>
  typeof value === 'string' && REASONS.has(value)

/** A seam's own answer to a question: a bare verdict, a verdict with its reason, or a parked ticket. */
export type RawApproval = Verdict | ApprovalAnswer | Pending

export const isPending = (value: unknown): value is Pending =>
  typeof value === 'object' && value !== null && typeof (value as Pending).ticket === 'string'

/**
 * One shape for what the kernel acts on. A bare verdict carries no reason; a reason outside the
 * known set is dropped rather than written, because the ledger records the facts the kernel knows.
 */
export function normalizeApproval(value: RawApproval): ApprovalAnswer | Pending | null {
  if (isPending(value)) return value
  const answer = typeof value === 'string' ? { verdict: value } : value
  if (!answer || typeof answer !== 'object' || !VERDICTS.has(answer.verdict as string)) return null
  const reason = (answer as { reason?: unknown }).reason
  return isApprovalReason(reason) ? { verdict: answer.verdict, reason } : { verdict: answer.verdict }
}

/** The result code and the words the model reads when a call is refused at the approval step. */
export function approvalRefusal(
  verdict: Verdict,
  reason: ApprovalReason | undefined,
  timeoutMs: number,
): { code: string; text: string } {
  if (verdict === 'cancelled') return { code: 'CANCELLED', text: 'cancelled while waiting for approval' }
  if (verdict === 'unavailable')
    return {
      code: 'APPROVAL_UNAVAILABLE',
      text: 'no client was connected to approve this action, so it was not run; tell the user it needs their approval',
    }
  const text =
    reason === 'user_rejected'
      ? 'the user rejected this action; do not retry the same call without asking'
      : reason === 'timeout'
        ? `no one answered the approval within ${Math.round(timeoutMs / 1000)}s, so the action was not run; ask the user before trying again`
        : reason === 'policy_denied'
          ? 'blocked by the command policy'
          : reason === 'subagent_scope'
            ? 'this sub-agent was started with a fixed permission scope that cannot be widened from inside the session, and this action needs approval, so it was refused automatically; do not retry it, say in your reply that it needs approval so the agent that delegated to you can decide'
            : `approval ${verdict}`
  return { code: 'APPROVAL_REJECTED', text }
}

/** The verdict and, when there is one, its reason, in the order the ledger row carries them. */
export const decidedFields = (a: ApprovalAnswer): { verdict: Verdict; reason?: ApprovalReason } =>
  a.reason === undefined ? { verdict: a.verdict } : { verdict: a.verdict, reason: a.reason }
