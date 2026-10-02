import { type ApprovalRequest, computeApprovalIntentDigest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { effectiveTaint, policyFactsMatch } from '../../src/runtime/policy/current-facts.js'
import {
  composePolicies,
  defaultPolicyDecision,
  type PreparedPolicyEvidence,
} from '../../src/runtime/policy/decision-composition.js'
import { digest, policyEvidence, policyInput, scope, until } from './policy-fixture.js'

function prepared(): PreparedPolicyEvidence {
  const approval: ApprovalRequest = {
    kind: 'approval',
    title: 'Run tool',
    body: 'Fixed display',
    actionRef: 'action',
    inputDigest: digest,
    policyDecisionRef: 'decision',
    scope,
    allowedResponders: ['principal'],
    expiresAt: until,
    idempotencyKey: 'ask',
    risk: 'destructive',
    intentDigest: digest,
  }
  const intent = computeApprovalIntentDigest(approval)
  if (!intent.ok) throw new Error('fixture')
  approval.intentDigest = intent.value
  return { ...policyEvidence(), approval }
}
function asking() {
  const request = policyInput()
  if (!request.verifiedFacts.toolPolicy) throw new Error('fixture')
  request.verifiedFacts.toolPolicy.isReadOnly = false
  request.verifiedFacts.toolPolicy.isDestructive = true
  request.verifiedFacts.toolPolicy.requiresApproval = 'destructive'
  request.verifiedFacts.approvalRequestRef = {
    kind: 'inline',
    schema: { typeId: 'agh.test/display@1', revision: 1, digest },
    value: {},
    bytes: 2,
    digest,
  }
  return request
}

describe('Policy preserved decision precedence', () => {
  it.each([
    ['manual destructive', 'manual', false, 'ask'],
    ['smart fallback', 'smart', false, 'ask'],
    ['off destructive', 'off', false, 'allow'],
    ['manual yolo', 'manual', true, 'allow'],
  ] as const)('%s', (_name, mode, yolo, decision) => {
    const request = asking()
    request.verifiedFacts.configuration.mode = mode
    request.verifiedFacts.configuration.yolo = yolo
    expect(defaultPolicyDecision(request, prepared()).decision).toBe(decision)
    expect(defaultPolicyDecision(request, { ...prepared(), hookDenied: true }).decision).toBe('deny')
    request.verifiedFacts.authorization.decision = 'deny'
    expect(defaultPolicyDecision(request, prepared()).decision).toBe('deny')
  })
  it('does not apply tool taint risk to a non-tool action while preserving resource approval', () => {
    const request = asking()
    request.verifiedFacts.toolPolicy = null
    request.verifiedFacts.taint.tainted = true
    expect(defaultPolicyDecision(request, prepared()).decision).toBe('allow')
    request.verifiedFacts.authorization.decision = 'require-approval'
    expect(defaultPolicyDecision(request, prepared()).decision).toBe('ask')
  })
  it('preserves trusted management exemption but never third party naming or strong deny', () => {
    const request = asking()
    expect(defaultPolicyDecision(request, { ...prepared(), toolName: 'subagent_create' }).decision).toBe(
      'ask',
    )
    expect(defaultPolicyDecision(request, { ...prepared(), trustedManagementTool: true }).decision).toBe(
      'allow',
    )
    request.verifiedFacts.authorization.decision = 'require-approval'
    expect(defaultPolicyDecision(request, { ...prepared(), trustedManagementTool: true }).decision).toBe(
      'ask',
    )
  })
  it('uses only matching unconsumed/valid grant evidence; evaluate never consumes it', () => {
    const request = asking()
    const facts = request.verifiedFacts
    facts.grants.push({
      grantId: 'once',
      revision: 1,
      kind: 'once',
      actorRef: 'principal',
      sessionId: 'session',
      toolName: 'tool',
      scopes: ['write'],
      profileDigest: digest,
      policyVersion: 'v1',
      inputDigest: digest,
      validUntil: until,
      consumed: false,
    })
    expect(defaultPolicyDecision(request, { ...prepared(), approval: null }).decision).toBe('allow')
    expect(facts.grants[0]?.consumed).toBe(false)
    for (const patch of [
      { inputDigest: 'b'.repeat(64) },
      { actorRef: 'other' },
      { sessionId: 'other' },
      { toolName: 'other' },
      { policyVersion: 'v2' },
      { scopes: ['other'] },
      { consumed: true },
      { validUntil: '2026-09-30T00:00:00Z' },
    ]) {
      const original = facts.grants[0]
      if (!original) throw new Error('fixture')
      facts.grants[0] = { ...original, ...patch }
      expect(defaultPolicyDecision(request, prepared()).decision).toBe('ask')
      facts.grants[0] = original
    }
    const grant = facts.grants[0]
    if (!grant) throw new Error('fixture')
    grant.kind = 'session'
    grant.inputDigest = 'b'.repeat(64)
    expect(defaultPolicyDecision(request, prepared()).decision).toBe('allow')
    grant.kind = 'permanent'
    grant.sessionId = 'other-session'
    expect(defaultPolicyDecision(request, prepared()).decision).toBe('allow')
    grant.profileDigest = 'b'.repeat(64)
    expect(defaultPolicyDecision(request, prepared()).decision).toBe('ask')
  })
  it('keeps the slash-scope rule exception, argv failure and always ordering', () => {
    const request = asking()
    request.verifiedFacts.taint.tainted = true
    const evidence = { ...prepared(), rules: { write: 'allow' } } as const
    expect(defaultPolicyDecision(request, evidence).decision).toBe('ask')
    if (!request.verifiedFacts.toolPolicy) throw new Error('fixture')
    request.verifiedFacts.toolPolicy.approvalScopes = ['fs/write']
    expect(defaultPolicyDecision(request, { ...evidence, rules: { 'fs/write': 'allow' } }).decision).toBe(
      'allow',
    )
    expect(
      defaultPolicyDecision(request, { ...evidence, argvNormalized: false, rules: { 'fs/write': 'allow' } })
        .decision,
    ).toBe('ask')
    request.verifiedFacts.toolPolicy.requiresApproval = 'always'
    expect(defaultPolicyDecision(request, { ...evidence, rules: { 'fs/write': 'allow' } }).decision).toBe(
      'ask',
    )
  })
  it('requires durable hook display before guardian/rule, and matching guardian evidence', () => {
    const request = asking()
    request.verifiedFacts.configuration.mode = 'smart'
    request.verifiedFacts.guardian = {
      state: 'decided',
      decision: 'allow',
      actionId: 'guardian',
      resultRef: null,
    }
    expect(
      defaultPolicyDecision(request, { ...prepared(), approval: null, guardianVerified: true }).decision,
    ).toBe('deny')
    expect(defaultPolicyDecision(request, { ...prepared(), guardianVerified: true }).decision).toBe('deny')
    request.verifiedFacts.guardian.state = 'pending'
    expect(defaultPolicyDecision(request, { ...prepared(), rules: { write: 'allow' } }).decision).toBe('ask')
    request.verifiedFacts.guardian.state = 'not-needed'
    expect(defaultPolicyDecision(request, prepared()).decision).toBe('ask')
  })
  it('binds guardian allow to its proven scopes rather than approving another scope', () => {
    const request = asking()
    request.verifiedFacts.configuration.mode = 'smart'
    if (!request.verifiedFacts.toolPolicy) throw new Error('fixture')
    request.verifiedFacts.toolPolicy.approvalScopes = ['write', 'delete']
    request.verifiedFacts.guardian = {
      state: 'decided',
      decision: 'allow',
      actionId: 'guardian',
      resultRef: { authorityId: 'authority', receiptId: 'receipt', digest },
    }
    const evidence = { ...prepared(), guardianVerified: true, guardianScopes: ['write'] }
    expect(defaultPolicyDecision(request, evidence).decision).toBe('ask')
    expect(
      defaultPolicyDecision(request, { ...evidence, guardianScopes: ['write', 'delete'] }).decision,
    ).toBe('allow')
    request.verifiedFacts.guardian.decision = 'deny'
    expect(defaultPolicyDecision(request, evidence).decision).toBe('deny')
  })
  it('never revives a cleared captured taint, and keeps new waiting-period sources', () => {
    const captured = { recordRevision: 1, sourceSeq: 2, clearedThroughSeq: 0 }
    expect(effectiveTaint({ recordRevision: 2, sourceSeq: 2, clearedThroughSeq: 2 }, captured)).toBe(false)
    expect(effectiveTaint({ recordRevision: 2, sourceSeq: 3, clearedThroughSeq: 2 }, captured)).toBe(true)
    expect(() => effectiveTaint(captured, { ...captured, sourceSeq: 3 })).toThrow()
    const request = policyInput()
    request.verifiedFacts.taint.current = { recordRevision: 2, sourceSeq: 3, clearedThroughSeq: 2 }
    request.verifiedFacts.taint.captured = captured
    const context = {
      principalRef: 'principal',
      scope,
      bindingId: 'binding',
      invocationId: 'i',
      deadline: until,
      traceRef: 't',
      authorizationRef: 'a',
      signal: new AbortController().signal,
    }
    expect(policyFactsMatch(request, context)).toBe(false)
    request.verifiedFacts.taint.tainted = true
    expect(policyFactsMatch(request, context)).toBe(true)
    expect(policyFactsMatch(request, { ...context, scope: { ...scope, runId: 'other' } })).toBe(false)
  })
  it('composition detects cycles before evaluation and keeps ask/deny stronger than any allow', () => {
    let executed = false
    const policy = {
      id: 'p',
      after: ['p'],
      mandatory: true,
      evaluate: () => {
        executed = true
        return { decision: 'allow', reasonCodes: [] } as const
      },
    }
    expect(composePolicies(policyInput(), [policy]).decision).toBe('deny')
    expect(executed).toBe(false)
    const ask = {
      ...policy,
      id: 'ask',
      after: [],
      evaluate: () => ({ decision: 'ask', reasonCodes: [] }) as const,
    }
    const allow = { ...policy, id: 'allow', after: ['ask'] }
    expect(composePolicies(policyInput(), [allow, ask]).decision).toBe('ask')
    const broken = {
      ...policy,
      id: 'unavailable',
      after: [],
      evaluate: () => {
        throw new Error('unavailable')
      },
    }
    expect(composePolicies(policyInput(), [broken, ask]).decision).toBe('deny')
    expect(composePolicies(policyInput(), [{ ...broken, mandatory: false }, ask]).decision).toBe('ask')
  })
})
