import type { UINode, UITurn } from '@agnes/protocol'
import { useThread } from '@assistant-ui/react'
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ConversationCost } from './cost.js'
import { useInteractionSnapshot } from './markdown-snapshot.js'
import type { ConversationMessage } from './runtime.js'

type AssistantNode = Extract<UINode, { kind: 'assistant' }>
type ToolNode = Extract<UINode, { kind: 'tool' }>
type CostNode = Extract<UINode, { kind: 'cost' }>
type ApprovalNode = Extract<UINode, { kind: 'approval' }>

export interface ConversationMarkdownState {
  nodeId: string
  streaming: boolean
  turnStatus?: UITurn['status'] | undefined
}

export interface ConversationMessagesProps {
  turns?: readonly UITurn[]
  /** Optional snapshot gate when a host supplies turns and messages through separate subscriptions. */
  visibleNodeIds?: readonly string[]
  renderTurnActions?: (turn: UITurn, finalText: string, settled: boolean) => ReactNode
  renderMarkdown?: (text: string, part: 'thinking' | 'body', state?: ConversationMarkdownState) => ReactNode
  renderTool?: (node: ToolNode) => ReactNode
  renderCost?: (node: CostNode) => ReactNode
  renderSlot?: (node: Extract<UINode, { kind: 'slot' }>) => ReactNode
  /** The upper Web layer owns DSH registration, claims, and fallback visibility. */
  renderNode?: (node: UINode, native: ReactNode) => ReactNode
}

const approvalLabels: Record<ApprovalNode['state'], string> = {
  pending: '需要你确认',
  decided: '审批已处理',
  expired: '审批已过期',
}
const verdictLabels: Record<string, string> = {
  'allowed-once': '仅允许这次',
  'allowed-session': '本会话允许',
  'allowed-permanent': '对此配置始终允许',
  rejected: '已拒绝',
  cancelled: '已取消',
}
/** Why the decision ended as it did. A ledger from before reasons existed has none and falls back to the verdict. */
const reasonLabels: Record<string, string> = {
  user_rejected: '已拒绝',
  timeout: '等待超时，未执行',
  no_approver: '无人审批，未执行',
  stopped: '已停止',
  policy_denied: '被命令策略拦截',
  subagent_scope: '子代理权限范围内，已自动拒绝',
}
const toolLabels: Record<ToolNode['status'], string> = {
  planned: '等待执行',
  awaiting_approval: '等待审批',
  running: '正在执行',
  completed: '执行完成',
  failed: '执行失败',
  cancelled: '已取消',
}
// A shell result ends with `[exit N]`. When the projection marks that call failed, N says why: a
// nonzero exit is the command's own answer, and what it printed is its output, not an error report.
// A result cut before its last line has no marker and keeps the general wording.
const SHELL_EXIT = /\n?\[exit (-?\d+)\](?: \[output truncated by sandbox\])?\s*$/

/** How a tool call's outcome is named and its result introduced, for the card and its detail. */
export function toolOutcome(node: ToolNode): { label: string; section: string; text: string | undefined } {
  const preview = node.resultPreview
  const exit =
    node.name === 'shell' && node.status === 'failed' && preview !== undefined
      ? SHELL_EXIT.exec(preview)
      : null
  if (exit && preview !== undefined)
    return {
      label: `退出码 ${exit[1]}`,
      section: '输出',
      text: preview.slice(0, exit.index).trimEnd() || '（无输出）',
    }
  return {
    label: toolLabels[node.status],
    section: node.status === 'failed' ? '错误详情' : '执行结果',
    text: preview,
  }
}

const approvalStatus = (node: ApprovalNode) =>
  node.state === 'decided' && node.decision
    ? ((node.decision.reason ? reasonLabels[node.decision.reason] : undefined) ??
      verdictLabels[node.decision.verdict] ??
      approvalLabels.decided)
    : approvalLabels[node.state]

function UserMessage({ node }: { node: Extract<UINode, { kind: 'user' }> }) {
  const value = node.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return (
    <>
      <p className="node-label">你</p>
      <div className="node-body">{value}</div>
    </>
  )
}

function AssistantMessage({
  node,
  state,
  renderMarkdown,
  hideThinking = false,
  thinkingHost,
}: {
  node: AssistantNode
  state: ConversationMarkdownState
  renderMarkdown?: ConversationMessagesProps['renderMarkdown']
  hideThinking?: boolean
  thinkingHost?: RefObject<HTMLDivElement> | undefined
}) {
  const active = Boolean(node.thinking?.trim()) && state.streaming && node.text.trim() === ''
  const wasActive = useRef(active)
  const initiallyActive = useRef(active)
  const disclosure = useRef<HTMLDetailsElement>(null)
  const shownActive = useInteractionSnapshot(disclosure, active)
  const shownThinking = useInteractionSnapshot(disclosure, Boolean(node.thinking?.trim()))
  useLayoutEffect(() => {
    if (disclosure.current && wasActive.current !== shownActive) disclosure.current.open = shownActive
    wasActive.current = shownActive
  }, [shownActive])
  useLayoutEffect(() => {
    if (disclosure.current) disclosure.current.open = initiallyActive.current
  }, [])
  const body =
    node.lostChars !== undefined && !node.text ? `_输出中断，至少 ${node.lostChars} 字未保存_` : node.text
  return (
    <>
      <p className="node-label">Agnes</p>
      {!hideThinking && (
        <details ref={disclosure} className="thinking" hidden={!shownThinking}>
          <summary>深度思考</summary>
          <div ref={thinkingHost} className="thinking-content markdown">
            {renderMarkdown ? renderMarkdown(node.thinking ?? '', 'thinking', state) : node.thinking}
          </div>
        </details>
      )}
      <div key="body" className="node-body markdown">
        {renderMarkdown ? renderMarkdown(body, 'body', state) : body}
      </div>
    </>
  )
}

export function ConversationToolCard({
  node,
  icon,
  onExpandedChange,
}: {
  node: ToolNode
  icon?: ReactNode
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const cardHost = useRef<HTMLDivElement>(null)
  const detailHost = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const article = cardHost.current?.closest<HTMLElement>('.timeline-node.tool')
    if (article && (expanded || article.dataset.expanded !== undefined))
      article.dataset.expanded = String(expanded)
  }, [expanded])
  const summary = node.summary.trim()
  const remainder = summary.startsWith(node.name) ? summary.slice(node.name.length).trim() : summary
  const meaningful =
    summary && summary !== node.name && remainder && !remainder.startsWith('{') && !remainder.startsWith('[')
  const outcome = toolOutcome(node)
  const nextDetail = [
    `工具：${node.name}`,
    `状态：${outcome.label}`,
    ...(node.argsPreview ? ['', '执行参数', node.argsPreview] : []),
    ...(outcome.text ? ['', outcome.section, outcome.text] : []),
  ].join('\n')
  const detail = useInteractionSnapshot(detailHost, nextDetail)
  return (
    <div
      ref={cardHost}
      data-agnes-tool-card=""
      data-status={node.status}
      data-expanded={expanded ? 'true' : undefined}
    >
      <div className="tool-head">
        <div className="tool-meta">
          {icon}
          <span className="tool-name">{node.name}</span>
          <span className="tool-status">{outcome.label}</span>
        </div>
        <button
          type="button"
          className="tool-detail"
          aria-expanded={expanded}
          onClick={() => {
            const next = !expanded
            onExpandedChange?.(next)
            flushSync(() => setExpanded(next))
          }}
        >
          {expanded ? '收起详情' : '查看详情'}
        </button>
      </div>
      <div className="tool-summary" hidden={!meaningful}>
        {meaningful ? summary : ''}
      </div>
      <div className="tool-detail-body">
        <div className="tool-detail-inner">
          <div ref={detailHost} className="tool-detail-text">
            {detail}
          </div>
        </div>
      </div>
    </div>
  )
}

function markdownState(node: UINode, turnStatus?: UITurn['status']): ConversationMarkdownState {
  return {
    nodeId: node.id,
    streaming:
      node.kind === 'assistant' &&
      node.streaming === true &&
      (turnStatus === undefined || turnStatus === 'running' || turnStatus === 'waiting'),
    ...(turnStatus ? { turnStatus } : {}),
  }
}

function nativeContent(
  node: UINode,
  props: ConversationMessagesProps,
  hideThinking = false,
  turnStatus?: UITurn['status'],
  thinkingHost?: RefObject<HTMLDivElement>,
): ReactNode {
  switch (node.kind) {
    case 'user':
      return <UserMessage node={node} />
    case 'assistant':
      return (
        <AssistantMessage
          node={node}
          state={markdownState(node, turnStatus)}
          renderMarkdown={props.renderMarkdown}
          hideThinking={hideThinking}
          thinkingHost={thinkingHost}
        />
      )
    case 'tool':
      return props.renderTool ? props.renderTool(node) : <ConversationToolCard node={node} />
    case 'approval':
      return (
        <>
          <div className="approval-head">
            <span className="node-label">审批</span>
            <span className="tool-status">{approvalStatus(node)}</span>
          </div>
          <div className="approval-summary">{node.summary}</div>
        </>
      )
    case 'cost':
      return props.renderCost ? props.renderCost(node) : <ConversationCost node={node} />
    case 'artifact':
      return (
        <>
          <p className="node-label">产物</p>
          <div className="node-body">{node.name}</div>
        </>
      )
    case 'compaction':
      return (
        <>
          <p className="node-label">上下文整理</p>
          <div className="node-body">{node.summary ?? `已整理上下文（范围：${node.range.join('–')}）`}</div>
        </>
      )
    case 'slot':
      return props.renderSlot ? props.renderSlot(node) : <div data-slot-state="empty">此卡片的插件未就绪</div>
    case 'contribute-conflict':
      return (
        <>
          <p className="node-label">上下文配置冲突</p>
          <div className="node-body">
            {node.key}：{node.ops.join('、')}
          </div>
        </>
      )
    case 'context':
    case 'context-sections':
      return null
  }
}

function isEmptyStreamingAssistant(node: UINode): boolean {
  return (
    node.kind === 'assistant' &&
    node.streaming === true &&
    !node.text.trim() &&
    !node.thinking?.trim() &&
    node.lostChars === undefined
  )
}

function Message({
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
  const native = nativeContent(node, props, hideThinking, turnStatus, thinkingHost)
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
        ? { 'data-status': node.status, 'aria-label': `工具 ${node.name}：${toolOutcome(node).label}` }
        : {})}
      {...(node.kind === 'approval'
        ? { 'data-state': node.state, 'aria-label': `审批：${approvalStatus(node)}` }
        : {})}
      {...(node.kind === 'contribute-conflict' ? { role: 'note' } : {})}
    >
      {props.renderNode ? props.renderNode(node, native) : native}
    </article>
  )
}

const turnStatus: Record<UITurn['status'], string> = {
  running: '正在执行',
  waiting: '等待处理',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
}

function Turn({
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
  const pendingApproval = others.some((node) => node.kind === 'approval' && node.state === 'pending')
  const awaitingToolApproval = others.some(
    (node) => node.kind === 'tool' && node.status === 'awaiting_approval',
  )
  const runningTool = others.some((node) => node.kind === 'tool' && node.status === 'running')
  const latestStreaming = others
    .filter((node): node is AssistantNode => node.kind === 'assistant' && node.streaming === true)
    .sort((a, b) => b.seq - a.seq)[0]
  let status = turnStatus[turn.status]
  if (processActive) {
    if (pendingApproval || awaitingToolApproval) status = '等待审批'
    else if (turn.status === 'waiting') status = '等待处理'
    else if (runningTool) status = '正在执行工具'
    else if (latestStreaming?.text.trim()) status = '正在回复'
    else if (latestStreaming?.thinking?.trim()) status = '正在思考'
    else status = '正在准备回复'
  }
  const startedAt = Date.parse(turn.startedAt)
  const duration =
    active && Number.isFinite(startedAt)
      ? `${Math.floor(Math.max(0, now - startedAt) / 1000)} 秒`
      : turn.durationMs === undefined
        ? undefined
        : turn.durationMs < 1000
          ? `${turn.durationMs} 毫秒`
          : turn.durationMs < 60_000
            ? `${(turn.durationMs / 1000).toFixed(turn.durationMs < 10_000 ? 1 : 0)} 秒`
            : `${Math.floor(turn.durationMs / 60_000)} 分 ${Math.round((turn.durationMs % 60_000) / 1000)} 秒`
  const statusText = `${status}${duration ? ` · 用时 ${duration}` : ''}`
  const finalNode = members.find((node) => node.id === turn.finalAssistantId)
  const finalText = finalNode?.kind === 'assistant' ? finalNode.text : ''
  const finalThinking = finalNode?.kind === 'assistant' ? finalNode.thinking?.trim() : undefined
  const processCount =
    others.filter(
      (node) =>
        node.id !== turn.finalAssistantId &&
        !isEmptyStreamingAssistant(node) &&
        !(node.kind === 'approval' && node.state === 'pending'),
    ).length + (finalThinking ? 1 : 0)
  const ordered = [...others].sort((a, b) => {
    const rank = (node: UINode) =>
      node.id === turn.finalAssistantId ? 2 : node.kind === 'approval' && node.state === 'pending' ? 1 : 0
    return rank(a) - rank(b)
  })
  const settled = !processActive && Boolean(turn.finalAssistantId)
  return (
    <section
      className="conversation-turn"
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
          <span className="process-name">Agnes Harness</span>
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
          <summary>
            <span className="process-row">
              <span className="process-label" data-agnes-dynamic="turn-process">
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
                <summary>深度思考</summary>
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
              ? `${turn.error.code}：${turn.error.message}`
              : `本次执行未完成（${turn.reason ?? '未知原因'}），暂未收到具体错误信息。`}
          </p>
        )}
        <div className="turn-node-flow">
          {ordered.map((node) => {
            const final = node.id === turn.finalAssistantId
            const attention = node.kind === 'approval' && node.state === 'pending'
            return (
              <div
                key={node.id}
                className={final ? 'turn-final' : attention ? 'turn-attention' : 'turn-process-body'}
                hidden={isEmptyStreamingAssistant(node) || (!final && !attention && !processOpen)}
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

/** Read-only DOM projection of W3a `metadata.custom.node`; source IDs own React identity. */
export function ConversationMessages(props: ConversationMessagesProps) {
  const messages = useThread((state) => state.messages)
  const visible = props.visibleNodeIds ? new Set(props.visibleNodeIds) : undefined
  const nodes = new Map<string, UINode>()
  for (const message of messages) {
    const custom = message.metadata.custom as ConversationMessage['metadata']['custom'] | undefined
    const node = custom?.node
    if (
      node &&
      (!visible || visible.has(message.id)) &&
      node.kind !== 'context' &&
      node.kind !== 'context-sections'
    )
      nodes.set(message.id, node)
  }
  if (props.turns?.length) {
    const assigned = new Set(props.turns.flatMap((turn) => turn.nodeIds))
    const ownerByNodeId = new Map(
      props.turns.flatMap((turn) => turn.nodeIds.map((id) => [id, turn.id] as const)),
    )
    return (
      <section data-agnes-conversation-messages="">
        {props.turns.map((turn) => (
          <Turn key={turn.id} turn={turn} nodes={nodes} ownerByNodeId={ownerByNodeId} props={props} />
        ))}
        <section className="timeline-unassigned" hidden={[...nodes.keys()].every((id) => assigned.has(id))}>
          {[...nodes]
            .filter(([id]) => !assigned.has(id))
            .map(([id, node]) => (
              <Message key={id} node={node} props={props} />
            ))}
        </section>
      </section>
    )
  }
  return (
    <section data-agnes-conversation-messages="">
      {messages.map((message) => {
        if (visible && !visible.has(message.id)) return null
        const custom = message.metadata.custom as ConversationMessage['metadata']['custom'] | undefined
        const node = custom?.node
        return node && node.kind !== 'context' && node.kind !== 'context-sections' ? (
          <Message key={message.id} node={node} props={props} turnStatus={custom?.turnStatus} />
        ) : null
      })}
    </section>
  )
}
