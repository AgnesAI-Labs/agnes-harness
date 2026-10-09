import { markdownState } from './markdown-state.js'
import type { UINode, UITurn } from '@agnes/protocol'
import { type ReactNode, type RefObject, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { ConversationCost } from '../cost.js'
import {
  type ConversationMessagesProps,
  fallbackT,
  registerConversationMessageTargetContext,
  type ConversationMessageContextValue,
} from './context.js'
import { UserMessage } from './user-message.js'
import { AssistantMessage } from './assistant-message.js'
import { ConversationToolCard, toolOutcome } from './tool-card.js'
import { approvalStatus } from './approval-labels.js'

export function nativeContent(
  node: UINode,
  props: ConversationMessagesProps,
  hideThinking = false,
  turnStatus?: UITurn['status'],
  thinkingHost?: RefObject<HTMLDivElement>,
): ReactNode {
  const t = props.t ?? fallbackT
  switch (node.kind) {
    case 'user':
      return <UserMessage node={node} t={t} />
    case 'assistant':
      return (
        <AssistantMessage
          node={node}
          state={markdownState(node, turnStatus)}
          renderMarkdown={props.renderMarkdown}
          hideThinking={hideThinking}
          thinkingHost={thinkingHost}
          t={t}
        />
      )
    case 'tool':
      return props.renderTool ? props.renderTool(node) : <ConversationToolCard node={node} t={t} />
    case 'approval':
      return (
        <>
          <div className="approval-head">
            <span className="node-label">{t('timeline.approvalTitle')}</span>
            <span className="tool-status">{approvalStatus(node, t)}</span>
          </div>
          <div className="approval-summary">{node.summary}</div>
        </>
      )
    case 'cost':
      return props.renderCost ? props.renderCost(node) : <ConversationCost node={node} t={t} />
    case 'artifact':
      return (
        <>
          <p className="node-label">{t('timeline.artifactLabel')}</p>
          <div className="node-body">{node.name}</div>
        </>
      )
    case 'compaction':
      return (
        <>
          <p className="node-label">{t('timeline.compactionLabel')}</p>
          <div className="node-body">
            {node.summary ?? t('timeline.compactionFallback', { range: node.range.join('–') })}
          </div>
        </>
      )
    case 'slot':
      return props.renderSlot ? (
        props.renderSlot(node)
      ) : (
        <div data-slot-state="empty">{t('slot.notReady')}</div>
      )
    case 'ledger-recovery':
      return (
        <div className="node-body" role="status" data-testid="ledger-tail-recovery-notice">
          {t('timeline.ledgerRecovery', { seq: node.validThroughSeq, diagnosticId: node.diagnosticId })}
        </div>
      )
    case 'contribute-conflict':
      return (
        <>
          <p className="node-label">{t('timeline.conflictLabel')}</p>
          <div className="node-body">
            {node.key}
            {t('timeline.conflictJoiner')}
            {node.ops.join(t('timeline.conflictOpsJoiner'))}
          </div>
        </>
      )
    case 'context':
    case 'context-sections':
      return null
  }
}

export function isEmptyStreamingAssistant(node: UINode): boolean {
  return (
    node.kind === 'assistant' &&
    node.streaming === true &&
    !node.text.trim() &&
    !node.thinking?.trim() &&
    node.lostChars === undefined
  )
}

export function Message({
  node,
  props,
  hideThinking = false,
  turnStatus,
  thinkingHost,
}: {
  node: UINode
  props: ConversationMessagesProps
  hideThinking?: boolean
  turnStatus?: UITurn['status'] | undefined
  thinkingHost?: RefObject<HTMLDivElement> | undefined
}) {
  const messageTarget = useRef<HTMLDivElement>(null)
  const registerTarget = useContext(registerConversationMessageTargetContext)
  const native = nativeContent(node, props, hideThinking, turnStatus, thinkingHost)
  const usesAssistantUi = node.kind === 'user' || node.kind === 'assistant'
  const context = useMemo<ConversationMessageContextValue>(
    () => ({
      node,
      props,
      hideThinking,
      ...(turnStatus ? { turnStatus } : {}),
      ...(thinkingHost ? { thinkingHost } : {}),
    }),
    [hideThinking, node, props, thinkingHost, turnStatus],
  )
  useLayoutEffect(() => {
    const element = messageTarget.current
    if (!element || !usesAssistantUi || !registerTarget) return
    registerTarget(node.id, { element, context })
  }, [context, node.id, registerTarget, usesAssistantUi])
  useLayoutEffect(
    () => () => {
      if (usesAssistantUi) registerTarget?.(node.id, undefined)
    },
    [node.id, registerTarget, usesAssistantUi],
  )
  const content = usesAssistantUi ? (
    <>
      <div ref={messageTarget} data-agnes-assistant-ui-target="" />
      <div data-agnes-assistant-ui-fallback="">{native}</div>
    </>
  ) : (
    native
  )
  return (
    <article
      className={`timeline-node ${node.kind}`}
      data-node-id={node.id}
      data-node-kind={node.kind}
      hidden={isEmptyStreamingAssistant(node)}
      {...(node.kind === 'assistant'
        ? { 'data-streaming': String(markdownState(node, turnStatus).streaming) }
        : {})}
      {...(node.kind === 'tool'
        ? {
            'data-status': node.status,
            // 无障碍标签要带上工具名：只报状态会让读屏用户听不出是哪次调用。
            'aria-label': props.t('tool.card.aria', {
              name: node.name,
              status: toolOutcome(node, props.t).label,
            }),
          }
        : {})}
      {...(node.kind === 'approval'
        ? { 'data-state': node.state, 'aria-label': approvalStatus(node, props.t) }
        : {})}
      {...(node.kind === 'contribute-conflict' ? { role: 'note' } : {})}
    >
      {props.renderNode ? props.renderNode(node, content) : content}
    </article>
  )
}
