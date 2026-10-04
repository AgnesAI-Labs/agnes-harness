import type { EventEnvelope, TurnEnd, UINode, UITimeline, UITurn } from '@agnes/protocol'
import type { LocaleVars } from '@agnes/web-client'
import type { Translate } from './presentation.js'

type ApprovalNode = Extract<UINode, { kind: 'approval' }>
type ApprovalOption = ApprovalNode['options'][number]
export type DurableApprovalAction = {
  option: ApprovalOption
  label: string
  verdict: 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'
}

const DURABLE_APPROVAL_KEYS: Record<ApprovalOption, string> = {
  allow_once: 'timeline.decision.allowedOnce',
  allow_always: 'timeline.decision.allowedSession',
  allow_permanent: 'timeline.decision.allowedPermanent',
  reject_once: 'timeline.decision.rejectOnce',
}

/** The UI may act only on options the durable approval event actually offered. */
export function durableApprovalActions(node: ApprovalNode, t: Translate): DurableApprovalAction[] {
  return node.options.map((option) => ({
    option,
    label: t(DURABLE_APPROVAL_KEYS[option]),
    verdict: DURABLE_APPROVAL_VERDICTS[option],
  }))
}

const DURABLE_APPROVAL_VERDICTS: Record<ApprovalOption, DurableApprovalAction['verdict']> = {
  allow_once: 'allowed-once',
  allow_always: 'allowed-session',
  allow_permanent: 'allowed-permanent',
  reject_once: 'rejected',
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

const TERMINAL_KEYS: Record<TurnEnd['reason'], string> = {
  completed: 'timeline.terminal.completed',
  aborted: 'timeline.terminal.aborted',
  interrupted: 'timeline.terminal.interrupted',
  error: 'timeline.terminal.error',
  parked: 'timeline.terminal.parked',
  blocked: 'timeline.terminal.blocked',
  budget: 'timeline.terminal.budget',
  max_steps: 'timeline.terminal.maxSteps',
}

const PHASE_KEYS: Record<string, string> = {
  inference: 'timeline.phase.inference',
  tools: 'timeline.phase.tools',
  checkpoint: 'timeline.phase.checkpoint',
  compaction: 'timeline.phase.compaction',
  deferred: 'timeline.phase.deferred',
  cancel_requested: 'timeline.phase.cancelRequested',
  failure_drain: 'timeline.phase.failureDrain',
}

export type WebView = {
  busy: boolean
  approval?: ApprovalNode
  nodes: UINode[]
  status: string
}

export function webView(
  timeline: UITimeline,
  receipt?: RunReceipt,
  t: (key: string, vars?: LocaleVars) => string = (key) => key,
): WebView {
  const approval = timeline.nodes.find(
    (node): node is ApprovalNode =>
      node.kind === 'approval' && node.state === 'pending' && typeof node.ticket === 'string',
  )
  const phase = timeline.opState?.phase
  const phaseKey = phase === undefined ? undefined : PHASE_KEYS[phase]
  return {
    busy: timeline.opState !== null,
    ...(approval ? { approval } : {}),
    // WC9：slot 节点不再被丢弃；时间线为它保留稳定容器，认领未命中时显示占位。
    nodes: timeline.nodes,
    status: approval
      ? t('timeline.status.awaitingApproval')
      : phase
        ? phaseKey
          ? t('timeline.status.runningPhase', { phase: t(phaseKey) })
          : t('timeline.status.running')
        : receipt?.reason && receipt.endSeq >= receipt.startSeq
          ? t(TERMINAL_KEYS[receipt.reason])
          : t('timeline.status.ready'),
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
