import { performance } from 'node:perf_hooks'
import type { UITurnCall, UITurnUsage } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { TurnProjection } from '../src/project/turns.js'
import type { Event } from '../src/types.js'
import { toolHeavyLedger } from '../testkit/tool-heavy-ledger.js'

const emptyTotals = (): UITurnUsage['totals'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
})

// The per-turn summary as it was computed before it was kept as running sums: every call re-added
// and re-copied on every cost row. Kept as the reference the running sums must match.
const referenceAggregate = (calls: readonly UITurnCall[]): UITurnUsage => {
  const totals = emptyTotals()
  const original = calls.filter((call) => call.adjustment === undefined)
  let credits = 0
  let usdMicros = 0
  let hasCredits = false
  let hasBilling = false
  let creditsComplete = original.length > 0
  let billingComplete = original.length > 0
  let creditsGateway = true
  let billingGateway = true
  let subscription = true
  let reasoningComplete = original.length > 0
  for (const call of calls) {
    if (call.adjustment) {
      credits += call.adjustment.delta
      usdMicros += call.adjustment.usdMicrosDelta ?? 0
      continue
    }
    const tokens = call.tokens
    if (tokens) {
      totals.input += tokens.input
      totals.output += tokens.output
      totals.cacheRead += tokens.cacheRead
      totals.cacheWrite += tokens.cacheWrite
      totals.reasoning += tokens.reasoning ?? 0
      reasoningComplete &&= tokens.reasoning !== undefined
    } else reasoningComplete = false
    if (call.credits !== undefined) {
      hasCredits = true
      credits += call.credits
      creditsGateway &&= call.creditSource === 'gateway'
    } else creditsComplete = false
    if (call.billing) {
      hasBilling = true
      usdMicros += call.billing.usdMicros
      billingGateway &&= call.billing.source === 'gateway'
      subscription &&= call.billing.subscription
    } else billingComplete = false
  }
  return {
    totals,
    ...(hasCredits
      ? {
          credits: {
            amount: Math.max(0, credits),
            source: creditsGateway && creditsComplete ? ('gateway' as const) : ('estimated' as const),
            complete: creditsComplete,
          },
        }
      : {}),
    ...(hasBilling
      ? {
          cost: {
            usdMicros: Math.max(0, usdMicros),
            source: billingGateway && billingComplete ? ('gateway' as const) : ('estimated' as const),
            subscription,
          },
        }
      : {}),
    reasoningComplete,
    billingComplete: hasBilling && billingComplete,
    calls: calls.map((call) => structuredClone(call)),
  }
}

const without = ({ calls: _calls, ...rest }: UITurnUsage) => rest

function seeded(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 48_271) % 2_147_483_647
    return x / 2_147_483_647
  }
}

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
let seq = 0
const row = (type: string, data: unknown): Event =>
  ({
    seq: ++seq,
    ts: '2025-09-07T00:00:00.000Z',
    id: `r${seq}`,
    type,
    lane: 'main',
    v: 1,
    actor,
    origin: 'system',
    trust: 'trusted',
    data,
  }) as Event

/** A random cost row: mostly inference, some adjustments of earlier rows, some fields missing. */
function costRow(random: () => number, n: number, earlier: number[], withTokens: boolean): Event {
  if (earlier.length > 0 && random() < 0.08) {
    const of = earlier[Math.floor(random() * earlier.length)] as number
    return row('cost/ledger', {
      purpose: 'inference',
      effectId: `adj-${n}`,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'gateway',
      model: 'm',
      adjustment: {
        of,
        delta: Math.round(random() * 6) - 3,
        ...(random() < 0.5 ? { usdMicrosDelta: 2 } : {}),
      },
    })
  }
  return row('cost/ledger', {
    purpose: 'inference',
    effectId: `e-${n}`,
    ...(withTokens || random() < 0.95
      ? {
          tokens: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            ...(random() < 0.9 ? { reasoning: 3 } : {}),
          },
        }
      : {}),
    ...(random() < 0.9 ? { credits: 1 } : {}),
    creditSource: random() < 0.9 ? 'gateway' : 'estimated',
    model: 'm',
    ...(random() < 0.8
      ? {
          billing: {
            usdMicros: 7,
            source: random() < 0.9 ? 'gateway' : 'estimated',
            subscription: random() < 0.95,
          },
        }
      : {}),
  })
}

describe('the per-turn usage summary', () => {
  it('matches re-adding every call after each cost row, repeated rows counted once', {
    timeout: 60_000,
  }, () => {
    const random = seeded(3)
    const turns = new TurnProjection()
    turns.apply(row('turn/start', { turn: 1, trigger: 'prompt' }))
    const sent: Event[] = []
    const costSeqs: number[] = []
    for (let n = 0; n < 1500; n++) {
      // A tenth of the rows repeat one already sent; the summary must not count them twice.
      const next =
        sent.length > 0 && random() < 0.1
          ? ({ ...(sent[Math.floor(random() * sent.length)] as Event), seq: ++seq } as Event)
          : costRow(random, n, costSeqs, false)
      turns.apply(next)
      sent.push(next)
      costSeqs.push(next.seq)
      const usage = turns.turns[0]?.usage as UITurnUsage
      expect(without(usage), `row ${n}`).toEqual(without(referenceAggregate(usage.calls)))
      expect(new Set(usage.calls.map((call) => call.id)).size).toBe(usage.calls.length)
    }
  })

  it('matches on a turn with no calls', () => {
    const empty = new TurnProjection()
    empty.apply(row('turn/start', { turn: 1, trigger: 'prompt' }))
    expect(empty.turns[0]?.usage).toEqual(referenceAggregate([]))
  })

  it('applies a single turn of 4k calls in a bounded time', { timeout: 120_000 }, () => {
    const turns = new TurnProjection()
    const start = performance.now()
    for (const row of toolHeavyLedger({ calls: 4000, perTurn: 1_000_000 })) {
      turns.apply(row)
      if (performance.now() - start > 2_000) break
    }
    // Alone this takes about 0.1 s; re-adding the turn on every row took over 12 s.
    expect(performance.now() - start).toBeLessThan(1_000)
  })
})
