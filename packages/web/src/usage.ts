import type { UsageView } from '@agnes/protocol'
import { bindAutoDismissDisclosure } from '@agnes/web-admin-frame'
import { type CostNode, costDetails, costSummary } from '@agnes/web-ui/assistant-ui'

export { type CostNode, costDetails, costSummary } from '@agnes/web-ui/assistant-ui'

const count = (n: number) => n.toLocaleString('en-US')
const compact = (n: number) =>
  n < 1000 ? String(n) : `${(n / (n >= 1e6 ? 1e6 : 1000)).toFixed(1)}${n >= 1e6 ? 'M' : 'K'}`
type Rows = Array<[string, string]>

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
