import type { EventEnvelope, TurnEnd, UINode, UITimeline, UITurn } from '@agnes/protocol'

type ApprovalNode = Extract<UINode, { kind: 'approval' }>
type ApprovalOption = ApprovalNode['options'][number]
export type DurableApprovalAction = {
  option: ApprovalOption
  label: string
  verdict: 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'
}

const DURABLE_APPROVAL_ACTIONS: Record<ApprovalOption, Omit<DurableApprovalAction, 'option'>> = {
  allow_once: { label: '仅允许这次', verdict: 'allowed-once' },
  allow_always: { label: '本会话允许', verdict: 'allowed-session' },
  allow_permanent: { label: '对此配置始终允许', verdict: 'allowed-permanent' },
  reject_once: { label: '拒绝', verdict: 'rejected' },
}

/** The UI may act only on options the durable approval event actually offered. */
export function durableApprovalActions(node: ApprovalNode): DurableApprovalAction[] {
  return node.options.map((option) => ({ option, ...DURABLE_APPROVAL_ACTIONS[option] }))
}

/** Display receipt from validated ledger rows, including replay; never an execution controller. */
export type RunReceipt = { startSeq: number; endSeq: number; reason?: TurnEnd['reason'] }
export function recordRunEvent(previous: RunReceipt | undefined, event: EventEnvelope): RunReceipt {
  const next = previous ?? { startSeq: 0, endSeq: 0 }
  if (event.type === 'turn/start' && event.seq > next.startSeq) return { ...next, startSeq: event.seq }
  if (event.type === 'turn/end' && event.seq > next.endSeq) {
    const data = event.data as TurnEnd
    return { ...next, endSeq: event.seq, reason: data.reason }
  }
  return next
}

/** The receipt the last loaded turn stands for, when a session opens without replaying its history. */
export function receiptFromTurns(turns: readonly UITurn[]): RunReceipt | undefined {
  const last = turns.at(-1)
  if (!last) return undefined
  return {
    startSeq: last.startSeq,
    endSeq: last.endSeq ?? 0,
    ...(last.reason ? { reason: last.reason } : {}),
  }
}

const terminalLabels: Record<TurnEnd['reason'], string> = {
  completed: '已完成',
  aborted: '已取消',
  interrupted: '已中断',
  error: '执行失败',
  parked: '等待处理',
  blocked: '执行受阻',
  budget: '预算已用尽',
  max_steps: '已达到执行步数上限',
}

const phaseLabels: Record<string, string> = {
  inference: '生成回复',
  tools: '执行工具',
  checkpoint: '检查下一步',
  compaction: '整理上下文',
  deferred: '等待外部结果',
  cancel_requested: '处理停止请求',
  failure_drain: '处理执行失败',
}

export type WebView = {
  busy: boolean
  approval?: ApprovalNode
  nodes: UINode[]
  status: string
}

export function webView(timeline: UITimeline, receipt?: RunReceipt): WebView {
  const approval = timeline.nodes.find(
    (node): node is ApprovalNode =>
      node.kind === 'approval' && node.state === 'pending' && typeof node.ticket === 'string',
  )
  const phase = timeline.opState?.phase
  return {
    busy: timeline.opState !== null,
    ...(approval ? { approval } : {}),
    // WC9：slot 节点不再被丢弃；时间线为它保留稳定容器，认领未命中时显示占位。
    nodes: timeline.nodes,
    status: approval
      ? '等待审批'
      : phase
        ? phaseLabels[phase]
          ? `正在执行 · ${phaseLabels[phase]}`
          : '正在执行'
        : receipt?.reason && receipt.endSeq >= receipt.startSeq
          ? terminalLabels[receipt.reason]
          : '准备就绪',
  }
}

export function nodeText(node: UINode): string {
  if (node.kind === 'user')
    return node.content
      .filter(
        (block): block is Extract<(typeof node.content)[number], { type: 'text' }> => block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n')
  if (node.kind === 'assistant') return [node.thinking, node.text].filter(Boolean).join('\n')
  if (node.kind === 'tool')
    return [node.summary, node.argsPreview, node.resultPreview].filter(Boolean).join('\n\n')
  if (node.kind === 'approval') return node.summary
  if (node.kind === 'cost') return node.credits === undefined ? node.source : `${node.credits} credits`
  if (node.kind === 'artifact') return node.name
  if (node.kind === 'compaction') return node.summary ?? `Compacted ${node.range.join('–')}`
  return ''
}
