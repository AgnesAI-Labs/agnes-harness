import type { DecisionSnapshot, UINode } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'

export type ApprovalNode = Extract<UINode, { kind: 'approval' }>

const options = {
  'allowed-once': 'allow_once',
  'allowed-session': 'allow_always',
  'allowed-permanent': 'allow_permanent',
  rejected: 'reject_once',
} as const

/** Only the exact, still-pending decision and its offered approval options are actionable. */
export function pendingApproval(
  decisions: readonly DecisionSnapshot[],
  ref: NonNullable<ApprovalNode['decisionRef']>,
): ApprovalNode | undefined {
  const value = decisions.find(
    (item) =>
      item.handle.sessionId === ref.sessionId &&
      item.handle.id === ref.id &&
      item.revision === ref.revision &&
      !item.result &&
      !item.invalidation &&
      !item.consumption,
  )
  if (!value?.request.spec.options.every((option) => Object.hasOwn(options, option))) return
  return approvalNode(value, ref, 'pending')
}

/**
 * A decision someone already answered whose turn has not picked the answer up yet: the composer
 * says it was answered and the Agent will continue, never that the approval failed to load.
 */
export function answeredApproval(
  decisions: readonly DecisionSnapshot[],
  ref: NonNullable<ApprovalNode['decisionRef']>,
): ApprovalNode | undefined {
  const value = decisions.find(
    (item) =>
      item.handle.sessionId === ref.sessionId &&
      item.handle.id === ref.id &&
      item.result?.reason === 'answered' &&
      !item.invalidation &&
      !item.consumption,
  )
  if (!value?.request.spec.options.every((option) => Object.hasOwn(options, option))) return
  return approvalNode(value, ref, 'decided')
}

/** Core's command-prefix offer, as recorded in the decision subject; absent when malformed. */
function offeredPrefix(value: unknown): Pick<ApprovalNode, 'prefixGrant'> {
  const offer = value as { tokens?: unknown; scope?: unknown } | null
  const tokens = offer?.tokens
  return Array.isArray(tokens) &&
    tokens.length >= 1 &&
    tokens.length <= 2 &&
    tokens.every((token) => typeof token === 'string' && token.length > 0) &&
    typeof offer?.scope === 'string' &&
    offer.scope.startsWith('shell:prefix:')
    ? { prefixGrant: { tokens: tokens as string[], scope: offer.scope } }
    : {}
}

function approvalNode(
  value: DecisionSnapshot,
  ref: NonNullable<ApprovalNode['decisionRef']>,
  state: 'pending' | 'decided',
): ApprovalNode {
  const { spec, expiresAt } = value.request
  const subject =
    spec.subject !== null && typeof spec.subject === 'object' && !Array.isArray(spec.subject)
      ? spec.subject
      : undefined
  const risk = subject?.risk
  const rewrite = subject?.rewrite
  return {
    kind: 'approval',
    id: ref.id,
    purpose: spec.purpose,
    category: value.request.category ?? 'question',
    seq: 0,
    state,
    decisionRef: ref,
    summary: spec.prompt,
    ...(spec.presentation ? { presentation: spec.presentation } : {}),
    risk: risk === 'destructive' || risk === 'always' || risk === 'budget' ? risk : 'unknown',
    options: spec.options.map((option) => options[option as keyof typeof options]),
    ...(state === 'pending' ? offeredPrefix(subject?.prefixGrant) : {}),
    // Show the complete decision subject, including the tool arguments and original summary.
    subjectText: JSON.stringify(spec.subject, null, 2),
    ...(expiresAt ? { expiresAt } : {}),
    // Core asking whether a call that lost its result ran: a reconciliation, not a permission.
    ...(value.request.owner === 'core/unknown-outcome'
      ? { reconcile: { tool: typeof subject?.name === 'string' && subject.name ? subject.name : 'tool' } }
      : {}),
    ...(state === 'decided' && value.result?.reason === 'answered'
      ? {
          decision: {
            verdict: value.result.response.option,
            via: value.result.code === 'full-access' ? 'full-access' : 'human',
            ...(value.result.code ? { reason: value.result.code } : {}),
          },
        }
      : {}),
    ...(rewrite &&
    typeof rewrite === 'object' &&
    !Array.isArray(rewrite) &&
    typeof rewrite.summary === 'string' &&
    Array.isArray(rewrite.by)
      ? {
          rewrite: {
            summary: rewrite.summary,
            by: rewrite.by.filter((by): by is string => typeof by === 'string'),
          },
        }
      : {}),
  }
}

export function approvalExpiry(expiresAt: string | undefined, t: Translate, now = Date.now()): string {
  if (!expiresAt) return ''
  const remaining = Date.parse(expiresAt) - now
  if (!Number.isFinite(remaining)) return ''
  if (remaining <= 0) return t('app.approval.expired')
  const unit = remaining >= 3_600_000 ? 'hours' : 'minutes'
  const count = Math.ceil(remaining / (unit === 'hours' ? 3_600_000 : 60_000))
  return t(`app.approval.expires.${unit}${count === 1 ? 'One' : ''}`, { count })
}
