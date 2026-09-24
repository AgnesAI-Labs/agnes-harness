import type { UINode } from '@agnes/protocol'

type ToolNode = Extract<UINode, { kind: 'tool' }>
type TextRef = { element: HTMLElement; node: Text; value: string }

export interface ConversationToolCard {
  update(node: ToolNode): void
}

export interface ConversationToolCardOptions {
  icon(name: string): Element
}

const DETAIL_LABEL = { closed: '查看详情', open: '收起详情' } as const
const STATUS_LABEL: Record<ToolNode['status'], string> = {
  planned: '等待执行',
  awaiting_approval: '等待审批',
  running: '正在执行',
  completed: '执行完成',
  failed: '执行失败',
  cancelled: '已取消',
}

function text(parent: HTMLElement, className: string, value = ''): TextRef {
  const element = document.createElement('div')
  element.className = className
  const node = document.createTextNode(value)
  element.append(node)
  parent.append(element)
  return { element, node, value }
}

function label(parent: HTMLElement, className: string, value: string): TextRef {
  const element = document.createElement('span')
  element.className = className
  const node = document.createTextNode(value)
  element.append(node)
  parent.append(element)
  return { element, node, value }
}

function updateText(ref: TextRef, value: string): void {
  if (ref.value === value) return
  if (value.startsWith(ref.value)) ref.node.appendData(value.slice(ref.value.length))
  else ref.node.replaceData(0, ref.node.length, value)
  ref.value = value
}

function meaningfulSummary(node: ToolNode): string {
  const summary = node.summary.trim()
  if (!summary || summary === node.name) return ''
  const remainder = summary.startsWith(node.name) ? summary.slice(node.name.length).trim() : summary
  return !remainder || remainder.startsWith('{') || remainder.startsWith('[') ? '' : summary
}

function formatDetail(node: ToolNode): string {
  const lines = [`工具：${node.name}`, `状态：${STATUS_LABEL[node.status]}`]
  if (node.argsPreview) lines.push('', '执行参数', node.argsPreview)
  if (node.resultPreview)
    lines.push('', node.status === 'failed' ? '错误详情' : '执行结果', node.resultPreview)
  return lines.join('\n')
}

function ariaLabel(node: ToolNode): string {
  return `工具 ${node.name}：${STATUS_LABEL[node.status]}`
}

/** Owns the tool-card DOM and detail disclosure; the timeline only owns node ordering. */
export function createConversationToolCard(
  element: HTMLElement,
  node: ToolNode,
  options: ConversationToolCardOptions,
): ConversationToolCard {
  const head = document.createElement('div')
  head.className = 'tool-head'
  const metadata = document.createElement('div')
  metadata.className = 'tool-meta'
  const name = label(metadata, 'tool-name', node.name)
  const status = label(metadata, 'tool-status', STATUS_LABEL[node.status])
  metadata.prepend(options.icon(node.name))
  const detail = document.createElement('button')
  detail.type = 'button'
  detail.className = 'tool-detail'
  detail.textContent = DETAIL_LABEL.closed
  detail.setAttribute('aria-expanded', 'false')
  head.append(metadata, detail)
  element.append(head)
  const summary = text(element, 'tool-summary', meaningfulSummary(node))
  summary.element.hidden = !summary.value
  const detailBody = document.createElement('div')
  detailBody.className = 'tool-detail-body'
  const detailInner = document.createElement('div')
  detailInner.className = 'tool-detail-inner'
  detailBody.append(detailInner)
  element.append(detailBody)
  const detailText = text(detailInner, 'tool-detail-text', formatDetail(node))
  detail.addEventListener('click', () => {
    const open = element.dataset.expanded === 'true'
    element.dataset.expanded = String(!open)
    detail.setAttribute('aria-expanded', String(!open))
    detail.textContent = open ? DETAIL_LABEL.closed : DETAIL_LABEL.open
  })

  const update = (next: ToolNode): void => {
    updateText(name, next.name)
    updateText(status, STATUS_LABEL[next.status])
    element.setAttribute('aria-label', ariaLabel(next))
    element.dataset.status = next.status
    const nextSummary = meaningfulSummary(next)
    summary.element.hidden = !nextSummary
    updateText(summary, nextSummary)
    updateText(detailText, formatDetail(next))
  }
  update(node)
  return { update }
}
