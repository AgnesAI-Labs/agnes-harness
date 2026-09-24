import { describe, expect, it } from 'vitest'
import { classifyToolRecovery } from '../src/step/tool-recovery.js'

const policy = (
  overrides: Partial<{
    isReadOnly: boolean
    isDestructive: boolean
    replay: 'safe' | 'never' | 'idempotent'
  }> = {},
) => ({
  isReadOnly: true,
  isDestructive: false,
  replay: 'safe' as const,
  ...overrides,
})

describe('tool recovery classifier', () => {
  it.each(['planned', 'awaiting_approval', 'approved'] as const)(
    'closes pre-dispatch %s calls as not started',
    (status) => {
      expect(
        classifyToolRecovery({
          mode: 'close',
          call: { status, replay: 'safe' },
          policy: policy(),
          policyBinding: 'trusted',
          hasMatchingResult: false,
        }),
      ).toBe('not-started')
    },
  )

  it('settles a responded call with its matching result without another dispatch', () => {
    expect(
      classifyToolRecovery({
        mode: 'resume',
        call: {
          status: 'responded',
          replay: 'safe',
          effectId: 'e1',
          dispatchAttempt: 1,
          dispatchPhase: 'responded',
        },
        policy: policy(),
        policyBinding: 'trusted',
        hasMatchingResult: true,
      }),
    ).toBe('settle-only')
  })

  it('treats a responded mutation without its matching result as unknown', () => {
    expect(
      classifyToolRecovery({
        mode: 'resume',
        call: {
          status: 'responded',
          replay: 'never',
          effectId: 'e1',
          dispatchAttempt: 1,
          dispatchPhase: 'responded',
        },
        policy: policy({ isReadOnly: false, isDestructive: true, replay: 'never' }),
        policyBinding: 'trusted',
        hasMatchingResult: false,
      }),
    ).toBe('unknown')
  })

  it.each([
    {
      status: 'effect_pending' as const,
      replay: 'never' as const,
      p: policy({ replay: 'never' }),
    },
    {
      status: 'effect_pending' as const,
      replay: 'safe' as const,
      p: policy({ isReadOnly: false, isDestructive: true }),
    },
    {
      status: 'dispatched',
      replay: 'never' as const,
      dispatchAttempt: 1 as const,
      dispatchPhase: 'may_have_sent' as const,
      p: policy({ replay: 'never' }),
    },
  ])(
    'never replays an ambiguous mutation ($status)',
    ({ status, replay, dispatchAttempt, dispatchPhase, p }) => {
      expect(
        classifyToolRecovery({
          mode: 'resume',
          call: {
            status: status as 'effect_pending' | 'dispatched',
            replay,
            effectId: 'e1',
            ...(dispatchAttempt === undefined ? {} : { dispatchAttempt }),
            ...(dispatchPhase === undefined ? {} : { dispatchPhase }),
          },
          policy: p,
          policyBinding: 'trusted',
          hasMatchingResult: false,
        }),
      ).toBe('unknown')
    },
  )

  it('allows at most one recovery dispatch for a safe read', () => {
    const first = {
      mode: 'resume' as const,
      policy: policy(),
      policyBinding: 'trusted' as const,
      hasMatchingResult: false,
    }
    expect(
      classifyToolRecovery({
        ...first,
        call: {
          status: 'dispatched',
          replay: 'safe',
          effectId: 'e1',
          dispatchAttempt: 1,
          dispatchPhase: 'may_have_sent',
        },
      }),
    ).toBe('retry-same-effect')
    expect(
      classifyToolRecovery({
        ...first,
        call: {
          status: 'dispatched',
          replay: 'safe',
          effectId: 'e1',
          dispatchAttempt: 2,
          dispatchPhase: 'may_have_sent',
        },
      }),
    ).toBe('unknown')
  })

  it('requires trusted reconciliation before retrying an idempotent call', () => {
    const input = {
      mode: 'resume' as const,
      call: {
        status: 'dispatched' as const,
        replay: 'idempotent' as const,
        effectId: 'e1',
        dispatchAttempt: 1 as const,
        dispatchPhase: 'may_have_sent' as const,
      },
      policy: policy({ replay: 'idempotent' }),
      policyBinding: 'trusted' as const,
      hasMatchingResult: false,
    }
    expect(classifyToolRecovery(input)).toBe('unknown')
    expect(classifyToolRecovery({ ...input, reconciliation: 'not-applied' })).toBe('retry-same-effect')
  })

  it('permits only attempt two for a durably proven not-sent attempt one', () => {
    const base = {
      mode: 'resume' as const,
      policy: policy({ isReadOnly: false, isDestructive: true, replay: 'never' }),
      policyBinding: 'trusted' as const,
      hasMatchingResult: false,
    }
    expect(
      classifyToolRecovery({
        ...base,
        call: {
          status: 'dispatch_pending',
          replay: 'never',
          executionDomain: 'host-computer-use',
          effectId: 'e1',
          dispatchAttempt: 1,
          dispatchPhase: 'not_sent',
        },
      }),
    ).toBe('retry-same-effect')
    expect(
      classifyToolRecovery({
        ...base,
        call: {
          status: 'dispatch_pending',
          replay: 'never',
          executionDomain: 'host-computer-use',
          effectId: 'e1',
          dispatchAttempt: 2,
          dispatchPhase: 'not_sent',
        },
      }),
    ).toBe('unknown')
    expect(
      classifyToolRecovery({
        ...base,
        mode: 'cancel',
        call: {
          status: 'dispatch_pending',
          replay: 'never',
          executionDomain: 'host-computer-use',
          effectId: 'e1',
          dispatchAttempt: 1,
          dispatchPhase: 'not_sent',
        },
      }),
    ).toBe('cancelled')
  })

  it('does not trust a workspace claim that an ambiguous mutation was not sent', () => {
    expect(
      classifyToolRecovery({
        mode: 'resume',
        call: {
          status: 'dispatch_pending',
          replay: 'never',
          executionDomain: 'workspace',
          effectId: 'e1',
          dispatchAttempt: 1,
          dispatchPhase: 'not_sent',
        },
        policy: policy({ isReadOnly: false, isDestructive: true, replay: 'never' }),
        policyBinding: 'trusted',
        hasMatchingResult: false,
      }),
    ).toBe('unknown')
    expect(
      classifyToolRecovery({
        mode: 'cancel',
        call: {
          status: 'dispatch_pending',
          replay: 'never',
          executionDomain: 'workspace',
          effectId: 'e1',
          dispatchAttempt: 1,
          dispatchPhase: 'not_sent',
        },
        policy: policy({ isReadOnly: false, isDestructive: true, replay: 'never' }),
        policyBinding: 'trusted',
        hasMatchingResult: false,
      }),
    ).toBe('unknown')
  })

  it('does not continue a pre-dispatch call with missing or tampered policy binding', () => {
    expect(
      classifyToolRecovery({
        mode: 'resume',
        call: { status: 'approved', replay: 'safe' },
        policy: policy(),
        policyBinding: 'untrusted',
        hasMatchingResult: false,
      }),
    ).toBe('unknown')
  })

  it('fails closed when policy binding is not trusted', () => {
    expect(
      classifyToolRecovery({
        mode: 'resume',
        call: { status: 'effect_pending', replay: 'safe', effectId: 'e1' },
        policy: policy(),
        policyBinding: 'untrusted',
        hasMatchingResult: false,
      }),
    ).toBe('unknown')
  })

  it('does not reset a legacy safe-read retry budget across repeated crashes', () => {
    const crashed = {
      mode: 'resume' as const,
      call: { status: 'effect_pending' as const, replay: 'safe' as const, effectId: 'legacy-e1' },
      policy: policy(),
      policyBinding: 'trusted' as const,
      hasMatchingResult: false,
    }
    expect(classifyToolRecovery(crashed)).toBe('unknown')
    expect(classifyToolRecovery(crashed)).toBe('unknown')
  })

  it('treats a post-dispatch close as unknown even for a safe read', () => {
    expect(
      classifyToolRecovery({
        mode: 'close',
        call: {
          status: 'dispatched',
          replay: 'safe',
          effectId: 'e1',
          dispatchAttempt: 1,
          dispatchPhase: 'may_have_sent',
        },
        policy: policy(),
        policyBinding: 'trusted',
        hasMatchingResult: false,
      }),
    ).toBe('unknown')
  })
})
