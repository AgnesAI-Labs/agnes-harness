// @vitest-environment happy-dom

import type { UINode, UsageView } from '@agnes/protocol'
import { costDetails, costSummary } from '@agnes/web-conversation/usage'
import { createRegionRenderer, setDisclosureOpen } from '@agnes/web-ui'
import { ConversationUsage } from '@agnes/web-ui/conversation'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { zhT } from './helpers/locale.js'

type UsagePanel = ((usage: UsageView | undefined, connected: boolean) => void) & { dispose(): void }
const panels: UsagePanel[] = []
/** The composer renders this component in its own tree; the fixture drives it the same way. */
function mountUsage(parent: HTMLElement): UsagePanel {
  const root = createRegionRenderer(parent)
  let disposed = false
  const panel = ((usage, connected) => {
    if (disposed) return
    root.render(createElement(ConversationUsage, { usage, connected, t: zhT }))
    root.flush()
  }) as UsagePanel
  panel.dispose = () => {
    if (disposed) return
    disposed = true
    root.unmount()
  }
  panel(undefined, false)
  panels.push(panel)
  return panel
}
afterEach(() => {
  for (const panel of panels.splice(0)) panel.dispose()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})
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
const unknownTiming = [
  ['调用总耗时（非整轮）', '未提供'],
  ['调用内准备', '未提供'],
  ['其中：轨迹采集（与其他阶段重叠）', '未提供'],
  ['首次发送时点（距调用开始）', '未提供'],
  ['首次可见输出（距调用开始）', '未提供'],
  ['输出阶段', '未提供'],
  ['收尾', '未提供'],
]
it('shows per-call values and known timing, without double counting reasoning or fabricating dollars', () => {
  expect(costSummary(call, zhT)).toBe('输入 120 · 输出 50 · $0.000125（估算）')
  expect(
    costSummary(
      {
        ...call,
        billing: { usdMicros: 125, source: 'gateway', subscription: false },
      },
      zhT,
    ),
  ).toContain('（网关记录）')
  expect(costDetails(call, zhT)).toContainEqual(['额度', '0.000206 credits · 估算'])
  expect(costDetails(call, zhT)).toContainEqual(['推理 Token（输出的子集）', '20'])
  expect(costDetails(call, zhT)).toContainEqual(['请求采样耗时（不含收尾）', '2.40 秒'])
  for (const row of unknownTiming) expect(costDetails(call, zhT)).toContainEqual(row)
  const legacy = { kind: 'cost', id: 'c2', seq: 5, source: 'estimated', credits: 2 } as const
  expect(costSummary(legacy, zhT)).toBe('2 credits（估算）')
  expect(costDetails(legacy, zhT)).toContainEqual(['Token 明细', '未提供'])
  expect(costDetails(legacy, zhT).flat().join(' ')).not.toContain('$')
})
it('上下文弹窗按 DSH 的头部行排版，并在下半段接 Token 用量分区', () => {
  const container = document.createElement('section')
  document.body.append(container)
  const update = mountUsage(container)
  update(usage, true)
  expect(container.querySelector('.usage-ring')).not.toBeNull()
  // 头部一行：标题 + 百分比 + 数值（紧凑写法，照 DSH 的 "~285K / 1M"）。
  const head = container.querySelector('.usage-popover-head')
  expect(head?.querySelector('.usage-popover-title')?.textContent).toBe('上下文已用')
  expect(head?.querySelector('.usage-context-value')?.textContent).toBe('1.2%')
  expect(head?.querySelector('.usage-context-caption')?.textContent).toBe('约 1.5K / 128.0K')
  expect(container.querySelector<HTMLElement>('.usage-bar > span')?.style.width).toBe('1.2%')
  // 量表只显示占比；完整读数在提示与无障碍名称里。
  expect(container.querySelector('.usage-percent')?.textContent).toBe('1%')
  expect(container.querySelector('.usage-summary-label')?.textContent).toBe('上下文约 1.5K / 128.0K · 1.2%')
  expect(container.querySelector<HTMLElement>('.agh-disclosure-summary')?.title).toBe(
    '上下文约 1.5K / 128.0K · 1.2%. 上下文占用为后台估算。',
  )
  expect(container.querySelector('.agh-disclosure-summary')?.getAttribute('aria-label')).toBe(
    '查看上下文约 1.5K / 128.0K · 1.2%. 上下文占用为后台估算。',
  )
  expect(container.textContent).toContain('上下文占用')
  expect(container.textContent).toContain('1,500 Token')
  expect(container.textContent).toContain('128,000 Token')
  expect(container.textContent).toContain('8,192 Token')
  expect(container.textContent).toContain('已启用')
  const details = container.querySelector<HTMLElement>('.agh-disclosure')
  if (!details) throw new Error('missing details')
  setDisclosureOpen(details, true)
  update(usage, false)
  expect(details.dataset.open).toBe('true')
  expect(container.textContent).toContain('上次同步')
  update(undefined, true)
  expect(details.hidden).toBe(true)
  expect(details.dataset.open).toBe('false')
})

it('会话累计 Token / 额度 / 费用不在上下文弹窗里展示（按用户要求隐藏）', () => {
  const container = document.createElement('section')
  document.body.append(container)
  const update = mountUsage(container)
  update(usage, true)
  const details = container.querySelector<HTMLElement>('.agh-disclosure')
  if (!details) throw new Error('missing details')
  expect(container.querySelectorAll('.agh-disclosure')).toHaveLength(1)
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
  setDisclosureOpen(details, true)
  update(usage, false)
  expect(details.dataset.open).toBe('true')
  expect(container.textContent).toContain('上次同步')
  update(undefined, true)
  expect(details.hidden).toBe(true)
  expect(details.dataset.open).toBe('false')
})

it('preserves zero and missing values and separate dollar/credit provenance in pure cost formatting', () => {
  const zero = {
    ...call,
    source: 'estimated' as const,
    credits: 0,
    billing: { usdMicros: 0, source: 'gateway' as const, subscription: true },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    timing: {
      providerCallMs: 0,
      prepareMs: 0,
      captureMs: 0,
      dispatchMs: 0,
      firstOutputMs: 0,
      outputMs: 0,
      finalizeMs: 0,
      ttftMs: 0,
      durationMs: 0,
    },
    interrupted: true,
  }
  expect(costSummary(zero, zhT)).toBe('输入 0 · 输出 0 · $0.00（网关记录） · 已中断')
  expect(costDetails(zero, zhT)).toContainEqual(['额度', '0 credits · 估算'])
  expect(costDetails(zero, zhT)).toContainEqual(['美元费用', '$0.00 · 网关记录'])
  expect(costDetails(zero, zhT)).toContainEqual(['推理 Token（输出的子集）', '0'])
  expect(costDetails(zero, zhT)).toContainEqual(['初始采集后的首次输出等待', '0 ms'])
  expect(costDetails(zero, zhT)).toContainEqual(['请求采样耗时（不含收尾）', '0 ms'])
  for (const [label] of unknownTiming) expect(costDetails(zero, zhT)).toContainEqual([label, '0 ms'])
  const missing = { kind: 'cost', id: 'missing', seq: 1, source: 'gateway' } as const
  expect(costSummary(missing, zhT)).toBe('费用未提供')
  expect(costDetails(missing, zhT)).toEqual([
    ['记录范围', '单次费用记录'],
    ['Token 明细', '未提供'],
    ['额度', '未提供'],
    ...unknownTiming,
  ])
})

it('treats unknown and object-prototype purpose names as the generic single-call scope', () => {
  for (const purpose of ['unknown', '__proto__', 'constructor', 'toString']) {
    expect(costDetails({ ...call, purpose }, zhT)[0]).toEqual(['记录范围', '单次费用记录'])
  }
})

it('hides before first data and releases its dismiss listener once closed', () => {
  const container = document.createElement('section')
  document.body.append(container)
  const removed = vi.spyOn(document, 'removeEventListener')
  const added = vi.spyOn(document, 'addEventListener')
  const update = mountUsage(container)
  expect(required(container.querySelector<HTMLElement>('.agh-disclosure')).hidden).toBe(true)
  update(usage, true)
  const details = required(container.querySelector<HTMLElement>('.agh-disclosure'))
  expect(details.hidden).toBe(false)
  setDisclosureOpen(details, true)
  required(container.querySelector<HTMLElement>('.usage-popover')).click()
  expect(details.dataset.open).toBe('true')
  document.body.click()
  expect(details.dataset.open).toBe('false')
  update.dispose()
  const click = added.mock.calls.find(([event]) => event === 'click')
  expect(click).toBeDefined()
  expect(removed.mock.calls.some(([event, callback]) => event === 'click' && callback === click?.[1])).toBe(
    true,
  )
  vi.restoreAllMocks()
})

function required<T>(value: T | null): T {
  if (value === null) throw new Error('missing fixture element')
  return value
}
