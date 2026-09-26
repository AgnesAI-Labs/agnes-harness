import type { UISpan, UITurn, UITurnCall } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { buildTraceRequestMetrics } from '../src/trace-request-metrics.js'

const at = '2026-09-17T00:00:00.000Z'

function call(seq: number, id: string, extra: Partial<UITurnCall> = {}): UITurnCall {
  return { id, seq, purpose: 'inference', model: 'model', creditSource: 'estimated', ...extra }
}

function span(id: string, startSeq: number, extra: Partial<UISpan> = {}): UISpan {
  return {
    id,
    kind: 'generation',
    name: 'model',
    status: 'completed',
    startSeq,
    startedAt: at,
    children: [],
    ...extra,
  }
}

function turn(id: string, number: number, calls: UITurnCall[], children: UISpan[] = []): UITurn {
  return {
    id,
    turn: number,
    startSeq: 1,
    startedAt: at,
    status: 'completed',
    nodeIds: [],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: false,
      billingComplete: false,
      calls,
    },
    inherited: false,
    forkable: true,
    trace: span(`root:${id}`, 1, { kind: 'turn', children }),
  }
}

describe('trace request metrics', () => {
  it('numbers verified starts separately from ledger completion order and accumulates recorded values', () => {
    const laterStart = call(10, 'later', {
      tokens: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, reasoning: 1 },
      timing: { durationMs: 7, ttftMs: 2 },
    })
    const earlierStart = call(20, 'earlier', {
      tokens: { input: 5, output: 6, cacheRead: 0, cacheWrite: 1, reasoning: 2 },
    })
    const turns = [
      turn(
        't1',
        1,
        [earlierStart, laterStart],
        [
          span('earlier', 3, { effectId: 'earlier', callSeq: 20, durationMs: 11, ttftMs: 4 }),
          span('later', 5, { effectId: 'later', callSeq: 10, durationMs: 8 }),
        ],
      ),
    ]
    const original = structuredClone(turns)
    const metrics = buildTraceRequestMetrics(turns, { hasEarlier: false })
    expect(turns).toEqual(original)
    expect(metrics.get(20)).toMatchObject({
      callSeq: 20,
      requestNumber: { state: 'known', value: 1 },
      ledgerNumber: { state: 'known', value: 2 },
      durationMs: { state: 'known', value: 11 },
      durationSource: 'trace',
      ttftMs: { state: 'known', value: 4 },
      ttftSource: 'trace',
      cumulativeCallDurationMs: { state: 'known', value: 18 },
      cumulativeTokens: {
        input: { state: 'known', value: 7 },
        output: { state: 'known', value: 9 },
        cacheRead: { state: 'known', value: 1 },
        cacheWrite: { state: 'known', value: 1 },
        reasoning: { state: 'known', value: 3 },
      },
    })
    expect(metrics.get(10)).toMatchObject({
      requestNumber: { state: 'known', value: 2 },
      ledgerNumber: { state: 'known', value: 1 },
      durationMs: { state: 'known', value: 7 },
      durationSource: 'ledger',
      ttftMs: { state: 'known', value: 2 },
      ttftSource: 'ledger',
      cumulativeCallDurationMs: { state: 'known', value: 7 },
    })
  })

  it('does not number an unmatched request, but retains ledger facts and excludes adjustments', () => {
    const first = turn('t1', 1, [
      call(5, 'a', { tokens: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 } }),
      call(6, 'adjust-a', {
        adjustment: { of: 5, delta: 1, reason: 'billing correction' },
      }),
    ])
    const second = turn(
      't2',
      2,
      [
        call(12, 'b', {
          tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 },
          timing: { durationMs: 9 },
        }),
      ],
      [span('b', 9, { effectId: 'b', callSeq: 12 })],
    )
    const metrics = buildTraceRequestMetrics([second, first], { hasEarlier: false })
    expect(metrics.size).toBe(2)
    expect(metrics.has(6)).toBe(false)
    expect(metrics.get(5)).toMatchObject({
      requestNumber: { state: 'unknown', reason: 'request-order-unverifiable' },
      ledgerNumber: { state: 'known', value: 1 },
      durationMs: { state: 'unknown', reason: 'duration-unreported' },
      ttftMs: { state: 'unknown', reason: 'ttft-unreported' },
      tokens: { reasoning: { state: 'unknown', reason: 'tokens-unreported' } },
    })
    expect(metrics.get(12)).toMatchObject({
      requestNumber: { state: 'unknown', reason: 'request-order-unverifiable' },
      ledgerNumber: { state: 'known', value: 2 },
      cumulativeTokens: {
        input: { state: 'known', value: 7 },
        reasoning: { state: 'unknown', reason: 'tokens-unreported' },
      },
      cumulativeCallDurationMs: { state: 'unknown', reason: 'duration-unreported' },
    })
  })

  it('marks global numbers and cumulative values unknown when an earlier prefix is unloaded', () => {
    const present = call(7, 'present', {
      tokens: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0 },
      timing: { durationMs: 8 },
    })
    const metrics = buildTraceRequestMetrics(
      [turn('t2', 2, [present], [span('present', 4, { effectId: 'present', callSeq: 7 })])],
      { hasEarlier: true },
    )
    expect(metrics.get(7)).toMatchObject({
      requestNumber: { state: 'unknown', reason: 'earlier-history-unloaded' },
      ledgerNumber: { state: 'unknown', reason: 'earlier-history-unloaded' },
      tokens: { input: { state: 'known', value: 4 } },
      durationMs: { state: 'known', value: 8 },
      cumulativeTokens: { input: { state: 'unknown', reason: 'earlier-history-unloaded' } },
      cumulativeCallDurationMs: { state: 'unknown', reason: 'earlier-history-unloaded' },
    })
  })

  it('does not replace missing tokens or a title ledger timestamp with guessed request facts', () => {
    const untimed = call(4, 'missing')
    const title = call(9, 'title', {
      purpose: 'title',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    })
    const metrics = buildTraceRequestMetrics(
      [
        turn(
          't1',
          1,
          [untimed, title],
          [
            span('missing', 2, { effectId: 'missing', callSeq: 4 }),
            span('title', 9, { effectId: 'title', callSeq: 9, kind: 'generation', purpose: 'title' }),
          ],
        ),
      ],
      { hasEarlier: false },
    )
    expect(metrics.get(4)).toMatchObject({
      tokens: { input: { state: 'unknown', reason: 'tokens-unreported' } },
      cumulativeTokens: { input: { state: 'unknown', reason: 'tokens-unreported' } },
      requestNumber: { state: 'unknown', reason: 'request-order-unverifiable' },
    })
    expect(metrics.get(9)).toMatchObject({
      tokens: { input: { state: 'known', value: 1 } },
      cumulativeTokens: { input: { state: 'unknown', reason: 'tokens-unreported' } },
      requestNumber: { state: 'unknown', reason: 'request-order-unverifiable' },
      durationMs: { state: 'unknown', reason: 'duration-unreported' },
    })
  })

  it('rejects a conflicting span identity instead of borrowing its timing', () => {
    const metrics = buildTraceRequestMetrics(
      [
        turn(
          't1',
          1,
          [call(8, 'actual')],
          [span('wrong', 3, { effectId: 'different', callSeq: 8, durationMs: 40, ttftMs: 2 })],
        ),
      ],
      { hasEarlier: false },
    )
    expect(metrics.get(8)).toMatchObject({
      requestNumber: { state: 'unknown', reason: 'request-order-unverifiable' },
      durationMs: { state: 'unknown', reason: 'duration-unreported' },
      ttftMs: { state: 'unknown', reason: 'ttft-unreported' },
      durationSource: 'unknown',
      ttftSource: 'unknown',
    })
  })

  it('does not attribute a duplicated ledger sequence to either call', () => {
    const metrics = buildTraceRequestMetrics([turn('t1', 1, [call(8, 'a'), call(8, 'b')])], {
      hasEarlier: false,
    })
    expect(metrics.size).toBe(0)
  })
})
