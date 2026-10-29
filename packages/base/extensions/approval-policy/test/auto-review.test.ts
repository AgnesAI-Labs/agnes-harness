import { defaultToolPolicy, type ToolPolicyInput, type ToolPolicyPorts } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { createAutoReviewPolicy } from '../src/auto-review.js'

const input: ToolPolicyInput = {
  sessionKey: 'test',
  cwd: '/workspace',
  workspaceRoot: '/workspace',
  actor: { id: 'human', org: 'test', role: 'user', deptPath: [], attrs: {} },
  call: { id: 't1', name: 'shell', args: { command: 'pnpm lint' } },
  policy: {
    isReadOnly: false,
    isDestructive: true,
    replay: 'never',
    requiresApproval: 'destructive',
    approvalScopes: [],
  },
  tainted: false,
  fullAccess: false,
  approvalMode: 'auto-review',
}
const policy = createAutoReviewPolicy(defaultToolPolicy)
const ports = (text: string, reserve = true): ToolPolicyPorts => ({
  reserve: () => reserve,
  model: async () => ({ text, model: 'scripted-cheap', cost: 0.01 }),
})

describe('official auto-review policy', () => {
  it.each([
    ['allow', 'low', 'allow'],
    ['deny', 'medium', 'deny'],
    ['escalate', 'medium', 'ask'],
    ['deny', 'low', 'ask'],
    ['escalate', 'low', 'ask'],
    ['allow', 'high', 'ask'],
    ['allow', 'medium', 'ask'],
  ])('handles %s/%s as %s', async (decision, risk, effect) => {
    const result = await policy.decide(
      input,
      new AbortController().signal,
      ports(JSON.stringify({ decision, risk, reason: 'Scripted reason' })),
    )
    expect(result.review?.scopePreview).toEqual({
      args: JSON.stringify(input.call.args),
      cwd: input.cwd,
      mode: 'default / auto-review',
    })
    expect(result.effect).toBe(effect)
    expect(result.review).toMatchObject({
      model: 'scripted-cheap',
      cost: 0.01,
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })
  it('escalates timeout, provider error, malformed output, budget and ineligible calls', async () => {
    for (const config of [null, false, 0, { maxReviews: -1 }]) {
      expect(
        await policy.decide({ ...input, config }, new AbortController().signal, ports('{}')),
      ).toMatchObject({
        effect: 'ask',
        reason: 'Invalid reviewer configuration; human approval required',
      })
    }
    for (const scripted of [
      {
        reserve: () => {
          throw new Error('budget unavailable')
        },
        model: ports('{}').model,
      },
      ports('not json'),
      ports('{}'),
      ports('{}', false),
      {
        reserve: () => true,
        model: async () => {
          throw new Error('provider')
        },
      },
      { reserve: () => true, model: () => new Promise<never>(() => {}) },
    ]) {
      expect(
        (await policy.decide({ ...input, config: { timeoutMs: 2 } }, new AbortController().signal, scripted))
          .effect,
      ).toBe('ask')
    }
    expect(
      (
        await policy.decide(
          { ...input, config: { eligibleTools: ['read'] } },
          new AbortController().signal,
          ports('{}'),
        )
      ).reason,
    ).toContain('eligibility')
  })
  it('preserves human-only once review even under off, full-access and auto-review', async () => {
    const approval = {
      reviewerRequirement: 'human' as const,
      grantConstraints: 'once' as const,
      subjectRevision: 'a'.repeat(64),
    }
    const guarded = createAutoReviewPolicy({
      id: 'plan',
      version: '1',
      decide: () => ({ effect: 'ask', reason: 'review plan', approval }),
    })
    for (const changed of [{ fullAccess: true }, { approvalMode: 'off' as const }, {}])
      expect(
        await guarded.decide(
          { ...input, ...changed },
          new AbortController().signal,
          ports('{"decision":"allow","risk":"low"}'),
        ),
      ).toEqual({ effect: 'ask', reason: 'review plan', approval })
  })

  it('preserves hard deny and does not review base allowances', async () => {
    for (const effect of ['deny', 'allow'] as const) {
      const guarded = createAutoReviewPolicy({
        id: 'base',
        version: '1',
        decide: () => ({ effect, reason: 'hard rule' }),
      })
      expect(
        await guarded.decide(input, new AbortController().signal, {
          reserve: () => {
            throw new Error('must not review')
          },
          model: async () => {
            throw new Error('must not call model')
          },
        }),
      ).toEqual({ effect, reason: 'hard rule' })
    }
  })
  it('preserves the base policy full-access and off decisions', async () => {
    for (const changed of [{ fullAccess: true }, { approvalMode: 'off' as const }]) {
      expect(
        await policy.decide({ ...input, ...changed }, new AbortController().signal, {
          reserve: () => {
            throw new Error('must not reserve')
          },
          model: async () => {
            throw new Error('must not review')
          },
        }),
      ).toMatchObject({ effect: 'allow' })
    }
  })

  it('allows authorized medium only when configured, but always escalates tainted allowances', async () => {
    const model = ports(JSON.stringify({ decision: 'allow', risk: 'medium', reason: 'Explicit human scope' }))
    expect(
      (await policy.decide({ ...input, config: { maxRisk: 'medium' } }, new AbortController().signal, model))
        .effect,
    ).toBe('allow')
    expect(
      (
        await policy.decide(
          { ...input, tainted: true, config: { maxRisk: 'medium' } },
          new AbortController().signal,
          model,
        )
      ).effect,
    ).toBe('ask')
  })
  it('retains cost estimates on a failed request and never auto-allows cancellation', async () => {
    const controller = new AbortController()
    const result = await policy.decide(input, controller.signal, {
      reserve: () => true,
      model: async (_request, _signal, onUsage) => {
        onUsage?.({ model: 'scripted-cheap', cost: 0.02, costSource: 'estimated' })
        throw new Error('stream interrupted')
      },
    })
    expect(result).toMatchObject({
      effect: 'ask',
      review: { model: 'scripted-cheap', cost: 0.02, costSource: 'estimated' },
    })
    controller.abort()
    await expect(policy.decide(input, controller.signal, ports('{}'))).rejects.toThrow()
  })

  it('uses only explicit exact-argument human overrides for future calls', async () => {
    const first = await policy.decide(
      input,
      new AbortController().signal,
      ports(JSON.stringify({ decision: 'allow', risk: 'low', reason: 'Bounded lint' })),
    )
    const config = {
      overrides: [
        {
          tool: 'shell',
          scopeHash: first.review!.scopeHash,
          decision: 'deny' as const,
          risk: 'medium' as const,
        },
      ],
    }
    expect((await policy.decide({ ...input, config }, new AbortController().signal)).review).toMatchObject({
      decision: 'deny',
      source: 'human-override',
    })
    const savedRule = config.overrides[0]
    if (!savedRule) throw new Error('Missing rule fixture')
    const allowConfig = {
      overrides: [{ ...savedRule, decision: 'allow' as const, risk: 'low' as const }],
    }
    for (const tainted of [false, true]) {
      const decision = await policy.decide(
        { ...input, config: allowConfig, tainted },
        new AbortController().signal,
      )
      expect(decision.effect).toBe(tainted ? 'ask' : 'allow')
      expect(decision.review).toMatchObject({
        source: 'human-override',
        decision: tainted ? 'escalate' : 'allow',
      })
      if (tainted) expect(decision.reason).toContain('Matching human rule: allow (low)')
    }
    for (const changed of [
      { cwd: '/another-workspace' },
      { actor: { ...input.actor, id: 'another-human' } },
      { policy: { ...input.policy, replay: 'safe' as const } },
    ])
      expect(
        (await policy.decide({ ...input, config, ...changed }, new AbortController().signal)).effect,
      ).toBe('ask')
    expect(
      (
        await policy.decide(
          { ...input, config, call: { ...input.call, args: { command: 'pnpm build' } } },
          new AbortController().signal,
        )
      ).effect,
    ).toBe('ask')
  })
})
