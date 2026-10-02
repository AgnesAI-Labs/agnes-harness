import type { ApprovalRequest, PolicyEvaluateRequest, TrustedPolicyFacts } from '@agnes/protocol/runtime'

export type PolicyVerdict = 'allow' | 'ask' | 'deny'
export interface PreparedPolicyEvidence {
  readonly toolName: string
  readonly trustedManagementTool: boolean
  readonly hookDenied: boolean
  readonly priorDecisions: Readonly<Record<string, PolicyVerdict>>
  readonly rules: Readonly<Record<string, PolicyVerdict>>
  readonly argvNormalized: boolean
  readonly approval: ApprovalRequest | null
  readonly guardianVerified: boolean
  readonly guardianScopes: readonly string[]
}
export interface ComposedPolicyDecision {
  readonly decision: PolicyVerdict
  readonly reasonCodes: readonly string[]
}

/** Pure ordering of already verified facts. This function never prepares a hook or runs a model. */
export function defaultPolicyDecision(
  request: PolicyEvaluateRequest,
  evidence: PreparedPolicyEvidence,
): ComposedPolicyDecision {
  const facts = request.verifiedFacts
  const deny = (reason: string): ComposedPolicyDecision => ({ decision: 'deny', reasonCodes: [reason] })
  if (evidence.hookDenied) return deny('hook_denied')
  if (facts.authorization.decision === 'deny') return deny('authorization_denied')
  const policy = facts.toolPolicy
  const scopes = [...new Set(policy?.approvalScopes ?? [])]
  if (scopes.length === 0) scopes.push(`tool:${evidence.toolName}:execute`)
  if (scopes.some((scope) => evidence.priorDecisions[scope] === 'deny')) return deny('prior_denied')
  let needsAsk =
    policy !== null &&
    !evidence.trustedManagementTool &&
    (policy?.requiresApproval === 'always' ||
      (policy?.requiresApproval === 'destructive' && policy.isDestructive) ||
      (facts.taint.tainted && policy?.isReadOnly !== true))
  if (facts.authorization.decision === 'require-approval') needsAsk = true
  if (facts.configuration.yolo || facts.configuration.mode === 'off') needsAsk = false
  if (!needsAsk) return { decision: 'allow', reasonCodes: ['mode_or_risk_allowed'] }
  let unresolved = scopes.filter(
    (scope) =>
      evidence.priorDecisions[scope] === 'ask' ||
      (evidence.priorDecisions[scope] !== 'allow' && !grantCovers(facts, request, evidence.toolName, scope)),
  )
  if (unresolved.length === 0) return { decision: 'allow', reasonCodes: ['grant_or_prior_allowed'] }
  // All subsequent paths consume the same durable final hook display, including rule and guardian allow.
  if (evidence.approval === null || facts.approvalRequestRef === null) return deny('approval_not_prepared')
  if (facts.configuration.mode === 'smart') {
    if (facts.guardian.state === 'pending') return { decision: 'ask', reasonCodes: ['guardian_pending'] }
    if (facts.guardian.state === 'decided') {
      if (
        !evidence.guardianVerified ||
        evidence.guardianScopes.length === 0 ||
        facts.guardian.decision === null ||
        facts.guardian.resultRef === null ||
        facts.guardian.actionId === null
      )
        return deny('guardian_evidence_invalid')
      if (
        facts.guardian.decision === 'deny' &&
        unresolved.some((scope) => evidence.guardianScopes.includes(scope))
      )
        return deny('guardian_denied')
      if (facts.guardian.decision === 'allow') {
        unresolved = unresolved.filter((scope) => !evidence.guardianScopes.includes(scope))
        if (unresolved.length === 0) return { decision: 'allow', reasonCodes: ['guardian_allowed'] }
      }
    }
  }
  let ask = false
  for (const scope of unresolved) {
    const rule = evidence.argvNormalized ? evidence.rules[scope] : undefined
    if (rule === 'deny') return deny('rule_denied')
    if (
      rule !== 'allow' ||
      policy?.requiresApproval === 'always' ||
      (facts.taint.tainted && !scope.includes('/'))
    )
      ask = true
  }
  return { decision: ask ? 'ask' : 'allow', reasonCodes: [ask ? 'human_required' : 'rule_allowed'] }
}

function grantCovers(
  facts: TrustedPolicyFacts,
  request: PolicyEvaluateRequest,
  tool: string,
  scope: string,
): boolean {
  const sessionId = 'sessionId' in request.scope ? request.scope.sessionId : null
  return facts.grants.some(
    (grant) =>
      !grant.consumed &&
      grant.actorRef === request.principalRef &&
      (grant.kind === 'permanent' || grant.sessionId === sessionId) &&
      grant.toolName === tool &&
      grant.scopes.includes(scope) &&
      grant.policyVersion === facts.toolPolicy?.policyVersion &&
      (grant.validUntil === null || Date.parse(grant.validUntil) > Date.parse(facts.evaluatedAt)) &&
      (grant.kind !== 'once' || grant.inputDigest === request.inputDigest) &&
      (grant.kind !== 'permanent' || grant.profileDigest === facts.configuration.profileDigest),
  )
}

export interface PolicyContributor {
  readonly id: string
  readonly after: readonly string[]
  readonly mandatory: boolean
  evaluate(request: PolicyEvaluateRequest): ComposedPolicyDecision
}

/** Validate the complete graph before calling any contributor. Deny dominates ask, which dominates allow. */
export function composePolicies(
  request: PolicyEvaluateRequest,
  policies: readonly PolicyContributor[],
): ComposedPolicyDecision {
  const pending = new Map(policies.map((policy) => [policy.id, policy]))
  if (
    pending.size !== policies.length ||
    policies.some((policy) => !policy.id || policy.after.some((id) => !pending.has(id)))
  )
    return { decision: 'deny', reasonCodes: ['policy_graph_invalid'] }
  const sorted: PolicyContributor[] = []
  const done = new Set<string>()
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((policy) => policy.after.every((id) => done.has(id)))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (ready.length === 0) return { decision: 'deny', reasonCodes: ['policy_graph_cycle'] }
    for (const policy of ready) {
      sorted.push(policy)
      pending.delete(policy.id)
      done.add(policy.id)
    }
  }
  let decision: PolicyVerdict = 'allow'
  const reasonCodes: string[] = []
  for (const policy of sorted) {
    let result: ComposedPolicyDecision
    try {
      result = policy.evaluate(request)
      if (!['allow', 'ask', 'deny'].includes(result.decision)) throw new Error('invalid verdict')
    } catch {
      if (!policy.mandatory) continue
      result = { decision: 'deny', reasonCodes: ['mandatory_policy_unavailable'] }
    }
    if (result.decision === 'deny' || (result.decision === 'ask' && decision === 'allow'))
      decision = result.decision
    reasonCodes.push(...result.reasonCodes)
  }
  return { decision, reasonCodes }
}
