import type { UINode } from '@agnes/protocol'

export type RuntimeNode = Extract<UINode, { kind: 'runtime' }>
export type RuntimeNodeCard = { update(node: RuntimeNode): void; dispose?(): void }
export type RuntimeNodeCardFactory = (host: HTMLElement, initial: RuntimeNode) => RuntimeNodeCard

const labels: Record<RuntimeNode['status'], string> = {
  running: '进行中',
  waiting: '等待中',
  completed: '已记录',
  failed: '失败',
  cancelled: '已取消',
  unknown: '结果未知',
}

/** A generic observed-runtime disclosure. Identity and aggregation come exclusively from the backend. */
export function createRuntimeNodeCard(host: HTMLElement, initial: RuntimeNode): RuntimeNodeCard {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    return element
  }
  const card = make('details', 'runtime-process-card')
  const summary = make('summary')
  const icon = make('span', 'runtime-process-icon')
  icon.textContent = '◇'
  icon.setAttribute('aria-hidden', 'true')
  const title = make('strong')
  const state = make('span', 'runtime-process-state')
  const preview = make('span', 'runtime-process-preview')
  summary.append(icon, title, state, preview)
  const body = make('div', 'runtime-process-body')
  const facts = make('dl')
  const evidence = make('details', 'runtime-process-evidence')
  const evidenceLabel = make('summary')
  const previewNote = make('p')
  previewNote.textContent = '此处仅显示长度受限的详情摘要；“截断”标记属于展示摘要，不表示模型调用被截断。'
  const raw = make('pre')
  evidence.append(evidenceLabel, previewNote, raw)
  body.append(facts, evidence)
  card.append(summary, body)
  host.append(card)
  let node = initial
  const rawText = () => {
    raw.textContent = node.detail ?? '未提供详细记录。'
  }
  evidence.addEventListener('toggle', () => {
    if (evidence.open) rawText()
  })
  function update(next: RuntimeNode) {
    node = next
    card.dataset.category = node.category
    card.dataset.state = node.status
    host.dataset.status = node.status
    host.setAttribute('aria-label', `${node.title}：${labels[node.status]}`)
    title.textContent = node.title
    state.textContent = labels[node.status]
    preview.textContent = node.summary
    facts.replaceChildren()
    for (const [label, value] of [
      ['运行循环', `${node.runtime.id}@${node.runtime.version}`],
      ['用途', node.purpose],
      ['模型', node.model],
      ['记录范围', `#${node.seq}–${node.lastSeq}`],
      ['请求', node.requestId],
      ['动作意图', node.intentId],
    ]) {
      if (value === undefined) continue
      const term = make('dt')
      term.textContent = label ?? ''
      const description = make('dd')
      description.textContent = value
      facts.append(term, description)
    }
    evidence.hidden = node.detail === undefined
    evidenceLabel.textContent =
      node.category === 'action'
        ? '动作证据摘要'
        : node.category === 'stop'
          ? '停止详情摘要'
          : '决策与调用摘要'
    previewNote.hidden = !node.detail?.includes('\n[截断]')
    if (evidence.open) rawText()
  }
  update(initial)
  return { update }
}
