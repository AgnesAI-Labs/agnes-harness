import type { Translate } from '../../locales/index.js'
import type { ApprovalNode } from './context.js'

export const approvalLabelKeys: Record<ApprovalNode['state'], string> = {
  pending: 'timeline.approval.pending',
  decided: 'timeline.approval.decided',
  expired: 'timeline.approval.expired',
}

export const verdictLabelKeys: Record<string, string> = {
  'allowed-once': 'timeline.decision.allowedOnce',
  'allowed-session': 'timeline.decision.allowedSession',
  allow_prefix_session: 'timeline.decision.allowedPrefixSession',
  'allowed-permanent': 'timeline.decision.allowedPermanent',
  rejected: 'timeline.decision.rejected',
  cancelled: 'timeline.decision.cancelled',
  unavailable: 'timeline.decision.unavailable',
}

/** Why the decision ended as it did. A ledger from before reasons existed has none and falls back to the verdict. */
export const reasonLabelKeys: Record<string, string> = {
  'full-access': 'timeline.reason.fullAccess',
  'user-rejected': 'timeline.reason.userRejected',
  deadline: 'timeline.reason.timeout',
  'no-approver': 'timeline.reason.noApprover',
  stopped: 'timeline.reason.stopped',
  transport: 'timeline.reason.transport',
  detached: 'timeline.reason.detached',
  'no-handler': 'timeline.reason.noHandler',
  'invalid-answer': 'timeline.reason.invalidAnswer',
  policy_denied: 'timeline.reason.policyDenied',
  subagent_scope: 'timeline.reason.subagentScope',
}

/** A reconciliation (did a call that lost its result run?) reads as the fact the person confirmed. */
function reconcileStatus(node: ApprovalNode, t: Translate): string | undefined {
  if (!node.reconcile) return undefined
  if (node.state === 'pending') return t('activity.reconcile.pending')
  if (node.state !== 'decided' || !node.decision || node.decision.reason === 'stopped') return undefined
  if (node.decision.verdict.startsWith('allow')) return t('activity.reconcile.ran')
  if (node.decision.verdict === 'rejected') return t('activity.reconcile.notRan')
  return undefined
}

export const approvalStatus = (node: ApprovalNode, t: Translate) =>
  (node.purpose === 'business.confirm' && node.decision?.reason === 'full-access'
    ? `${t('timeline.reason.fullAccessBusiness')} · ${node.decision.byLabel ?? ''}`
    : undefined) ??
  reconcileStatus(node, t) ??
  ((node.state === 'decided' || (node.state === 'expired' && node.decision?.reason === 'stopped')) &&
  node.decision
    ? (() => {
        const key =
          (node.decision.reason ? reasonLabelKeys[node.decision.reason] : undefined) ??
          verdictLabelKeys[node.decision.verdict]
        return key === undefined ? t(approvalLabelKeys.decided) : t(key)
      })()
    : t(approvalLabelKeys[node.state]))
