import type { UINode, UsageView } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { formatContextBreakdown, formatUsageReport } from '../src/usage-details.js'

const baseUsage: UsageView = {
  totals: { input: 100, output: 20, cacheRead: 90, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: false,
  context: { source: 'estimated', tokens: 1000, window: 1_000_000, autoCompact: true },
  model: { route: 'agnes-api', id: 'deepseek-v4-pro', thinking: 'high' },
}

describe('formatUsageReport cache section', () => {
  it('shows the cumulative hit rate as a percentage', () => {
    const text = formatUsageReport({ ...baseUsage, cache: { hitRate: 0.5 } })
    expect(text).toContain('缓存命中率（累计）：50.0%')
  })

  it('says no data yet when the provider has never reported a cache row', () => {
    const text = formatUsageReport(baseUsage)
    expect(text).toContain('缓存命中率（累计）：暂无数据')
  })

  it('shows the most recent invalidation with its cause in Chinese', () => {
    const text = formatUsageReport({
      ...baseUsage,
      cache: { hitRate: 0.1, lastInvalidation: { seq: 42, reprocessedTokens: 9500, cause: 'compaction' } },
    })
    expect(text).toContain('最近一次缓存失效：seq 42 · 原因 压缩 · 重新处理 9500 token')
  })
})

describe('formatContextBreakdown', () => {
  it('says nothing has been recorded yet when there is no context-sections node', () => {
    expect(formatContextBreakdown([])).toBe('尚无上下文分段记录：本会话还没有发起过正式请求。')
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
    const text = formatContextBreakdown(nodes)
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
    const text = formatContextBreakdown(nodes)
    expect(text).toContain('发现 1 处贡献冲突')
    expect(text).toContain('tools:sdk: code-mode, skills')
  })
})
