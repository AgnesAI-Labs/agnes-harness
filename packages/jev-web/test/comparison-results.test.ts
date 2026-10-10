/** @vitest-environment happy-dom */
import type {
  ComparisonAccountingFamily,
  ComparisonAccountingLane,
  ComparisonAccountingTotal,
  ComparisonMetricsResult,
} from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createComparisonMetrics } from '../src/comparison-metrics.js'
import { createJevTranslate } from '../src/jev-locale.js'

const t = createJevTranslate('zh-CN')

type Summary = NonNullable<ComparisonMetricsResult['summary']>
type SummaryLane = Summary['lanes'][number]

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing expected capture evidence')
  return value
}

function total(
  state: ComparisonAccountingTotal['state'],
  value: number | null,
  knownSubtotal: number | null = value,
  missing = state === 'complete' ? 0 : 1,
): ComparisonAccountingTotal {
  return { state, value, knownSubtotal, missing }
}

function family(
  attempts: number,
  tokens: Partial<ComparisonAccountingFamily['tokens']> = {},
  extra: Partial<ComparisonAccountingFamily> = {},
): ComparisonAccountingFamily {
  const zero = attempts === 0 ? total('complete', 0) : total('unknown', null)
  return {
    attempts,
    tokens: {
      inputUncached: zero,
      cacheRead: zero,
      cacheWrite: zero,
      output: zero,
      reasoning: zero,
      inputTotal: zero,
      total: zero,
      ...tokens,
    },
    costs: {},
    unpricedAttempts: 0,
    ...extra,
  }
}

function accounting(
  state: ComparisonAccountingLane['state'],
  llm: ComparisonAccountingFamily,
  jev: ComparisonAccountingFamily,
  issues: string[] = [],
): ComparisonAccountingLane {
  return { afterSeq: 0, throughSeq: 12, state, llm, jev, issues }
}

function summaryLane(side: SummaryLane['side'], extra: Partial<SummaryLane> = {}): SummaryLane {
  return {
    side,
    phase: 'running',
    run: 'running',
    terminalCause: 'unknown',
    acceptance: 'accepted',
    elapsedMs: null,
    latestAnswer: null,
    complete: false,
    issues: [],
    ...extra,
  }
}

function metrics(
  value: Partial<ComparisonMetricsResult> & Pick<ComparisonMetricsResult, 'lanes'>,
): ComparisonMetricsResult {
  return { id: 'pair', atSeq: 40, cuts: { left: 12, right: 12 }, ...value }
}

function cell(host: HTMLElement, metric: string, side: 'left' | 'right'): HTMLElement {
  return required(host.querySelector(`[data-result-metric="${metric}"] [data-side="${side}"]`))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('keeps the compact two-column results above collapsed detailed metrics', () => {
  const host = document.createElement('div')
  const view = createComparisonMetrics(host, undefined, t)
  expect(host.firstElementChild?.className).toBe('comparison-results')
  expect(host.querySelector('.comparison-metrics')).toBe(host.lastElementChild)
  expect(host.querySelector<HTMLDetailsElement>('.comparison-metrics')?.open).toBe(false)
  expect(cell(host, 'elapsed', 'left').textContent).toBe('未知')
  view.render(
    metrics({
      lanes: [
        {
          side: 'left',
          sessionId: 'l',
          runtime: { id: 'jevloop', version: '1' },
          accounting: accounting('complete', family(0), family(0)),
        },
      ],
    }),
  )
  expect(
    host
      .querySelector('.comparison-results')
      ?.compareDocumentPosition(required(host.querySelector('.comparison-metrics'))),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(host.querySelector<HTMLDetailsElement>('.comparison-metrics')?.open).toBe(false)
  view.reset()
})

it('labels live known values as lower bounds and withholds N/A until the prefix is settled', () => {
  const now = vi.spyOn(Date, 'now')
  const host = document.createElement('div')
  const view = createComparisonMetrics(host, undefined, t)
  view.render(
    metrics({
      atSeq: 18,
      summary: {
        coordinatorSeq: 18,
        roundCount: 1,
        inputId: 'live-round',
        lanes: [
          summaryLane('left', {
            phase: 'running',
            run: 'running',
            elapsedMs: 1500,
            complete: true,
            latestAnswer: { seq: 9, text: 'left live draft', truncated: true },
          }),
          summaryLane('right', {
            phase: 'running',
            run: 'running',
            elapsedMs: null,
            complete: true,
          }),
        ],
      },
      lanes: [
        {
          side: 'left',
          sessionId: 'l',
          runtime: { id: 'jevloop', version: '1' },
          accounting: accounting(
            'partial',
            family(
              2,
              {
                inputUncached: total('complete', 100),
                cacheRead: total('complete', 20),
                cacheWrite: total('complete', 0),
                output: total('complete', 50),
                reasoning: total('complete', 10),
                inputTotal: total('complete', 120),
              },
              {
                costs: { USD: total('complete', 0.12) },
                bucketCosts: {
                  USD: {
                    inputUncached: total('complete', 0.09),
                    cacheRead: total('complete', 0.005),
                    output: total('complete', 0.025),
                  },
                },
                priceMultipliers: [0.1],
                byPurpose: {
                  answer: {
                    attempts: 1,
                    outcomes: { completed: 0, failed: 0, cancelled: 0, pending: 1, unknown: 0 },
                  },
                  compaction: {
                    attempts: 1,
                    outcomes: { completed: 1, failed: 0, cancelled: 0, pending: 0, unknown: 0 },
                  },
                },
              },
            ),
            family(0),
          ),
        },
        {
          side: 'right',
          sessionId: 'r',
          runtime: { id: 'native', version: '1' },
          accounting: accounting('complete', family(0), family(0)),
        },
      ],
    }),
  )
  expect(cell(host, 'status', 'left').textContent).toContain('运行中')
  expect(cell(host, 'elapsed', 'left').textContent).toBe('1.5 秒（已确认累计）')
  expect(cell(host, 'elapsed', 'right').textContent).toBe('未知')
  expect(cell(host, 'answer', 'right').textContent).toBe('未知')
  expect(now).not.toHaveBeenCalled()
  expect(cell(host, 'llm-uncached', 'left').textContent).toBe('100（已知下限） · USD 0.090000（已知下限）')
  expect(cell(host, 'llm-cache', 'left').textContent).toContain('20（已知下限）')
  expect(cell(host, 'llm-cache', 'left').textContent).toContain('命中率 16.7%（当前已知请求）')
  expect(cell(host, 'llm-output', 'left').textContent).toContain('50（已知下限）')
  expect(cell(host, 'llm-output', 'left').textContent).toContain('USD 0.025000（已知下限）')
  expect(cell(host, 'llm-cost', 'left').textContent).toContain('USD 0.120000（已知下限） · 谷段 ×0.1')
  expect(cell(host, 'jev-input', 'left').textContent).toBe('未知')
  expect(cell(host, 'jev-output', 'left').textContent).toBe('未知')
  expect(cell(host, 'calls', 'left').textContent).toBe('LLM 2 次 / Jev 0 次（部分可用）')
  expect(cell(host, 'mix', 'left').textContent).toContain('回答 1')
  expect(cell(host, 'mix', 'left').textContent).toContain('压缩摘要 1')
  expect(cell(host, 'answer', 'left').textContent).toContain('left live draft')
  expect(cell(host, 'answer', 'left').textContent).toContain('已截断')
  expect(cell(host, 'llm-uncached', 'right').textContent).toBe('未知')
  expect(cell(host, 'calls', 'right').textContent).toBe('未知')
  expect(host.textContent).not.toContain('胜')
  expect(host.textContent).not.toContain('更好')
  view.reset()
})

it('keeps mixed-currency estimates separate and never treats missing or partial as zero', () => {
  const host = document.createElement('div')
  const view = createComparisonMetrics(host, undefined, t)
  view.render(
    metrics({
      atSeq: 80,
      summary: {
        coordinatorSeq: 80,
        roundCount: 2,
        inputId: 'priced',
        lanes: [
          summaryLane('left', {
            phase: 'completed',
            run: 'settled',
            terminalCause: 'finished',
            elapsedMs: 4000,
            complete: true,
            latestAnswer: { seq: 20, text: 'settled left', truncated: false },
          }),
          summaryLane('right', {
            phase: 'completed',
            run: 'settled',
            terminalCause: 'finished',
            elapsedMs: 4100,
            complete: true,
            latestAnswer: { seq: 21, text: 'settled right', truncated: false },
          }),
        ],
      },
      lanes: [
        {
          side: 'left',
          sessionId: 'l',
          runtime: { id: 'jevloop', version: '1' },
          accounting: accounting(
            'partial',
            family(
              2,
              { output: total('partial', null, 1206, 1), inputUncached: total('complete', 40) },
              { costs: { EUR: total('partial', null, 2, 1), USD: total('unknown', null, null, 1) } },
            ),
            family(
              1,
              { inputTotal: total('complete', 11), output: total('complete', 3) },
              {
                costs: { CNY: total('complete', 0.4) },
                currentPriceAttempts: 1,
                byPurpose: {
                  decision: {
                    attempts: 1,
                    outcomes: { completed: 1, failed: 0, cancelled: 0, pending: 0, unknown: 0 },
                  },
                },
              },
            ),
          ),
        },
      ],
    }),
  )
  expect(cell(host, 'llm-output', 'left').textContent).toContain('已知小计 1206')
  expect(cell(host, 'llm-cost', 'left').textContent).toContain('EUR 已知小计 2')
  expect(cell(host, 'llm-cost', 'left').textContent).toContain('USD 未知')
  expect(cell(host, 'llm-cost', 'left').textContent).not.toContain('USD 0')
  expect(cell(host, 'jev-cost', 'left').textContent).toContain('CNY 0.400000（含 1 次按当前配置重估）')
  expect(cell(host, 'jev-output', 'left').textContent).toBe('3')
  expect(cell(host, 'cost', 'left').textContent).toBe('未知（无合计费用证据）')
  expect(cell(host, 'jev-input', 'left').textContent).toBe('11')
  expect(cell(host, 'mix', 'left').textContent).not.toContain('决策')
  view.reset()
})

it('treats a legacy payload without summary as unknown and uses N/A only for settled empty families', () => {
  const host = document.createElement('div')
  const view = createComparisonMetrics(host, undefined, t)
  view.render(
    metrics({
      atSeq: 4,
      lanes: [
        {
          side: 'left',
          sessionId: 'l',
          runtime: { id: 'jevloop', version: '1' },
          accounting: accounting('complete', family(0), family(0)),
        },
        {
          side: 'right',
          sessionId: 'r',
          runtime: { id: 'native', version: '1' },
          accounting: accounting(
            'complete',
            family(1, {
              inputUncached: total('complete', 0),
              cacheRead: total('complete', 0),
              cacheWrite: total('complete', 0),
              output: total('complete', 0),
              inputTotal: total('complete', 0),
            }),
            family(0),
          ),
        },
      ],
    }),
  )
  expect(host.querySelector('.comparison-results-status')?.textContent).toContain('摘要未知')
  expect(cell(host, 'status', 'left').textContent).toBe('未知')
  expect(cell(host, 'elapsed', 'left').textContent).toBe('未知')
  expect(cell(host, 'answer', 'left').textContent).toBe('未知')
  expect(cell(host, 'llm-uncached', 'left').textContent).toBe('未知')
  expect(cell(host, 'jev-input', 'left').textContent).toBe('未知')
  expect(cell(host, 'calls', 'left').textContent).toBe('未知')
  expect(cell(host, 'llm-uncached', 'right').textContent).toBe('未知（尚无确认终态）')
  expect(cell(host, 'jev-output', 'right').textContent).toBe('未知')
  expect(cell(host, 'mix', 'left').textContent).toBe('未知')
  view.reset()
})

it('retains the previous complete summary while a later cut is loading, then drops stale answers', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const host = document.createElement('div')
  const view = createComparisonMetrics(host, undefined, t)
  const first = metrics({
    atSeq: 40,
    summary: {
      coordinatorSeq: 40,
      roundCount: 1,
      inputId: 'round-a',
      lanes: [
        summaryLane('left', {
          phase: 'completed',
          run: 'settled',
          terminalCause: 'finished',
          elapsedMs: 2000,
          complete: true,
          latestAnswer: { seq: 8, text: 'answer A', truncated: false },
        }),
      ],
    },
    lanes: [
      {
        side: 'left',
        sessionId: 'l',
        runtime: { id: 'jevloop', version: '1' },
        accounting: accounting('complete', family(1, { output: total('complete', 9) }), family(0)),
      },
    ],
  })
  view.render(first)
  expect(host.querySelector('.comparison-results')?.getAttribute('data-at-seq')).toBe('40')
  expect(host.querySelector('.comparison-results')?.getAttribute('data-input-id')).toBe('round-a')
  required(host.querySelector<HTMLButtonElement>('button[data-copy-answer="left"]')).click()
  await Promise.resolve()
  expect(writeText).toHaveBeenCalledWith('answer A')
  view.loading(41)
  expect(host.querySelector('.comparison-results')?.getAttribute('data-state')).toBe('updating')
  expect(host.querySelector('.comparison-results')?.getAttribute('data-at-seq')).toBe('40')
  expect(host.querySelector('.comparison-results-status')?.textContent).toContain('仍显示 #40 的结果')
  expect(cell(host, 'answer', 'left').textContent).toContain('answer A')
  expect(cell(host, 'elapsed', 'left').textContent).toBe('2.0 秒')
  view.unavailable('计量读取失败')
  expect(host.querySelector('.comparison-results')?.getAttribute('data-state')).toBe('unavailable')
  expect(cell(host, 'answer', 'left').textContent).toContain('answer A')
  view.render({
    ...first,
    atSeq: 41,
    summary: {
      coordinatorSeq: 41,
      roundCount: 2,
      inputId: 'round-b',
      lanes: [
        summaryLane('left', {
          phase: 'running',
          run: 'running',
          elapsedMs: 0,
          complete: false,
          latestAnswer: { seq: 15, text: 'answer B', truncated: false },
        }),
      ],
    },
  })
  expect(host.querySelector('.comparison-results')?.getAttribute('data-at-seq')).toBe('41')
  expect(host.querySelector('.comparison-results')?.getAttribute('data-input-id')).toBe('round-b')
  expect(cell(host, 'answer', 'left').textContent).toContain('answer B')
  expect(cell(host, 'answer', 'left').textContent).not.toContain('answer A')
  expect(cell(host, 'answer', 'left').getAttribute('data-answer-seq')).toBe('15')
  view.render({
    id: first.id,
    atSeq: 42,
    cuts: first.cuts,
    lanes: first.lanes,
  })
  expect(cell(host, 'answer', 'left').textContent).toBe('未知')
  expect(cell(host, 'answer', 'left').textContent).not.toContain('answer B')
  expect(host.querySelector('button[data-copy-answer]')).toBeNull()
  view.reset()
})

it('aligns DSH bucket, family and total rows without charging Jev output or changing durable sides', () => {
  const host = document.createElement('div')
  const view = createComparisonMetrics(host, undefined, t)
  const llm = family(
    2,
    {
      inputUncached: total('complete', 1000),
      cacheRead: total('complete', 2000),
      inputTotal: total('complete', 3000),
      output: total('complete', 100),
    },
    {
      costs: { USD: total('complete', 0.00021) },
      bucketCosts: {
        USD: {
          inputUncached: total('complete', 0.00015),
          cacheRead: total('complete', 0.00003),
          output: total('complete', 0.00003),
        },
      },
      priceMultipliers: [0.1, 1],
      byPurpose: {
        parameters: {
          attempts: 1,
          outcomes: { completed: 1, failed: 0, cancelled: 0, unknown: 0, pending: 0 },
        },
        answer: { attempts: 1, outcomes: { completed: 1, failed: 0, cancelled: 0, unknown: 0, pending: 0 } },
      },
    },
  )
  const jev = family(
    1,
    { inputTotal: total('complete', 10000), output: total('complete', 1000) },
    {
      costs: { USD: total('complete', 0.00042) },
      bucketCosts: { USD: { inputTotal: total('complete', 0.00042), output: total('complete', 0) } },
      priceMultipliers: [1],
      currentPriceAttempts: 1,
      byPurpose: {
        decision: {
          attempts: 1,
          outcomes: { completed: 1, failed: 0, cancelled: 0, unknown: 0, pending: 0 },
        },
      },
    },
  )
  const value = metrics({
    lanes: [
      {
        side: 'left',
        sessionId: 'n',
        runtime: { id: 'native', version: '1' },
        accounting: accounting('complete', family(0), family(0)),
      },
      {
        side: 'right',
        sessionId: 'j',
        runtime: { id: 'jevloop', version: '1' },
        accounting: { ...accounting('partial', llm, jev), totalCosts: { USD: total('complete', 0.00063) } },
      },
    ],
    summary: {
      coordinatorSeq: 40,
      roundCount: 1,
      inputId: 'finished',
      lanes: ['left', 'right'].map((side) =>
        summaryLane(side as 'left' | 'right', {
          run: 'settled',
          phase: 'completed',
          complete: true,
          terminalCause: 'finished',
        }),
      ),
    },
  })
  view.render(value)
  expect([...host.querySelectorAll('thead [data-side]')].map((n) => (n as HTMLElement).dataset.side)).toEqual(
    ['right', 'left'],
  )
  expect(
    [...host.querySelectorAll('[data-result-metric]')].map((n) => (n as HTMLElement).dataset.resultMetric),
  ).toEqual([
    'status',
    'elapsed',
    'llm-uncached',
    'llm-cache',
    'llm-output',
    'llm-cost',
    'jev-input',
    'jev-output',
    'jev-cost',
    'cost',
    'calls',
    'mix',
    'answer',
  ])
  expect(cell(host, 'llm-uncached', 'right').textContent).toBe('1000 · USD 0.000150')
  expect(cell(host, 'llm-cache', 'right').textContent).toBe('2000 · 命中率 66.7% · USD 0.000030')
  expect(cell(host, 'llm-output', 'right').textContent).toBe('100 · USD 0.000030')
  expect(cell(host, 'llm-cost', 'right').textContent).toBe('USD 0.000210 · 峰谷混合')
  expect(cell(host, 'jev-input', 'right').textContent).toBe('10000 · USD 0.000420')
  expect(cell(host, 'jev-output', 'right').textContent).toBe('1000')
  expect(cell(host, 'jev-cost', 'right').textContent).toBe('USD 0.000420（含 1 次按当前配置重估）')
  expect(cell(host, 'cost', 'right').textContent).toBe('USD 0.000630（含 1 次按当前配置重估）')
  expect(cell(host, 'mix', 'right').textContent).toBe('参数生成 1 · 回答 1')
  expect(cell(host, 'jev-cost', 'left').textContent).toBe('不适用')
  const modified = structuredClone(value)
  const lane = required(modified.lanes[1])
  lane.accounting.totalCosts = { USD: total('partial', null, 0.0006, 1), EUR: total('complete', 0.01) }
  lane.accounting.llm.tokens.cacheRead = total('partial', null, 1000, 1)
  view.render(modified)
  expect(cell(host, 'cost', 'right').textContent).toContain(
    'USD 已知小计 0.000600（非总量，缺失 1） / EUR 0.010000',
  )
  expect(cell(host, 'llm-cache', 'right').textContent).toContain('命中率未知')
  view.reset()
})
