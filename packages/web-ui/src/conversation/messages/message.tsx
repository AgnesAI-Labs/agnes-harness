import type { UINode, UITurn } from '@agnes/protocol'
import type { ReactNode, RefObject } from 'react'
import { memo, useState } from 'react'
import type { Translate } from '../../locales/index.js'
import { approvalSummary, baseToolTitle } from '../../tool-presentation.js'
import { Button } from '../../ui/button.js'
import { DecisionFields, decisionPresentation } from '../../ui/decision-presentation.js'
import { ConversationCost } from '../cost.js'
import { ActivityIcon, ActivityRow } from './activity-row.js'
import { approvalStatus } from './approval-labels.js'
import { AssistantMessage } from './assistant-message.js'
import { type ApprovalNode, type ConversationMessagesProps, fallbackT } from './context.js'
import { markdownState } from './markdown-state.js'
import { ConversationToolCard, toolOutcome } from './tool-card.js'
import { UserMessage } from './user-message.js'

// How a decided approval reads as a step. Why it ended (timed out, stopped) wins over the verdict.
const APPROVAL_STEP_KEYS: Record<string, string> = {
  'allowed-once': 'activity.approval.allowedOnce',
  'allowed-session': 'activity.approval.allowedSession',
  'allowed-permanent': 'activity.approval.allowedPermanent',
  rejected: 'activity.approval.rejected',
}

/**
 * An approval in the process is one line: what was decided · what it was for. The card that asks
 * for the decision is the approval region; this line is its record in the turn.
 */
function ApprovalStep({ node, t, primaryCard }: { node: ApprovalNode; t: Translate; primaryCard?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const decided = node.state === 'decided' && node.decision
  // Core asking whether a call that lost its result ran is a question of fact, not a permission.
  const reconcile = node.reconcile
  const key =
    !reconcile && decided && !node.decision?.reason
      ? APPROVAL_STEP_KEYS[node.decision?.verdict ?? '']
      : undefined
  const refused = decided && !reconcile && !node.decision?.verdict.startsWith('allowed')
  const presentation = decisionPresentation(node.presentation)
  const summary = reconcile
    ? t('activity.reconcile.summary', { tool: reconcile.tool })
    : (presentation?.title ?? approvalSummary(node, t))
  if (node.state === 'pending' && primaryCard)
    return (
      <Button
        appearance="link"
        className="approval-pending-link"
        href="#approval-content"
        title={summary}
        data-testid="approval-step"
      >
        {approvalStatus(node, t)} · {summary}
      </Button>
    )
  return (
    <>
      <ActivityRow
        className="approval-step"
        testId="approval-step"
        icon={<ActivityIcon name="approval" />}
        verb={<span className="tool-status">{key ? t(key) : approvalStatus(node, t)}</span>}
        target={<span className="approval-summary">{summary}</span>}
        tooltip={summary}
        mono={false}
        state={
          node.state === 'pending'
            ? 'attention'
            : refused || node.state === 'expired'
              ? 'cancelled'
              : undefined
        }
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
      />
      <div className="tool-detail-text approval-detail" hidden={!expanded}>
        {presentation ? (
          <DecisionFields view={presentation} />
        ) : reconcile ? (
          summary
        ) : node.rewrite ? (
          `${node.rewrite.summary}\n\n${node.summary}`
        ) : (
          node.summary
        )}
      </div>
    </>
  )
}

export function nativeContent(
  node: UINode,
  props: Omit<ConversationMessagesProps, 'nodes' | 'turns' | 'visibleNodeIds'>,
  hideThinking = false,
  turnStatus?: UITurn['status'],
  thinkingHost?: RefObject<HTMLDivElement>,
): ReactNode {
  const t = props.t ?? fallbackT
  switch (node.kind) {
    case 'user':
      return <UserMessage node={node} t={t} readAttachment={props.readAttachment} />
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
      return props.renderTool ? (
        props.renderTool(node, turnStatus)
      ) : (
        <ConversationToolCard node={node} t={t} turnStatus={turnStatus} />
      )
    case 'approval':
      return (
        <ApprovalStep node={node} t={t} primaryCard={turnStatus === 'running' || turnStatus === 'waiting'} />
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
    case 'tool-source-pending':
      return (
        <div className="node-body" role="status" data-testid="tool-source-pending-notice">
          {t('timeline.toolSourcePending', { names: node.sources.join(t('timeline.conflictOpsJoiner')) })}
        </div>
      )
    case 'workspace-undo':
      return (
        <div className="node-body" role="status" data-testid="workspace-undo-notice">
          {node.conflicts > 0
            ? t('timeline.workspaceUndoRefused', { turn: node.turn, count: node.conflicts })
            : node.failed > 0
              ? t('timeline.workspaceUndoPartial', {
                  turn: node.turn,
                  restored: node.restored,
                  failed: node.failed,
                })
              : t('timeline.workspaceUndone', { turn: node.turn, count: node.restored })}
        </div>
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

/** A system-origin input with a typed payload renders as a status line, never as a user bubble. */
export function isSystemInput(node: UINode): boolean {
  return node.kind === 'user' && node.origin === 'system' && node.system !== undefined
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

function MessageView({
  node,
  props,
  hideThinking = false,
  turnStatus,
  thinkingHost,
}: {
  node: UINode
  props: Omit<ConversationMessagesProps, 'nodes' | 'turns' | 'visibleNodeIds'>
  hideThinking?: boolean
  turnStatus?: UITurn['status'] | undefined
  thinkingHost?: RefObject<HTMLDivElement> | undefined
}) {
  const content = nativeContent(node, props, hideThinking, turnStatus, thinkingHost)
  const systemInput = isSystemInput(node)
  return (
    <article
      className={`timeline-node ${systemInput ? 'system-input' : node.kind}`}
      data-node-id={node.id}
      data-node-kind={systemInput ? 'system-input' : node.kind}
      hidden={isEmptyStreamingAssistant(node)}
      {...(node.kind === 'assistant'
        ? { 'data-streaming': String(markdownState(node, turnStatus).streaming) }
        : {})}
      {...(node.kind === 'tool'
        ? {
            'data-status': node.status,
            // 无障碍标签要带上工具名：只报状态会让读屏用户听不出是哪次调用。
            'aria-label': props.t('tool.card.aria', {
              name: baseToolTitle(node.name, props.t) ?? node.presentation?.title ?? node.name,
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

export const Message = memo(MessageView)
