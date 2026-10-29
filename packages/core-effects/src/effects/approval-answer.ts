import { APPROVAL_REASONS, validateAgainst } from '@agnes/protocol'
import { Actor } from '@agnes/protocol/gen/session-v1'
import type { ApprovalAnswer, ApprovalReason, ApprovalRequest, Pending, Verdict } from './seams.js'

const VERDICTS: ReadonlySet<string> = new Set([
  'allowed-once',
  'allowed-session',
  'allowed-permanent',
  'rejected',
  'cancelled',
  'unavailable',
])
const REASONS: ReadonlySet<string> = new Set(APPROVAL_REASONS)

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
export function normalizeApproval(
  value: RawApproval,
  request?: ApprovalRequest,
): ApprovalAnswer | Pending | null {
  if (isPending(value)) return value
  const answer = typeof value === 'string' ? { verdict: value } : value
  if (!answer || typeof answer !== 'object' || !VERDICTS.has(answer.verdict as string)) return null
  // Cancellation/unavailability are not choices. Every actual choice must be offered.
  if (
    request &&
    answer.verdict !== 'cancelled' &&
    answer.verdict !== 'unavailable' &&
    !(request.options ?? ['allowed-once', 'allowed-session', 'rejected']).includes(answer.verdict)
  )
    return { verdict: 'unavailable', reason: 'invalid-answer' }
  if (
    request?.approval?.reviewerRequirement === 'human' &&
    answer.verdict.startsWith('allowed') &&
    (!(answer as ApprovalAnswer).answeredBy || answer.verdict !== 'allowed-once')
  )
    return { verdict: 'unavailable', reason: 'invalid-answer' }
  const reason = (answer as { reason?: unknown }).reason
  const answeredBy = (answer as ApprovalAnswer).answeredBy
  if (answeredBy !== undefined && !validateAgainst(Actor, answeredBy).ok) return null
  return {
    verdict: answer.verdict,
    ...(isApprovalReason(reason) ? { reason } : {}),
    ...(answeredBy && answer.verdict !== 'unavailable' && answer.verdict !== 'cancelled'
      ? { answeredBy: structuredClone(answeredBy) }
      : {}),
  }
}

export const USER_WORDS_MAX = 500

/** An approval's response is null, or the words a user gave with a rejection (cut to {@link USER_WORDS_MAX} for the model). */
export const APPROVAL_RESPONSE_SCHEMA = { type: ['null', 'string'], maxLength: 4000 } as const

/**
 * What the user typed when rejecting, made safe to show the model: control characters become spaces,
 * the text is cut to {@link USER_WORDS_MAX} characters, and backslashes and quotes are escaped so the
 * words cannot close the quoted label around them. Anything that is not a non-blank string yields "".
 */
export function userWordsNote(value: unknown): string {
  if (typeof value !== 'string') return ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
  const words = [...clean].slice(0, USER_WORDS_MAX).join('').trim()
  if (!words) return ''
  return ` The user said: "${words.replace(/["\\]/g, '\\$&')}"`
}

/**
 * The result code and the words the model reads when a call is refused at the approval step.
 * `userWords` is the free text sent with a rejection; it is appended only to a user rejection.
 */
export function approvalRefusal(
  verdict: Verdict,
  reason: ApprovalReason | undefined,
  timeoutMs: number,
  userWords?: unknown,
): { code: string; text: string } {
  if (verdict === 'cancelled') return { code: 'CANCELLED', text: 'cancelled while waiting for approval' }
  if (verdict === 'unavailable') {
    const detail =
      reason === 'deadline'
        ? `no one answered within ${Math.round(timeoutMs / 1000)}s`
        : reason === 'transport'
          ? 'the approval could not be delivered'
          : reason === 'detached'
            ? 'the approval surface detached'
            : reason === 'no-handler'
              ? 'the client has no approval handler'
              : reason === 'invalid-answer'
                ? 'the answer was invalid or was not offered'
                : 'no eligible approver was connected'
    return {
      code: 'APPROVAL_UNAVAILABLE',
      text: `${detail}, so the action was not run; ask the user before trying again`,
    }
  }
  const text =
    reason === 'user-rejected'
      ? `the user rejected this action; do not retry the same call without asking${userWordsNote(userWords)}`
      : reason === 'deadline'
        ? `no one answered the approval within ${Math.round(timeoutMs / 1000)}s, so the action was not run; ask the user before trying again`
        : reason === 'policy_denied'
          ? 'blocked by the command policy'
          : reason === 'subagent_scope'
            ? 'this sub-agent was started with a fixed permission scope that cannot be widened from inside the session, and this action needs approval, so it was refused automatically; do not retry it, say in your reply that it needs approval so the agent that delegated to you can decide'
            : `approval ${verdict}`
  return { code: 'APPROVAL_REJECTED', text }
}

/** Persist the responder only when a verified answer actually exists. */
export const decidedFields = (a: ApprovalAnswer): ApprovalAnswer => ({ ...a })
