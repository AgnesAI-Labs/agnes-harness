import type { UINode, UsageView } from '@agnes/protocol'
import { bindAutoDismissDisclosure } from '@agnes/web-admin-frame'

export type CostNode = Extract<UINode, { kind: 'cost' }>
const count = (n: number) => n.toLocaleString('en-US')
const compact = (n: number) =>
  n < 1000 ? String(n) : `${(n / (n >= 1e6 ? 1e6 : 1000)).toFixed(1)}${n >= 1e6 ? 'M' : 'K'}`
const usd = (n: number) => `$${(n / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.00')}`
const credits = (n: number) => n.toFixed(8).replace(/\.?0+$/, '')
const source = (value: 'gateway' | 'estimated') => (value === 'estimated' ? '估算' : '网关记录')
const time = (n: number) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} 秒`)
type Rows = Array<[string, string]>
const purposes: Record<string, string> = {
  inference: '模型调用',
  compaction: '上下文整理',
  subagent: '子任务',
  verifier: '结果验证',
  media: '媒体',
  tool: '工具',
}

export function costSummary(node: CostNode): string {
  const parts = node.tokens
    ? [`输入 ${compact(node.tokens.input)}`, `输出 ${compact(node.tokens.output)}`]
    : []
  const amount = node.billing
    ? `${usd(node.billing.usdMicros)}（${source(node.billing.source)}）`
    : node.credits === undefined
      ? '费用未提供'
      : `${credits(node.credits)} credits（${source(node.source)}）`
  return [...parts, amount, ...(node.interrupted ? ['已中断'] : [])].join(' · ')
}

function tokenRows(tokens: NonNullable<CostNode['tokens']>): Rows {
  return [
    ['输入 Token（不含缓存）', count(tokens.input)],
    ['输出 Token（含推理）', count(tokens.output)],
    ['缓存读取 Token', count(tokens.cacheRead)],
    ['缓存写入 Token', count(tokens.cacheWrite)],
    ['推理 Token（输出的子集）', tokens.reasoning === undefined ? '未提供' : count(tokens.reasoning)],
  ]
}

export function costDetails(node: CostNode): Rows {
  return [
    ['记录范围', purposes[node.purpose ?? ''] ?? '单次费用记录'],
    ...(node.model ? [['模型', node.model] as [string, string]] : []),
    ...(node.tokens ? tokenRows(node.tokens) : [['Token 明细', '未提供'] as [string, string]]),
    ...(node.billing
      ? [['美元费用', `${usd(node.billing.usdMicros)} · ${source(node.billing.source)}`] as [string, string]]
      : []),
    [
      '额度',
      node.credits === undefined ? '未提供' : `${credits(node.credits)} credits · ${source(node.source)}`,
    ],
    ...(node.timing?.ttftMs !== undefined
      ? [['首次输出等待', time(node.timing.ttftMs)] as [string, string]]
      : []),
    ...(node.timing?.durationMs !== undefined
      ? [['模型请求耗时', time(node.timing.durationMs)] as [string, string]]
      : []),
    ...(node.interrupted ? [['状态', '已中断；用量可能不完整或包含估算'] as [string, string]] : []),
  ]
}

function fillRows(list: HTMLDListElement, rows: Rows): void {
  list.replaceChildren(
    ...rows.flatMap(([name, value]) => {
      const term = document.createElement('dt')
      const detail = document.createElement('dd')
      term.textContent = name
      detail.textContent = value
      return [term, detail]
    }),
  )
}

/** Keeps the native disclosure and its focus/expanded state through incremental updates. */
export function createCostDetails(parent: HTMLElement): (node: CostNode) => void {
  const details = document.createElement('details')
  details.className = 'usage-disclosure call-usage'
  const summary = document.createElement('summary')
  summary.setAttribute('aria-label', '查看本次调用用量明细')
  const list = document.createElement('dl')
  list.className = 'usage-grid'
  details.append(summary, list)
  parent.append(details)
  return (node) => {
    summary.textContent = costSummary(node)
    fillRows(list, costDetails(node))
  }
}

/**
 * 上下文占用环形触发器 + 弹窗。布局为：头部一行是
 * 「上下文已用 + 百分比 + 数值（顶到行尾）」，下面是 4px 分段条与上下文明细行。
 * 会话累计 Token / 额度 / 费用一行**不再展示**（按用户要求隐藏）；单次调用的
 * 用量明细仍在回合内的 `costDetails` 折叠里。
 * 明细行需适配本协议的数据形状：只下发 `context.{tokens,window,autoCompact,source}`，
 * 没有分项明细，故只呈现本仓真有的字段。
 */
export function createUsagePanel(
  parent: HTMLElement,
): (usage: UsageView | undefined, connected: boolean) => void {
  const details = document.createElement('details')
  details.className = 'usage-disclosure session-usage'
  const summary = document.createElement('summary')
  summary.setAttribute('aria-label', '查看会话上下文占用')
  summary.title = '上下文用量'
  const ring = document.createElement('span')
  ring.className = 'usage-ring'
  ring.setAttribute('aria-hidden', 'true')
  const summaryLabel = document.createElement('span')
  summaryLabel.className = 'usage-summary-label'
  summary.append(ring, summaryLabel)
  const popover = document.createElement('div')
  popover.className = 'usage-popover'
  const head = document.createElement('div')
  head.className = 'usage-popover-head'
  const title = document.createElement('p')
  title.className = 'usage-popover-title'
  title.textContent = '上下文已用'
  const contextValue = document.createElement('p')
  contextValue.className = 'usage-context-value'
  const contextCaption = document.createElement('p')
  contextCaption.className = 'usage-context-caption'
  head.append(title, contextValue, contextCaption)
  const bar = document.createElement('div')
  bar.className = 'usage-bar'
  bar.setAttribute('aria-hidden', 'true')
  const barFill = document.createElement('span')
  bar.append(barFill)
  const list = document.createElement('dl')
  list.className = 'usage-grid'
  const note = document.createElement('p')
  note.className = 'usage-note'
  note.textContent = '上下文为后台估算，包含当前保留的对话等内容；模型窗口与输出上限来自模型配置。'
  popover.append(head, bar, list, note)
  details.append(summary, popover)
  parent.append(details)
  bindAutoDismissDisclosure(details)
  let previous = ''
  return (usage, connected) => {
    parent.hidden = !usage
    if (!usage) {
      details.open = false
      previous = ''
      summaryLabel.textContent = ''
      contextValue.textContent = ''
      contextCaption.textContent = ''
      list.replaceChildren()
      return
    }
    const key = JSON.stringify([usage, connected])
    if (key === previous) return
    previous = key
    const pct = ((usage.context.tokens / usage.context.window) * 100).toFixed(1)
    const stale = connected ? '' : ' · 上次同步'
    const summaryText = `上下文约 ${compact(usage.context.tokens)} / ${compact(usage.context.window)} · ${pct}%${stale}`
    summaryLabel.textContent = summaryText
    summary.setAttribute('aria-label', `查看${summaryText}`)
    ring.style.setProperty('--usage-pct', `${Math.min(100, Number(pct))}%`)
    contextValue.textContent = `${pct}%`
    // 数值用紧凑写法（如 "~285K / 1M"）：完整数字会把这一行顶爆。
    contextCaption.textContent = `约 ${compact(usage.context.tokens)} / ${compact(usage.context.window)}${stale}`
    barFill.style.width = `${Math.min(100, Number(pct))}%`
    details.dataset.pressure = Number(pct) > 90 ? 'high' : Number(pct) > 70 ? 'medium' : 'normal'
    // 每条都留在单行内（264px 面板放不下 "3,812 / 1,000,000 Token" 这种长值，
    // 折行会把行高翻倍）；比例在头部，这里给绝对值。
    fillRows(list, [
      ['上下文占用', `${count(usage.context.tokens)} Token`],
      ['模型窗口', `${count(usage.context.window)} Token`],
      ...(usage.model.maxTokens
        ? [['最大输出上限', `${count(usage.model.maxTokens)} Token`] as [string, string]]
        : []),
      ['自动整理上下文', usage.context.autoCompact ? '已启用' : '未启用'],
    ])
  }
}
