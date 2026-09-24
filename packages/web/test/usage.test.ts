// @vitest-environment happy-dom
import type { UINode, UsageView } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createTimelineRenderer } from '../src/timeline.js'
import { costDetails, costSummary, createUsagePanel } from '../src/usage.js'

afterEach(() => document.body.replaceChildren())
const call: Extract<UINode, { kind: 'cost' }> = {
  kind: 'cost',
  id: 'c1',
  seq: 4,
  source: 'estimated',
  purpose: 'inference',
  credits: 0.00020600000000000002,
  tokens: { input: 120, output: 50, cacheRead: 600, cacheWrite: 0, reasoning: 20 },
  billing: { usdMicros: 125, source: 'estimated', subscription: false },
  timing: { ttftMs: 110, durationMs: 2400 },
  model: 'm',
}
const usage: UsageView = {
  totals: { input: 1200, output: 500, cacheRead: 6000, cacheWrite: 0, reasoning: 20 },
  reasoningComplete: false,
  billingComplete: false,
  cost: { usdMicros: 125, source: 'estimated', subscription: false },
  credits: { amount: 0.00020600000000000002, source: 'gateway', complete: true },
  context: { tokens: 1500, window: 128000, autoCompact: true, source: 'estimated' },
  model: { route: 'account-acct-private', id: 'm', thinking: 'high', maxTokens: 8192 },
}
it('shows per-call values and known timing, without double counting reasoning or fabricating dollars', () => {
  expect(costSummary(call)).toBe('输入 120 · 输出 50 · $0.000125（估算）')
  expect(
    costSummary({
      ...call,
      billing: { usdMicros: 125, source: 'gateway', subscription: false },
    }),
  ).toContain('（网关记录）')
  expect(costDetails(call)).toContainEqual(['额度', '0.000206 credits · 估算'])
  expect(costDetails(call)).toContainEqual(['推理 Token（输出的子集）', '20'])
  expect(costDetails(call)).toContainEqual(['模型请求耗时', '2.40 秒'])
  const legacy = { kind: 'cost', id: 'c2', seq: 5, source: 'estimated', credits: 2 } as const
  expect(costSummary(legacy)).toBe('2 credits（估算）')
  expect(costDetails(legacy)).toContainEqual(['Token 明细', '未提供'])
  expect(costDetails(legacy).flat().join(' ')).not.toContain('$')
})
it('keeps a call disclosure open on replacement and renders model names as text', () => {
  const transcript = document.createElement('section')
  const timeline = createTimelineRenderer({
    transcript,
    newContentButton: document.createElement('button'),
  })
  document.body.append(transcript)
  timeline.render([call])
  const disclosure = transcript.querySelector('details')
  if (!disclosure) throw new Error('missing details')
  disclosure.open = true
  timeline.render([{ ...call, model: '<img src=x onerror=alert(1)>', interrupted: true }])
  expect(transcript.querySelector('details')).toBe(disclosure)
  expect(disclosure.open).toBe(true)
  expect(transcript.querySelector('img')).toBeNull()
  expect(transcript.textContent).toContain('已中断')
})
it('上下文弹窗按 DSH 的头部行排版，并在下半段接 Token 用量分区', () => {
  const container = document.createElement('section')
  document.body.append(container)
  const update = createUsagePanel(container)
  update(usage, true)
  expect(container.querySelector('.usage-ring')).not.toBeNull()
  // 头部一行：标题 + 百分比 + 数值（紧凑写法，照 DSH 的 "~285K / 1M"）。
  const head = container.querySelector('.usage-popover-head')
  expect(head?.querySelector('.usage-popover-title')?.textContent).toBe('上下文已用')
  expect(head?.querySelector('.usage-context-value')?.textContent).toBe('1.2%')
  expect(head?.querySelector('.usage-context-caption')?.textContent).toBe('约 1.5K / 128.0K')
  expect(container.querySelector<HTMLElement>('.usage-bar > span')?.style.width).toBe('1.2%')
  expect(container.querySelector('summary')?.textContent).toBe('上下文约 1.5K / 128.0K · 1.2%')
  expect(container.textContent).toContain('上下文占用')
  expect(container.textContent).toContain('1,500 Token')
  expect(container.textContent).toContain('128,000 Token')
  expect(container.textContent).toContain('8,192 Token')
  expect(container.textContent).toContain('已启用')
  const details = container.querySelector('details')
  if (!details) throw new Error('missing details')
  details.open = true
  update(usage, false)
  expect(details.open).toBe(true)
  expect(container.textContent).toContain('上次同步')
  update(undefined, true)
  expect(container.hidden).toBe(true)
  expect(details.open).toBe(false)
})

it('会话累计 Token / 额度 / 费用不在上下文弹窗里展示（按用户要求隐藏）', () => {
  const container = document.createElement('section')
  document.body.append(container)
  const update = createUsagePanel(container)
  update(usage, true)
  const details = container.querySelector('details')
  if (!details) throw new Error('missing details')
  expect(container.querySelectorAll('details')).toHaveLength(1)
  const popover = container.querySelector('.usage-popover')
  // 弹窗只剩上下文口径：头部 + 分段条 + 上下文明细 + 说明。
  expect(popover?.querySelector('.usage-popover-head')).not.toBeNull()
  expect(popover?.querySelector('.usage-bar')).not.toBeNull()
  expect(popover?.querySelector('.usage-grid')?.textContent).toContain('上下文占用')
  expect(popover?.querySelector('.stat-rows')).toBeNull()
  expect(popover?.querySelector('.stat-popover-title')).toBeNull()
  const text = container.textContent ?? ''
  for (const gone of ['Token 用量', '累计额度', '累计美元费用', '当前模型', '缓存命中', '未缓存输入']) {
    expect(text).not.toContain(gone)
  }
  expect(text).not.toContain('0.000206')
  expect(text).not.toContain('account-acct-private')
  details.open = true
  update(usage, false)
  expect(details.open).toBe(true)
  expect(container.textContent).toContain('上次同步')
  update(undefined, true)
  expect(container.hidden).toBe(true)
  expect(details.open).toBe(false)
})
