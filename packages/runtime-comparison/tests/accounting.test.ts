import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type AttemptEvidence, accountLane, type Pricing, readLaneAccounting } from '../src/accounting.js'
import { pricingFromModelQuote } from '../src/pricing.js'

const quote: Pricing = {
  currency: 'USD',
  perMillion: { inputUncached: 1, cacheRead: 0.1, cacheWrite: 2, output: 4 },
  multiplier: 2,
}
const usage = {
  inputUncached: 10,
  cacheRead: 2,
  cacheWrite: 3,
  output: 5,
  reasoning: 2,
  total: 20,
}
const event = (seq: number, changes: Partial<AttemptEvidence> = {}): AttemptEvidence => ({
  seq,
  originSeq: seq,
  attemptId: `request-${seq}`,
  family: 'llm',
  stage: 'settled',
  usage,
  pricing: quote,
  ...changes,
})

describe('fixed-prefix comparison accounting', () => {
  it('preserves actual capture purpose/outcomes, estimated billing and missing Jev billing at each prefix', () => {
    const captured = JSON.parse(
      readFileSync(new URL('../../core/test/fixtures/jev-real-trace.json', import.meta.url), 'utf8'),
    )
    const requests = new Map<string, AttemptEvidence>()
    const events: AttemptEvidence[] = []
    for (const row of captured.events) {
      const record = row.data?.record
      if (record?.kind === 'model.requested') {
        const start: AttemptEvidence = {
          seq: row.seq,
          originSeq: row.seq,
          attemptId: record.attempt,
          family: record.call.purpose === 'decision' ? 'jev' : 'llm',
          stage: 'started',
          purpose: record.call.purpose,
          route: record.call.endpoint,
          model: record.call.requestedModel,
        }
        requests.set(record.id, start)
        events.push(start)
      } else if (record?.kind === 'model.settled') {
        const start = requests.get(record.requested)
        if (!start) throw new Error('Missing captured request')
        const actual = record.settlement.usage
        const tokens = actual?.tokens
        const inputTotal = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : undefined
        events.push({
          ...start,
          seq: row.seq,
          stage: 'settled',
          outcome: 'completed',
          billing: actual?.billing ?? null,
          usage: tokens
            ? {
                inputUncached: tokens.input,
                cacheRead: tokens.cacheRead,
                cacheWrite: tokens.cacheWrite,
                output: tokens.output,
                reasoning: tokens.reasoning,
                inputTotal,
                total: inputTotal + tokens.output,
              }
            : null,
        })
      }
    }
    const result = accountLane(events, { afterSeq: 0, throughSeq: 93 }, true)
    expect(result.llm.outcomes).toEqual({ completed: 4, failed: 0, cancelled: 0, unknown: 0, pending: 0 })
    expect(result.llm.byPurpose.parameters?.attempts).toBe(3)
    expect(result.llm.byPurpose.answer?.attempts).toBe(1)
    expect(result.llm.reportedBilling.estimated).toMatchObject({
      attempts: 4,
      usdMicros: { state: 'complete', value: 2667, missing: 0 },
      nonSubscriptionAttempts: 4,
    })
    expect(result.llm.reportedBilling.missingAttempts).toBe(0)
    expect(result.llm.costs).toEqual({})
    expect(result.jev.reportedBilling.missingAttempts).toBe(4)
    expect(result.jev.reportedBilling.gateway.usdMicros).toMatchObject({
      state: 'unknown',
      value: null,
      knownSubtotal: null,
    })
    const beforeAnswer = accountLane(events, { afterSeq: 0, throughSeq: 92 }, true)
    expect(beforeAnswer.llm.outcomes.pending).toBe(1)
    expect(beforeAnswer.llm.reportedBilling.estimated.usdMicros).toMatchObject({
      state: 'partial',
      value: null,
      knownSubtotal: 2213,
      missing: 1,
    })
    expect(beforeAnswer.llm.tokens.inputTotal.knownSubtotal).toBe(28538)
  })

  it('separates billing sources and subscription coverage while keeping legacy outcomes unknown', () => {
    const result = accountLane(
      [
        event(1, { stage: 'started', purpose: null, route: null, model: null, usage: null, pricing: null }),
        event(2, {
          originSeq: 1,
          attemptId: 'request-1',
          route: 'route',
          model: 'requested',
          observedModel: 'actual',
          purpose: 'title',
          outcome: 'failed',
          billing: { usdMicros: 100, source: 'gateway', subscription: true },
        }),
        event(3, {
          purpose: 'compaction',
          outcome: 'cancelled',
          billing: { usdMicros: 40, source: 'estimated', subscription: false },
        }),
        event(4, { usage: null, pricing: null }),
        event(5, { stage: 'started', usage: null, pricing: null }),
      ],
      { afterSeq: 0, throughSeq: 5 },
      true,
    )
    expect(result.issues).toEqual([])
    expect(result.llm.outcomes).toEqual({ completed: 0, failed: 1, cancelled: 1, unknown: 1, pending: 1 })
    expect(result.llm.byPurpose.title?.outcomes.failed).toBe(1)
    expect(result.llm.byPurpose.compaction?.outcomes.cancelled).toBe(1)
    expect(result.llm.byPurpose.unknown?.attempts).toBe(2)
    expect(result.llm.reportedBilling.gateway).toMatchObject({
      attempts: 1,
      subscriptionAttempts: 1,
      usdMicros: { state: 'partial', value: null, knownSubtotal: 100, missing: 2 },
    })
    expect(result.llm.reportedBilling.estimated.usdMicros.knownSubtotal).toBe(40)
    expect(result.llm.reportedBilling.missingAttempts).toBe(2)
    expect(result.llm.costs.USD?.knownSubtotal).toBeCloseTo(0.0001448)
  })

  it.each([
    { purpose: '' },
    { route: 12 },
    { model: 'a'.repeat(257) },
    { observedModel: [] },
    { outcome: 'success' },
    { billing: { usdMicros: -1, source: 'gateway', subscription: true } },
    { billing: { usdMicros: 1, source: 'credits', subscription: false } },
    { billing: { usdMicros: 1, source: 'estimated', subscription: 'yes' } },
  ])('rejects malformed attempt metadata %j without reporting usage or charges', (changes) => {
    const result = accountLane(
      [event(1, changes as unknown as Partial<AttemptEvidence>)],
      { afterSeq: 0, throughSeq: 1 },
      true,
    )
    expect(result.issues).toContain('invalid_attempt_metadata')
    expect(result.llm.outcomes.unknown).toBe(1)
    expect(result.llm.tokens.output.knownSubtotal).toBeNull()
    expect(result.llm.reportedBilling.missingAttempts).toBe(1)
    expect(result.llm.costs).toEqual({})
  })

  it.each(['purpose', 'route', 'model', 'observedModel', 'outcome', 'billing'] as const)(
    'rejects conflicting %s metadata on the same attempt',
    (key) => {
      const first = event(1, {
        purpose: 'answer',
        route: 'route-a',
        model: 'requested',
        observedModel: 'actual',
        outcome: 'completed',
        billing: { usdMicros: 10, source: 'gateway', subscription: false },
      })
      const different = {
        purpose: 'title',
        route: 'route-b',
        model: 'other',
        observedModel: 'other',
        outcome: 'failed',
        billing: { usdMicros: 11, source: 'gateway', subscription: false },
      }
      const second = { ...first, seq: 2, [key]: different[key] }
      const result = accountLane([first, second as AttemptEvidence], { afterSeq: 0, throughSeq: 2 }, true)
      expect(result.issues).toContain('conflicting_attempt')
      expect(result.llm.outcomes.unknown).toBe(1)
      expect(result.llm.reportedBilling.gateway.usdMicros.knownSubtotal).toBeNull()
      expect(result.llm.tokens.output.knownSubtotal).toBeNull()
    },
  )

  it('retains independent attested input totals without inventing cache splits and rejects contradictions', () => {
    const result = accountLane(
      [event(1, { usage: { inputTotal: 100, output: 5, total: 105 }, pricing: null })],
      { afterSeq: 0, throughSeq: 1 },
      true,
    )
    expect(result.llm.tokens.inputTotal.value).toBe(100)
    expect(result.llm.tokens.total.value).toBe(105)
    expect(result.llm.tokens.inputUncached.knownSubtotal).toBeNull()
    expect(result.llm.tokens.cacheRead.knownSubtotal).toBeNull()
    for (const changed of [
      { ...usage, inputTotal: 99 },
      { inputTotal: 100, output: 5, total: 999 },
    ]) {
      const invalid = accountLane([event(1, { usage: changed })], { afterSeq: 0, throughSeq: 1 }, true)
      expect(invalid.issues).toContain('invalid_usage')
      expect(invalid.llm.tokens.inputTotal.knownSubtotal).toBeNull()
    }
  })
  it('freezes the upper cursor across async reads and excludes inherited and later events', async () => {
    const window = { afterSeq: 2, throughSeq: 5 }
    const events = [event(3), event(4, { originSeq: 1 }), event(5, { family: 'jev' })]
    const pending = readLaneAccounting(
      {
        async read(received) {
          expect(received).toEqual({ afterSeq: 2, throughSeq: 5 })
          await Promise.resolve()
          events.push(event(6))
          return { events, complete: true }
        },
      },
      window,
    )
    window.throughSeq = 99
    const result = await pending
    expect(result.throughSeq).toBe(5)
    expect(result.llm.attempts).toBe(1)
    expect(result.jev.attempts).toBe(1)
    expect(result.llm.tokens.inputUncached.value).toBe(10)
    expect(result.llm.costs.USD?.value).toBeCloseTo(0.0000724)
  })

  it('counts real attempts independently even with equal identities across Jev and LLM, and ignores exact duplicate records', () => {
    const first = event(1, { attemptId: 'same' })
    const result = accountLane(
      [first, structuredClone(first), event(2, { attemptId: 'same', family: 'jev' })],
      { afterSeq: 0, throughSeq: 2 },
      true,
    )
    expect(result.state).toBe('complete')
    expect(result.llm.attempts).toBe(1)
    expect(result.jev.attempts).toBe(1)
    expect(result.llm.tokens.reasoning.value).toBe(2)
    expect(result.llm.tokens.output.value).toBe(5)
  })

  it('retains partial estimated costs and attested zero buckets without fabricating rates or pricing reasoning twice', () => {
    const partial = accountLane(
      [
        event(1, {
          usage: { inputUncached: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 2 },
          pricing: { currency: 'CNY', perMillion: { inputUncached: 1 }, multiplier: 1 },
        }),
      ],
      { afterSeq: 0, throughSeq: 1 },
      true,
    )
    expect(partial.llm.costs.CNY).toMatchObject({ state: 'partial', value: null, knownSubtotal: 0.00001 })
    expect(partial.llm.unpricedAttempts).toBe(1)
    expect(partial.llm.bucketCosts?.CNY?.inputUncached).toMatchObject({ state: 'complete', value: 0.00001 })
    expect(partial.llm.bucketCosts?.CNY?.output).toMatchObject({ state: 'unknown', value: null, missing: 1 })
    expect(partial.llm.priceMultipliers).toEqual([1])
    const zero = accountLane(
      [
        event(1, {
          usage: { inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          pricing: { currency: 'CNY', perMillion: {}, multiplier: 1 },
        }),
      ],
      { afterSeq: 0, throughSeq: 1 },
      true,
    )
    expect(zero.llm.costs.CNY).toMatchObject({ state: 'complete', value: 0 })
    expect(zero.llm.unpricedAttempts).toBe(0)
  })

  it('keeps missing usage and null multipliers unknown, without replacing them with zero or one', () => {
    const result = accountLane(
      [
        event(1, { stage: 'started', usage: null, pricing: null }),
        event(2, { pricing: { ...quote, multiplier: null } }),
      ],
      { afterSeq: 0, throughSeq: 2 },
      true,
    )
    expect(result.llm.tokens.output).toMatchObject({
      state: 'partial',
      value: null,
      knownSubtotal: 5,
      missing: 1,
    })
    expect(result.llm.costs.USD).toMatchObject({ state: 'unknown', value: null, knownSubtotal: null })
    expect(result.llm.unpricedAttempts).toBe(2)
    const unobserved = accountLane(
      [event(1, { usage: null, pricing: null })],
      { afterSeq: 0, throughSeq: 1 },
      true,
    )
    expect(unobserved.llm.tokens.output).toMatchObject({ state: 'unknown', value: null, knownSubtotal: null })
    expect(unobserved.jev.tokens.output).toMatchObject({ state: 'complete', value: 0, knownSubtotal: 0 })
  })

  it('counts each missing-price request once, separately from an incomplete source prefix', () => {
    const events = [
      event(1),
      event(2, { pricing: null }),
      event(3, { pricing: null }),
      event(4, { pricing: { ...quote, multiplier: null } }),
    ]
    const result = accountLane(events, { afterSeq: 0, throughSeq: 4 }, true)
    expect(result.llm.unpricedAttempts).toBe(3)
    expect(result.llm.bucketCosts?.USD?.output?.missing).toBe(3)
    expect(result.llm.bucketCosts?.USD?.inputUncached?.missing).toBe(3)
    expect(result.llm.priceMultipliers).toEqual([2])
    expect(result.llm.costs.USD).toMatchObject({
      state: 'partial',
      value: null,
      knownSubtotal: 0.0000724,
      missing: 3,
    })
    const incomplete = accountLane(events, { afterSeq: 0, throughSeq: 4 }, false)
    expect(incomplete.llm.costs.USD?.missing).toBe(4)
    expect(incomplete.llm.unpricedAttempts).toBe(3)
    const separate = accountLane(
      [event(1), event(2, { pricing: { ...quote, currency: 'CNY', multiplier: null } })],
      { afterSeq: 0, throughSeq: 2 },
      true,
    )
    expect(separate.llm.costs.USD?.state).toBe('complete')
    expect(separate.llm.costs.USD?.missing).toBe(0)
    expect(separate.llm.costs.CNY?.missing).toBe(1)
  })

  it.each(['sequence', 'settlement', 'usage', 'overflow', 'incomplete'] as const)(
    'preserves %s uncertainty',
    (kind) => {
      const events =
        kind === 'sequence'
          ? [event(1), event(1, { usage: { ...usage, output: 6 } })]
          : kind === 'settlement'
            ? [event(1), event(2, { originSeq: 1, attemptId: 'request-1', usage: { ...usage, output: 6 } })]
            : kind === 'usage'
              ? [event(1, { usage: { ...usage, total: 999 } })]
              : kind === 'overflow'
                ? [
                    event(1, { usage: { output: Number.MAX_SAFE_INTEGER } }),
                    event(2, { usage: { output: 1 } }),
                  ]
                : [event(1)]
      const result = accountLane(events, { afterSeq: 0, throughSeq: 2 }, kind !== 'incomplete')
      expect(result.state).not.toBe('complete')
      expect(result.llm.tokens.output.value).toBeNull()
    },
  )

  it('retains separate currencies without making a fictitious combined cost', () => {
    const result = accountLane(
      [event(1), event(2, { pricing: { ...quote, currency: 'CNY' } })],
      { afterSeq: 0, throughSeq: 2 },
      true,
    )
    expect(Object.keys(result.llm.costs)).toEqual(['USD', 'CNY'])
    expect(result.llm.costs.USD?.value).toBeCloseTo(0.0000724)
    expect(result.llm.costs.CNY?.value).toBeCloseTo(0.0000724)
    expect(result.totalCosts).toEqual(result.llm.costs)
  })

  it('prices total Jev input once and combines only same-currency measured families', () => {
    const jevPricing: Pricing = {
      currency: 'USD',
      inputBasis: 'inputTotal',
      multiplier: 1,
      perMillion: { inputUncached: 0.042, cacheRead: 0.042, cacheWrite: 0.042, output: 0 },
    }
    const jev = event(2, {
      family: 'jev',
      usage: { inputTotal: 100, output: 5 },
      pricing: jevPricing,
      priceBasis: 'current',
    })
    const result = accountLane([event(1), jev], { afterSeq: 0, throughSeq: 2 }, true)
    expect(result.jev.costs.USD?.value).toBeCloseTo(0.0000042, 12)
    expect(result.jev.bucketCosts?.USD).toMatchObject({
      inputTotal: { state: 'complete', missing: 0 },
      output: { state: 'complete', value: 0, knownSubtotal: 0, missing: 0 },
    })
    expect(result.jev.bucketCosts?.USD?.inputTotal?.value).toBeCloseTo(0.0000042, 12)
    expect(result.jev.bucketCosts?.USD?.cacheRead).toBeUndefined()
    expect(result.jev.tokens.cacheRead.value).toBeNull()
    expect(result.jev.tokens.inputUncached.value).toBeNull()
    expect(result.jev.currentPriceAttempts).toBe(1)
    expect(result.jev.priceMultipliers).toEqual([1])
    expect(result.llm.priceMultipliers).toEqual([2])
    expect(result.totalCosts?.USD).toMatchObject({ state: 'complete', missing: 0 })
    expect(result.totalCosts?.USD?.value).toBeCloseTo(0.0000766, 12)
    const missing = accountLane([event(1), { ...jev, pricing: null }], { afterSeq: 0, throughSeq: 2 }, true)
    expect(missing.totalCosts?.USD).toMatchObject({ state: 'partial', value: null, missing: 1 })
    expect(missing.totalCosts?.USD?.knownSubtotal).toBeCloseTo(0.0000724, 12)
    expect(missing.jev.priceMultipliers).toEqual([])
    const mixed = accountLane(
      [
        event(1),
        {
          ...jev,
          pricing: { ...jevPricing, currency: 'CNY' },
        },
      ],
      { afterSeq: 0, throughSeq: 2 },
      true,
    )
    expect(mixed.totalCosts?.USD?.value).toBeCloseTo(0.0000724, 12)
    expect(mixed.totalCosts?.CNY?.value).toBeCloseTo(0.0000042, 12)
    const incomplete = accountLane([event(1), jev], { afterSeq: 0, throughSeq: 2 }, false)
    expect(incomplete.totalCosts?.USD?.value).toBeNull()
    const empty = accountLane([], { afterSeq: 0, throughSeq: 0 }, true)
    expect(empty.totalCosts).toEqual({})
    expect(empty.llm.priceMultipliers).toEqual([])
  })

  it('keeps actual peak/off-peak multipliers sorted and does not invent one across a price transition', () => {
    const base = {
      version: 1,
      basis: 'configured',
      route: 'route',
      model: 'model',
      policy: {
        currency: 'USD',
        unit: 'per-million-tokens',
        perMillion: quote.perMillion,
        offPeak: {
          multiplier: 0.5,
          utcOffsetMinutes: 0,
          peakWeekdays: [4],
          peakWindows: [{ startMinute: 540, endMinute: 720 }],
          excludedDates: [],
        },
      },
    }
    const prices = [
      ['2026-10-08T08:00:00Z', '2026-10-08T08:30:00Z'],
      ['2026-10-08T09:00:00Z', '2026-10-08T09:30:00Z'],
      ['2026-10-08T08:00:00Z', '2026-10-08T13:00:00Z'],
    ].map(([start, end]) =>
      pricingFromModelQuote(
        { ...base, admittedAt: Date.parse(start ?? '') },
        { route: 'route', model: 'model' },
        Date.parse(end ?? ''),
      ),
    )
    const result = accountLane(
      prices.map((pricing, index) => event(index + 1, { pricing })),
      { afterSeq: 0, throughSeq: 3 },
      true,
    )
    expect(result.llm.priceMultipliers).toEqual([0.5, 1])
    expect(result.llm.unpricedAttempts).toBe(1)
    expect(result.llm.bucketCosts?.USD?.output?.missing).toBe(1)
    expect(result.llm.bucketCosts?.USD?.output?.knownSubtotal).toBeCloseTo(0.00003, 12)
    expect(result.totalCosts?.USD?.value).toBeNull()
    expect(result.totalCosts?.USD?.knownSubtotal).toBeCloseTo(0.0000543, 12)
  })
})
