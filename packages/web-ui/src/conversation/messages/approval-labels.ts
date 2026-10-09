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
  'allowed-permanent': 'timeline.decision.allowedPermanent',
  rejected: 'timeline.decision.rejected',
  cancelled: 'timeline.decision.cancelled',
}

/** Why the decision ended as it did. A ledger from before reasons existed has none and falls back to the verdict. */
export const reasonLabelKeys: Record<string, string> = {
  user_rejected: 'timeline.reason.userRejected',
  timeout: 'timeline.reason.timeout',
  no_approver: 'timeline.reason.noApprover',
  stopped: 'timeline.reason.stopped',
  policy_denied: 'timeline.reason.policyDenied',
  subagent_scope: 'timeline.reason.subagentScope',
}

export const approvalStatus = (node: ApprovalNode, t: Translate) =>
  node.state === 'decided' && node.decision
    ? (() => {
        const key =
          (node.decision.reason ? reasonLabelKeys[node.decision.reason] : undefined) ??
          verdictLabelKeys[node.decision.verdict]
        return key === undefined ? t(approvalLabelKeys.decided) : t(key)
      })()
    : t(approvalLabelKeys[node.state])
