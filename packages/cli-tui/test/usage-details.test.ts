import type { UINode, UsageView } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { withoutRefinement } from '../src/refinement-usage.js'
import { formatCallUsage, formatContextBreakdown, formatUsageReport } from '../src/usage-details.js'

const baseUsage: UsageView = {
  totals: { input: 100, output: 20, cacheRead: 90, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: false,
  context: { source: 'estimated', tokens: 1000, window: 1_000_000, autoCompact: true },
  model: { route: 'agnes-api', id: 'deepseek-v4-pro', thinking: 'high' },
}

describe('formatUsageReport cache section', () => {
  it('shows the cumulative hit rate as a percentage', () => {
    const text = formatUsageReport({ ...baseUsage, cache: { hitRate: 0.5 } }, 'zh-CN')
    expect(text).toContain('缓存命中率（累计）：50.0%')
  })

  it('puts the cost source in parentheses that suit the language', () => {
    const usage: UsageView = {
      ...baseUsage,
      cost: { usdMicros: 12_000, source: 'estimated', subscription: false },
    }
    expect(formatUsageReport(usage, 'en')).toMatch(/\$0\.012 \([^（）]+\)/)
    expect(formatUsageReport(usage, 'zh-CN')).toMatch(/\$0\.012（[^()]+）/)
  })

  it('rounds float-summed credits like the status bar does', () => {
    const usage: UsageView = {
      ...baseUsage,
      credits: { amount: 0.1 + 0.2, source: 'gateway', complete: true },
    }
    expect(formatUsageReport(usage, 'en')).toContain('0.3 credits')
    expect(formatUsageReport(usage, 'en')).not.toContain('0.30000000000000004')
  })

  it('rounds the per-call credits and keeps unknown when absent', () => {
    const node: Extract<UINode, { kind: 'cost' }> = { kind: 'cost', id: 'c1', seq: 1, source: 'gateway' }
    expect(formatCallUsage({ ...node, credits: 0.1 + 0.2 })).toContain('credits: 0.3 (gateway)')
    expect(formatCallUsage(node)).toContain('credits: unknown (gateway)')
  })

  it('says no data yet when the provider has never reported a cache row', () => {
    const text = formatUsageReport(baseUsage, 'zh-CN')
    expect(text).toContain('缓存命中率（累计）：暂无数据')
  })

  it('shows the most recent invalidation with its cause in Chinese', () => {
    const text = formatUsageReport(
      {
        ...baseUsage,
        cache: { hitRate: 0.1, lastInvalidation: { seq: 42, reprocessedTokens: 9500, cause: 'compaction' } },
      },
      'zh-CN',
    )
    expect(text).toContain('最近一次缓存失效：seq 42 · 原因 压缩 · 重新处理 9500 token')
  })
})

describe('formatContextBreakdown', () => {
  it('says nothing has been recorded yet when there is no context-sections node', () => {
    expect(formatContextBreakdown([], 'zh-CN')).toBe('尚无上下文分段记录：本会话还没有发起过正式请求。')
  })

  it('lists sections ordered by order, with token share, using the most recent snapshot', () => {
    const nodes: UINode[] = [
      {
        kind: 'context-sections',
        id: 'a',
        seq: 1,
        sections: [
          { id: 'persona', order: 100, source: 'file', tokens: 200 },
          { id: 'core:untrusted-envelope', order: 0, source: 'core', tokens: 300 },
        ],
      },
      {
        kind: 'context-sections',
        id: 'b',
        seq: 5,
        sections: [
          { id: 'persona', order: 100, source: 'file', tokens: 200 },
          { id: 'core:untrusted-envelope', order: 0, source: 'core', tokens: 300 },
          { id: 'environment', order: 110, source: 'dynamic', tokens: 100 },
        ],
      },
    ]
    const text = formatContextBreakdown(nodes, 'zh-CN')
    expect(text).toContain('截至 seq 5')
    expect(text).toContain('共 600 token')
    const envelopeLine = text.split('\n').find((l) => l.includes('core:untrusted-envelope'))
    const environmentLine = text.split('\n').find((l) => l.includes('environment'))
    expect(text.indexOf(envelopeLine ?? '')).toBeLessThan(text.indexOf(environmentLine ?? ''))
    expect(text).toContain('50.0%') // 300 / 600
  })

  it('lists conflicts observed at or after the latest section snapshot', () => {
    const nodes: UINode[] = [
      {
        kind: 'context-sections',
        id: 'a',
        seq: 5,
        sections: [{ id: 'x', order: 150, source: 'code-mode', tokens: 10 }],
      },
      { kind: 'contribute-conflict', id: 'c', seq: 6, key: 'tools:sdk', ops: ['code-mode', 'skills'] },
    ]
    const text = formatContextBreakdown(nodes, 'zh-CN')
    expect(text).toContain('发现 1 处贡献冲突')
    expect(text).toContain('tools:sdk: code-mode, skills')
  })
})

describe('formatUsageReport RSI cost line', () => {
  const lane = (usdMicros?: number, credits?: number) => ({
    input: 10_000,
    output: 200,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    ...(usdMicros === undefined ? {} : { usdMicros }),
    ...(credits === undefined ? {} : { credits }),
  })
  const withRefinement: UsageView = {
    ...baseUsage,
    totals: { input: 10_100, output: 220, cacheRead: 90, cacheWrite: 0, reasoning: 0 },
    cost: { usdMicros: 52_000, source: 'gateway', subscription: false },
    credits: { amount: 5.5, source: 'gateway', complete: true },
    byLane: {
      main: {
        input: 100,
        output: 20,
        cacheRead: 90,
        cacheWrite: 0,
        reasoning: 0,
        usdMicros: 12_000,
        credits: 1.5,
      },
      refinement: lane(40_000, 4),
    } as NonNullable<UsageView['byLane']>,
  }

  it('shows the refinement spend on its own line and keeps it out of the session figures', () => {
    const text = formatUsageReport(withRefinement, 'en')
    expect(text).toContain('RSI cost')
    expect(text).toContain('$0.040 · 4 credits · input 10000 · output 200')
    expect(text).toContain('Input tokens (excl. cache): 100 · Output tokens (incl. reasoning): 20')
    expect(text).toContain('Cumulative USD cost: $0.012')
    expect(text).toContain('Cumulative credits: 1.5 credits')
    const zh = formatUsageReport(withRefinement, 'zh-CN')
    expect(zh).toContain('RSI 费用')
    expect(zh).toContain('输入 Token（不含缓存）：100')
  })

  it('has no RSI line while refinement has spent nothing, and does not invent a main cost', () => {
    expect(formatUsageReport(baseUsage, 'en')).not.toContain('RSI')
    const onlyRefinement: UsageView = {
      ...baseUsage,
      totals: { input: 10_000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usdMicros: 40_000, source: 'gateway', subscription: false },
      byLane: { refinement: lane(40_000) } as NonNullable<UsageView['byLane']>,
    }
    const text = formatUsageReport(onlyRefinement, 'en')
    expect(text).toContain('RSI cost')
    expect(text).toContain('Cumulative USD cost: not provided')
  })
})

describe('withoutRefinement', () => {
  const usage: UsageView = {
    ...baseUsage,
    totals: { input: 10_100, output: 220, cacheRead: 90, cacheWrite: 0, reasoning: 0 },
    cost: { usdMicros: 52_000, source: 'estimated', subscription: false },
    billingComplete: false,
    byLane: {
      main: { input: 100, output: 20, cacheRead: 90, cacheWrite: 0, reasoning: 0, usdMicros: 12_000 },
      refinement: {
        input: 10_000,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        usdMicros: 40_000,
      },
    } as NonNullable<UsageView['byLane']>,
  }

  it('takes the lane out of the figures and out of the breakdown, so a second pass changes nothing', () => {
    const own = withoutRefinement(usage)
    expect(own.totals).toMatchObject({ input: 100, output: 20 })
    expect(own.cost?.usdMicros).toBe(12_000)
    expect(Object.keys(own.byLane ?? {})).toEqual(['main'])
    expect(withoutRefinement(own)).toBe(own)
    expect(usage.byLane).toHaveProperty('refinement')
  })

  it("keeps the view's quality flags as given: the lanes carry none of their own", () => {
    const own = withoutRefinement(usage)
    expect(own.billingComplete).toBe(false)
    expect(own.cost?.source).toBe('estimated')
  })
})
