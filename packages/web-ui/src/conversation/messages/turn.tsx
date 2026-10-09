import type { UINode, UITurn } from '@agnes/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useInteractionSnapshot } from '../markdown-snapshot.js'
import type { AssistantNode, ConversationMessagesProps } from './context.js'
import { markdownState } from './markdown-state.js'
import { isEmptyStreamingAssistant, Message } from './message.js'

export const TURN_STATUS_KEYS: Record<UITurn['status'], string> = {
  running: 'turn.status.running',
  waiting: 'turn.status.waiting',
  completed: 'turn.status.completed',
  failed: 'turn.status.failed',
  cancelled: 'turn.status.cancelled',
}

export function Turn({
  turn,
  nodes,
  ownerByNodeId,
  props,
}: {
  turn: UITurn
  nodes: Map<string, UINode>
  ownerByNodeId: Map<string, string>
  props: ConversationMessagesProps
}) {
  const details = useRef<HTMLDetailsElement>(null)
  const thinkingHost = useRef<HTMLDivElement>(null)
  // Final thinking changes parents. Delay that handover while its existing subtree is in use.
  const thinkingFinalId = useInteractionSnapshot(thinkingHost, turn.finalAssistantId)
  const preference = useRef<boolean | undefined>(undefined)
  const wasActive = useRef<boolean | undefined>(undefined)
  const active = !turn.endedAt && (turn.status === 'running' || turn.status === 'waiting')
  const processActive = turn.status === 'running' || turn.status === 'waiting'
  const response = useRef<HTMLDivElement>(null)
  const shownProcessActive = useInteractionSnapshot(response, processActive)
  const [processOpen, setProcessOpen] = useState(processActive)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const clock = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNow(Date.now())
    }, 1000)
    return () => clearInterval(clock)
  }, [active])
  useLayoutEffect(() => {
    if (wasActive.current && !shownProcessActive) preference.current = false
    wasActive.current = shownProcessActive
    const open = preference.current ?? shownProcessActive
    if (details.current) details.current.open = open
    setProcessOpen(open)
  }, [shownProcessActive])

  const members = turn.nodeIds.flatMap((id) => {
    const node = nodes.get(id)
    return node && ownerByNodeId.get(id) === turn.id ? [node] : []
  })
  const users = members.filter((node) => node.kind === 'user')
  const others = members.filter((node) => node.kind !== 'user')
  const attention = (node: UINode) =>
    (node.kind === 'approval' && node.state === 'pending') || props.keepNodeVisible?.(node) === true
  const pendingApproval = others.some((node) => node.kind === 'approval' && node.state === 'pending')
  const awaitingToolApproval = others.some(
    (node) => node.kind === 'tool' && node.status === 'awaiting_approval',
  )
  const runningTool = others.some((node) => node.kind === 'tool' && node.status === 'running')
  const latestStreaming = others
    .filter((node): node is AssistantNode => node.kind === 'assistant' && node.streaming === true)
    .sort((a, b) => b.seq - a.seq)[0]
  let status = props.t(TURN_STATUS_KEYS[turn.status])
  if (processActive) {
    if (pendingApproval || awaitingToolApproval) status = props.t('turn.status.awaitingApproval')
    else if (turn.status === 'waiting') status = props.t(TURN_STATUS_KEYS.waiting)
    else if (runningTool) status = props.t('turn.status.runningTool')
    else if (latestStreaming?.text.trim()) status = props.t('turn.status.replying')
    else if (latestStreaming?.thinking?.trim()) status = props.t('turn.status.thinking')
    else status = props.t('turn.status.preparing')
  }
  const startedAt = Date.parse(turn.startedAt)
  const duration =
    active && Number.isFinite(startedAt)
      ? props.t('turn.duration.s', { n: Math.floor(Math.max(0, now - startedAt) / 1000) })
      : turn.durationMs === undefined
        ? undefined
        : turn.durationMs < 1000
          ? props.t('turn.duration.ms', { n: turn.durationMs })
          : turn.durationMs < 60_000
            ? props.t('turn.duration.s', {
                n: (turn.durationMs / 1000).toFixed(turn.durationMs < 10_000 ? 1 : 0),
              })
            : props.t('turn.duration.minSec', {
                min: Math.floor(turn.durationMs / 60_000),
                sec: Math.round((turn.durationMs % 60_000) / 1000),
              })
  const statusText = duration ? `${status}${props.t('turn.elapsedSuffix', { duration })}` : status
  const finalNode = members.find((node) => node.id === turn.finalAssistantId)
  const finalText = finalNode?.kind === 'assistant' ? finalNode.text : ''
  const finalThinking = finalNode?.kind === 'assistant' ? finalNode.thinking?.trim() : undefined
  const processCount =
    others.filter(
      (node) => node.id !== turn.finalAssistantId && !isEmptyStreamingAssistant(node) && !attention(node),
    ).length + (finalThinking ? 1 : 0)
  const ordered = [...others].sort((a, b) => {
    const rank = (node: UINode) => (node.id === turn.finalAssistantId ? 2 : attention(node) ? 1 : 0)
    return rank(a) - rank(b)
  })
  const settled = !processActive && Boolean(turn.finalAssistantId)
  return (
    <section
      className="conversation-turn"
      data-testid="conversation-turn"
      data-turn-id={turn.id}
      data-status={turn.status}
      data-inherited={String(turn.inherited)}
    >
      <div className="turn-user">
        {users.map((node) => (
          <Message key={node.id} node={node} props={props} />
        ))}
      </div>
      <div ref={response} className="turn-response">
        <span className="process-identity">
          <span className="process-avatar">
            <span className="agnes-mark process-avatar-mark" aria-hidden="true" />
          </span>
          <span className="process-name">{props.t('brand.harness')}</span>
        </span>
        <p className="turn-status" data-agnes-dynamic="turn-process" hidden={processCount > 0}>
          {statusText}
        </p>
        <details
          ref={details}
          className="turn-process"
          hidden={processCount === 0}
          onToggle={() => {
            const open = details.current?.open ?? false
            preference.current = open
            setProcessOpen(open)
          }}
        >
          <summary data-testid="turn-process-toggle">
            <span className="process-row">
              <span className="process-label" data-agnes-dynamic="turn-process" data-testid="turn-timing">
                {statusText}
              </span>
              <svg className="icon process-chevron" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </summary>
          {finalThinking && thinkingFinalId === turn.finalAssistantId && (
            <div className="turn-process-body">
              <details className="thinking">
                <summary>{props.t('timeline.thinkingSummary')}</summary>
                <div className="thinking-content markdown">
                  {props.renderMarkdown
                    ? props.renderMarkdown(finalThinking, 'thinking', {
                        nodeId: finalNode?.id ?? '',
                        streaming: finalNode ? markdownState(finalNode, turn.status).streaming : false,
                        turnStatus: turn.status,
                      })
                    : finalThinking}
                </div>
              </details>
            </div>
          )}
        </details>
        {turn.status === 'failed' && (
          <p className="turn-error" role="alert">
            {turn.error
              ? props.t('turn.error.codeJoin', { code: turn.error.code, message: turn.error.message })
              : props.t('turn.error.noDetail', {
                  reason: turn.reason ?? props.t('turn.error.unknownReason'),
                })}
          </p>
        )}
        <div className="turn-node-flow">
          {ordered.map((node) => {
            const final = node.id === turn.finalAssistantId
            const needsAttention = attention(node)
            return (
              <div
                key={node.id}
                className={final ? 'turn-final' : needsAttention ? 'turn-attention' : 'turn-process-body'}
                hidden={isEmptyStreamingAssistant(node) || (!final && !needsAttention && !processOpen)}
              >
                <Message
                  node={node}
                  props={props}
                  hideThinking={final && thinkingFinalId === turn.finalAssistantId}
                  turnStatus={turn.status}
                  thinkingHost={
                    node.id === (turn.finalAssistantId ?? latestStreaming?.id) ? thinkingHost : undefined
                  }
                />
              </div>
            )
          })}
        </div>
        {props.renderTurnActions?.(turn, finalText, settled)}
      </div>
    </section>
  )
}
