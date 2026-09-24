import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { UITimeline, UsageView } from '../gen/ts/agnes-v1.js'
import { Billing, InferenceEvent, ThinkingLevel } from '../gen/ts/model.js'
import { PresetDoc } from '../gen/ts/preset.js'
import { CostLedger } from '../gen/ts/session-v1.js'

const billing = { usdMicros: 1_234, source: 'gateway', subscription: true }
const usage = {
  totals: { input: 1_600, output: 58, cacheRead: 20, cacheWrite: 0, reasoning: 12 },
  cost: billing,
  context: { tokens: 2_000, window: 1_000_000, autoCompact: true },
  model: { route: 'agnes-subscription', id: 'deepseek-v4-pro', thinking: 'high' },
}

describe('I9 auth, usage and thinking protocol contracts', () => {
  it('accepts the complete footer projection and keeps it optional on older timelines', () => {
    expect(Value.Check(UsageView, usage)).toBe(true)
    expect(
      Value.Check(UITimeline, {
        sessionId: 's',
        upto: 9,
        generation: 1,
        opState: null,
        nodes: [],
        turns: [],
        usage,
      }),
    ).toBe(true)
    expect(
      Value.Check(UITimeline, {
        sessionId: 's',
        upto: 0,
        generation: 1,
        opState: null,
        nodes: [],
        turns: [],
      }),
    ).toBe(true)
  })

  it('uses integer micro-dollars and a closed billing source', () => {
    expect(Value.Check(Billing, billing)).toBe(true)
    expect(Value.Check(Billing, { ...billing, usdMicros: -1 })).toBe(false)
    expect(Value.Check(Billing, { ...billing, usdMicros: 1.5 })).toBe(false)
    expect(Value.Check(Billing, { ...billing, source: 'credits' })).toBe(false)
    expect(Value.Check(Billing, { ...billing, currency: 'USD' })).toBe(false)
  })

  it('closes thinking levels and rejects unsafe display identifiers', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      expect(Value.Check(ThinkingLevel, level)).toBe(true)
    expect(Value.Check(ThinkingLevel, 'extreme')).toBe(false)
    expect(Value.Check(UsageView, { ...usage, model: { ...usage.model, thinking: 'extreme' } })).toBe(false)
    expect(Value.Check(UsageView, { ...usage, model: { ...usage.model, route: 'bad\nroute' } })).toBe(false)
    expect(Value.Check(UsageView, { ...usage, model: { ...usage.model, id: 'bad\u001bmodel' } })).toBe(false)
    const { model: _model, ...withoutModel } = usage
    expect(Value.Check(UsageView, withoutModel)).toBe(false)
  })

  it('carries billing from inference usage into durable cost rows', () => {
    expect(
      Value.Check(InferenceEvent, {
        type: 'usage',
        tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'gateway',
        credits: 3,
        billing,
      }),
    ).toBe(true)
    expect(
      Value.Check(CostLedger, {
        purpose: 'inference',
        effectId: 'effect-1',
        tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'gateway',
        credits: 3,
        billing,
        model: 'deepseek-v4-pro',
      }),
    ).toBe(true)
  })

  it('allows a signed USD adjustment without changing the token totals contract', () => {
    const row = {
      purpose: 'inference',
      effectId: 'adjustment-1',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'gateway',
      model: 'deepseek-v4-pro',
      adjustment: { of: 8, delta: -2, usdMicrosDelta: -500, reason: 'gateway reconciliation' },
    }
    expect(Value.Check(CostLedger, row)).toBe(true)
    expect(Value.Check(CostLedger, { ...row, adjustment: { ...row.adjustment, usdMicrosDelta: 0.5 } })).toBe(
      false,
    )
  })

  it('accepts per-slot preset thinking and rejects unknown slots or levels', () => {
    expect(
      Value.Check(PresetDoc, {
        name: 'subscription',
        model: { thinking: { primary: 'high', compaction: 'medium' } },
      }),
    ).toBe(true)
    expect(
      Value.Check(PresetDoc, { name: 'subscription', model: { thinking: { primary: 'extreme' } } }),
    ).toBe(false)
    expect(Value.Check(PresetDoc, { name: 'subscription', model: { thinking: { made_up: 'high' } } })).toBe(
      false,
    )
  })
})

it('accepts optional call details and rejects invalid token/timing domains', () => {
  const cost = {
    kind: 'cost',
    id: 'c1',
    seq: 1,
    source: 'estimated',
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 },
    timing: { ttftMs: 10, durationMs: 20 },
    billing,
    model: 'm',
    interrupted: true,
  }
  const timeline = { sessionId: 's', upto: 1, generation: 1, opState: null, nodes: [cost], turns: [] }
  expect(Value.Check(UITimeline, timeline)).toBe(true)
  expect(
    Value.Check(UITimeline, { ...timeline, nodes: [{ ...cost, tokens: { ...cost.tokens, input: -1 } }] }),
  ).toBe(false)
  expect(Value.Check(UITimeline, { ...timeline, nodes: [{ ...cost, timing: { durationMs: -1 } }] })).toBe(
    false,
  )
  expect(
    Value.Check(UsageView, {
      ...usage,
      reasoningComplete: false,
      billingComplete: false,
      context: { ...usage.context, source: 'estimated' },
      model: { ...usage.model, maxTokens: 8192 },
    }),
  ).toBe(true)
})
