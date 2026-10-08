import { describe, expect, it } from 'vitest'
import {
  admitHotPolicyEntry,
  applyHotPolicyRow,
  applyHotPolicySnapshot,
  approvalTicketRevision,
  assertDynamicLimitKey,
  assertHotPolicyKey,
  bindApprovalTicket,
  businessLimit,
  classifyProfileKey,
  commandHookInvocationSnapshot,
  createHotPolicyFacade,
  finishHotPolicyDrain,
  releaseHotPolicyEntry,
} from '../src/profile-policy.js'

describe('dynamic profile policy keys', () => {
  it('classifies the five hot rows and refuses process-static limits', () => {
    expect(classifyProfileKey('policy:approvals')).toBe('hot')
    expect(classifyProfileKey('policy:command-hooks')).toBe('hot')
    expect(classifyProfileKey('policy:capabilities')).toBe('hot')
    expect(classifyProfileKey('policy:workspace-packages')).toBe('hot')
    expect(classifyProfileKey('policy:business-limits')).toBe('hot')
    expect(classifyProfileKey('lease.ttl_ms')).toBe('static')
    expect(() => assertHotPolicyKey('lease.ttl_ms')).toThrow(/E_STATIC_COMPONENT/)
    expect(() => assertDynamicLimitKey('lease.ttl_ms')).toThrow(/E_STATIC_COMPONENT/)
    expect(() => assertDynamicLimitKey('daemon.foo')).toThrow(/E_STATIC_COMPONENT/)
    expect(() => assertDynamicLimitKey('worker.x')).toThrow(/E_STATIC_COMPONENT/)
    expect(() => assertDynamicLimitKey('jobs.y')).toThrow(/E_STATIC_COMPONENT/)
    expect(() => assertDynamicLimitKey('shutdown.z')).toThrow(/E_STATIC_COMPONENT/)
    expect(() => assertDynamicLimitKey('unknown')).toThrow(/E_POLICY_UNKNOWN/)
    expect(() => assertDynamicLimitKey('approval.park')).not.toThrow()
    expect(() => assertDynamicLimitKey('cost.credits_per_usd')).not.toThrow()
    expect(() => applyHotPolicyRow('policy:approvals')).not.toThrow()
    expect(() => applyHotPolicyRow('lease.ttl_ms')).toThrow(/E_STATIC_COMPONENT/)
    const facade = createHotPolicyFacade()
    expect(() =>
      applyHotPolicySnapshot(facade, 'policy:business-limits', {
        revision: 'b1',
        value: { 'lease.ttl_ms': 1 },
      }),
    ).toThrow(/E_STATIC_COMPONENT/)
    expect(() =>
      applyHotPolicySnapshot(facade, 'policy:business-limits', {
        revision: 'b2',
        value: { 'media.foo': 2 },
      }),
    ).toThrow(/E_POLICY_UNKNOWN/)
    applyHotPolicySnapshot(facade, 'policy:business-limits', {
      revision: 'b3',
      value: { 'approval.park': 1, 'cost.credits_per_usd': 4 },
    })
    expect(businessLimit(facade, 'approval.park')).toBe(1)
  })

  it('keeps approval tickets on the revision they bound and lets new requests read current', () => {
    const facade = createHotPolicyFacade()
    applyHotPolicySnapshot(facade, 'policy:approvals', { revision: 'r1', value: { mode: 'prompt' } })
    expect(bindApprovalTicket(facade, 'ticket-old')).toBe('r1')
    applyHotPolicySnapshot(facade, 'policy:approvals', { revision: 'r2', value: { mode: 'auto' } })
    expect(approvalTicketRevision(facade, 'ticket-old')).toBe('r1')
    expect(bindApprovalTicket(facade, 'ticket-new')).toBe('r2')
  })

  it('freezes command-hooks per invocation so a mid-call update waits for the next', () => {
    const facade = createHotPolicyFacade()
    applyHotPolicySnapshot(facade, 'policy:command-hooks', { revision: 'h1', value: ['a'] })
    const first = commandHookInvocationSnapshot(facade)
    applyHotPolicySnapshot(facade, 'policy:command-hooks', { revision: 'h2', value: ['b'] })
    expect(first).toEqual({ revision: 'h1', value: ['a'] })
    expect(commandHookInvocationSnapshot(facade)).toEqual({ revision: 'h2', value: ['b'] })
  })

  it('refuses new capability and workspace-package admission until admitted calls drain', () => {
    const facade = createHotPolicyFacade()
    applyHotPolicySnapshot(facade, 'policy:capabilities', { revision: 'c1', value: ['tools'] })
    expect(admitHotPolicyEntry(facade, 'policy:capabilities')).toBe(true)
    applyHotPolicySnapshot(facade, 'policy:capabilities', { revision: 'c2', value: [] })
    expect(admitHotPolicyEntry(facade, 'policy:capabilities')).toBe(false)
    expect(facade.current.get('policy:capabilities')?.revision).toBe('c1')
    expect(() => finishHotPolicyDrain(facade, 'policy:capabilities', { revision: 'c2', value: [] })).toThrow(
      /E_POLICY_DRAIN/,
    )
    releaseHotPolicyEntry(facade)
    expect(facade.current.get('policy:capabilities')?.revision).toBe('c2')
    expect(admitHotPolicyEntry(facade, 'policy:workspace-packages')).toBe(true)
  })

  it('applies business-limits only for park and credits_per_usd on the next invocation', () => {
    const facade = createHotPolicyFacade()
    expect(businessLimit(facade, 'approval.park')).toBe(0)
    expect(businessLimit(facade, 'cost.credits_per_usd')).toBeUndefined()
    applyHotPolicySnapshot(facade, 'policy:business-limits', {
      revision: 'b1',
      value: { 'approval.park': 1, 'cost.credits_per_usd': 2.5 },
    })
    expect(businessLimit(facade, 'approval.park')).toBe(1)
    expect(businessLimit(facade, 'cost.credits_per_usd')).toBe(2.5)
  })
})
