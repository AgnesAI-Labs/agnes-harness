import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { contextTokensAtCut, projectUsage } from '../src/project/usage.js'
import type { Event } from '../src/types.js'

const model: ModelRecord = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro',
  api: 'openai-completions',
  route: 'agnes-api',
  baseUrl: 'https://api.agnes-ai.cn/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}

const row = (seq: number, data: Record<string, unknown>, lane = 'main'): Event =>
  ({
    seq,
    ts: '2026-09-11T00:00:00.000Z',
    id: `01K000000000000000000000${String(seq).padStart(2, '0')}`,
    type: 'cost/ledger',
    data,
    actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
    lane,
    v: 1,
  }) as Event

const cost = (
  effectId: string,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number },
  extra: Record<string, unknown> = {},
) => ({
  purpose: 'inference',
  effectId,
  tokens: { cacheRead: 0, cacheWrite: 0, ...tokens },
  creditSource: 'gateway',
  model: model.id,
  ...extra,
})

const input = (events: Event[], overrides: Partial<Parameters<typeof projectUsage>[0]> = {}) => ({
  events,
  upto: 99,
  lane: 'main',
  route: 'agnes-api',
  model,
  thinking: 'high' as const,
  contextTokens: 2_000,
  autoCompact: true,
  ...overrides,
})

describe('projectUsage', () => {
  it('counts guardian cost without replacing the inference context anchor', () => {
    const inference = row(1, cost('inference-1', { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 }))
    const guardian = row(
      2,
      cost('guardian-1', { input: 1024, output: 0 }, { purpose: 'approval-guardian', credits: 0.5 }),
    )
    expect(contextTokensAtCut([inference, guardian], 'main', 2)).toBe(19)
    expect(projectUsage(input([inference, guardian]))).toMatchObject({
      totals: { input: 1034, output: 2, cacheRead: 3, cacheWrite: 4 },
      credits: { amount: 0.5 },
    })
  })

  it('counts auxiliary media cost without replacing the primary inference context anchor', () => {
    const inference = row(1, cost('inference-1', { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 }))
    const media = row(2, cost('media-1', { input: 2048, output: 64 }, { purpose: 'media', credits: 0.75 }))
    expect(contextTokensAtCut([inference, media], 'main', 2)).toBe(19)
    expect(projectUsage(input([inference, media]))).toMatchObject({
      totals: { input: 2058, output: 66, cacheRead: 3, cacheWrite: 4 },
      credits: { amount: 0.75 },
    })
  })

  it('starts child billing at the global fork boundary and ignores late parent adjustments', () => {
    const parent = row(
      1,
      cost(
        'parent',
        { input: 10, output: 2 },
        {
          credits: 4,
          billing: { usdMicros: 100, source: 'gateway', subscription: true },
        },
      ),
      'side',
    )
    const { lane: _parentLane, ...startBase } = row(2, {})
    const start: Event = {
      ...startBase,
      type: 'session/start',
      data: { parent: { sessionKey: 'parent', boundarySeq: 1 } },
    }
    const adjustment = row(
      3,
      cost(
        'parent-adjustment',
        { input: 0, output: 0 },
        {
          adjustment: { of: 1, delta: -2, usdMicrosDelta: -50, reason: 'reconciled' },
        },
      ),
    )
    const child = row(
      4,
      cost(
        'child',
        { input: 3, output: 1 },
        {
          credits: 1,
          billing: { usdMicros: 25, source: 'gateway', subscription: true },
        },
      ),
    )

    expect(projectUsage(input([parent, start, adjustment, child]))).toMatchObject({
      totals: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      credits: { amount: 1, source: 'gateway', complete: true },
      cost: { usdMicros: 25, source: 'gateway', subscription: true },
    })
  })

  it('counts ordinary and interrupted rows at the lane/cut while retaining known partial cost', () => {
    const events = [
      row(
        1,
        cost(
          'e1',
          { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1 },
          {
            billing: { usdMicros: 100, source: 'gateway', subscription: true },
          },
        ),
      ),
      row(
        2,
        cost(
          'e2',
          { input: 5, output: 1 },
          {
            interrupted: true,
            billing: { usdMicros: 50, source: 'gateway', subscription: true },
          },
        ),
      ),
      row(3, cost('other', { input: 999, output: 999 }), 'side'),
      row(4, cost('e3', { input: 2, output: 3 })),
      row(
        5,
        cost(
          'late',
          { input: 100, output: 100 },
          {
            billing: { usdMicros: 900, source: 'gateway', subscription: true },
          },
        ),
      ),
    ]
    expect(projectUsage(input(events, { upto: 4 }))).toEqual({
      reasoningComplete: false,
      billingComplete: false,
      totals: { input: 17, output: 6, cacheRead: 3, cacheWrite: 4, reasoning: 1 },
      cost: { usdMicros: 150, source: 'estimated', subscription: true },
      context: { source: 'estimated', tokens: 2_000, window: 1_000_000, autoCompact: true },
      model: { route: 'agnes-api', id: 'deepseek-v4-pro', thinking: 'high', maxTokens: 8192 },
      cache: { hitRate: 3 / 19 },
    })
  })

  it('reports cumulative cache hit rate alongside totals', () => {
    const events = [
      row(1, cost('e1', { input: 500, output: 10, cacheRead: 9000, cacheWrite: 0 })),
      row(2, cost('e2', { input: 9500, output: 10, cacheRead: 0, cacheWrite: 0 })),
    ]
    const view = projectUsage(input(events))
    // (9000 + 0) read out of (500+9000+0) + (9500+0+0) = 9500 + 9500 = 19000 total prompt tokens.
    expect(view.cache?.hitRate).toBeCloseTo(9000 / 19000)
  })

  it('deduplicates effects and applies signed billing adjustments without recounting tokens', () => {
    const events = [
      row(
        1,
        cost(
          'e1',
          { input: 10, output: 2 },
          {
            billing: { usdMicros: 100, source: 'estimated', subscription: false },
          },
        ),
      ),
      row(
        2,
        cost(
          'e1',
          { input: 10, output: 2 },
          {
            billing: { usdMicros: 100, source: 'estimated', subscription: false },
          },
        ),
      ),
      row(
        3,
        cost(
          'adjust-e1',
          { input: 500, output: 500 },
          {
            adjustment: { of: 1, delta: -0.5, usdMicrosDelta: -25, reason: 'reconciled' },
          },
        ),
      ),
    ]
    expect(projectUsage(input(events))).toMatchObject({
      totals: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usdMicros: 75, source: 'estimated', subscription: false },
    })
  })

  it('omits dollars when no row has billing instead of inventing zero from credits', () => {
    const view = projectUsage(
      input([row(1, cost('e1', { input: 1, output: 1 }, { credits: 99 }))], {
        contextTokens: 0,
        autoCompact: false,
      }),
    )
    expect(view.cost).toBeUndefined()
    expect(view.context).toEqual({ source: 'estimated', tokens: 0, window: 1_000_000, autoCompact: false })
  })

  it('projects an empty session and changes route/model/thinking only from explicit effective input', () => {
    expect(projectUsage(input([]))).toMatchObject({
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      model: { route: 'agnes-api', id: 'deepseek-v4-pro', thinking: 'high', maxTokens: 8192 },
    })
    const switched = { ...model, id: 'agnes-2.5-flash', contextWindow: 128_000 }
    expect(
      projectUsage(input([], { route: 'agnes-backup', model: switched, thinking: 'low' })),
    ).toMatchObject({
      context: { window: 128_000 },
      model: { route: 'agnes-backup', id: 'agnes-2.5-flash', thinking: 'low' },
    })
  })
})

it('accounts for more than a budget page and keeps absent credits distinct from zero', () => {
  const events = Array.from({ length: 205 }, (_, i) =>
    row(i + 1, cost(`e${i}`, { input: 1, output: 2, reasoning: 0 }, { credits: 1 })),
  )
  events.push(row(206, cost('missing', { input: 1, output: 1 })))
  const result = projectUsage(input(events, { upto: 206 }))
  expect(result.totals).toMatchObject({ input: 206, output: 411 })
  expect(result.credits).toEqual({ amount: 205, complete: false, source: 'estimated' })
  expect(result.reasoningComplete).toBe(false)
  expect(result.cost).toBeUndefined()
})
