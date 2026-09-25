import type { UINode } from '@agnes/protocol'
import { useThread } from '@assistant-ui/react'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationMessage } from './runtime.js'

type AssistantNode = Extract<UINode, { kind: 'assistant' }>
type ToolNode = Extract<UINode, { kind: 'tool' }>
type CostNode = Extract<UINode, { kind: 'cost' }>
type ApprovalNode = Extract<UINode, { kind: 'approval' }>

export interface ConversationMessagesProps {
  renderMarkdown?: (text: string, part: 'thinking' | 'body') => ReactNode
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
const toolLabels: Record<ToolNode['status'], string> = {
  planned: '等待执行',
  awaiting_approval: '等待审批',
  running: '正在执行',
  completed: '执行完成',
  failed: '执行失败',
  cancelled: '已取消',
}
const approvalStatus = (node: ApprovalNode) =>
  node.state === 'decided' && node.decision
    ? (verdictLabels[node.decision.verdict] ?? approvalLabels.decided)
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
  renderMarkdown,
}: {
  node: AssistantNode
  renderMarkdown?: ConversationMessagesProps['renderMarkdown']
}) {
  const active = Boolean(node.thinking?.trim()) && node.streaming === true && node.text.trim() === ''
  const wasActive = useRef(active)
  const initiallyActive = useRef(active)
  const disclosure = useRef<HTMLDetailsElement>(null)
  useLayoutEffect(() => {
    if (disclosure.current && wasActive.current !== active) disclosure.current.open = active
    wasActive.current = active
  }, [active])
  useLayoutEffect(() => {
    if (disclosure.current) disclosure.current.open = initiallyActive.current
  }, [])
  const body =
    node.lostChars !== undefined && !node.text ? `_输出中断，至少 ${node.lostChars} 字未保存_` : node.text
  return (
    <>
      <p className="node-label">Agnes</p>
      <details ref={disclosure} className="thinking" hidden={!node.thinking?.trim()}>
        <summary>深度思考</summary>
        <div className="thinking-content markdown">
          {renderMarkdown ? renderMarkdown(node.thinking ?? '', 'thinking') : node.thinking}
        </div>
      </details>
      <div className="node-body markdown">{renderMarkdown ? renderMarkdown(body, 'body') : body}</div>
    </>
  )
}

function ToolMessage({ node }: { node: ToolNode }) {
  const [expanded, setExpanded] = useState(false)
  const summary = node.summary.trim()
  const remainder = summary.startsWith(node.name) ? summary.slice(node.name.length).trim() : summary
  const meaningful =
    summary && summary !== node.name && remainder && !remainder.startsWith('{') && !remainder.startsWith('[')
  const detail = [
    `工具：${node.name}`,
    `状态：${toolLabels[node.status]}`,
    ...(node.argsPreview ? ['', '执行参数', node.argsPreview] : []),
    ...(node.resultPreview
      ? ['', node.status === 'failed' ? '错误详情' : '执行结果', node.resultPreview]
      : []),
  ].join('\n')
  return (
    <>
      <div className="tool-head">
        <div className="tool-meta">
          <span className="tool-name">{node.name}</span>
          <span className="tool-status">{toolLabels[node.status]}</span>
        </div>
        <button
          type="button"
          className="tool-detail"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起详情' : '查看详情'}
        </button>
      </div>
      {meaningful && <div className="tool-summary">{summary}</div>}
      <div className="tool-detail-body" hidden={!expanded}>
        <div className="tool-detail-text">{detail}</div>
      </div>
    </>
  )
}

function CostMessage({ node }: { node: CostNode }) {
  const source = (value: CostNode['source']) => (value === 'estimated' ? '估算' : '网关记录')
  const credits = (value: number) => value.toFixed(8).replace(/\.?0+$/, '')
  const amount = node.billing
    ? `$${(node.billing.usdMicros / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.00')}（${source(node.billing.source)}）`
    : node.credits === undefined
      ? '费用未提供'
      : `${credits(node.credits)} credits（${source(node.source)}）`
  const summary = [
    ...(node.tokens ? [`输入 ${node.tokens.input}`, `输出 ${node.tokens.output}`] : []),
    amount,
    ...(node.interrupted ? ['已中断'] : []),
  ].join(' · ')
  return (
    <details className="usage-disclosure call-usage">
      <summary aria-label="查看本次调用用量明细">{summary}</summary>
      <dl className="usage-grid">
        <dt>Token 明细</dt>
        <dd>{node.tokens ? `输入 ${node.tokens.input}，输出 ${node.tokens.output}` : '未提供'}</dd>
        <dt>额度</dt>
        <dd>
          {node.credits === undefined
            ? '未提供'
            : `${credits(node.credits)} credits · ${source(node.source)}`}
        </dd>
      </dl>
    </details>
  )
}

function nativeContent(node: UINode, props: ConversationMessagesProps): ReactNode {
  switch (node.kind) {
    case 'user':
      return <UserMessage node={node} />
    case 'assistant':
      return <AssistantMessage node={node} renderMarkdown={props.renderMarkdown} />
    case 'tool':
      return props.renderTool ? props.renderTool(node) : <ToolMessage node={node} />
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
      return props.renderCost ? props.renderCost(node) : <CostMessage node={node} />
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

function Message({ node, props }: { node: UINode; props: ConversationMessagesProps }) {
  const native = nativeContent(node, props)
  return (
    <article
      className={`timeline-node ${node.kind}`}
      data-node-id={node.id}
      data-node-kind={node.kind}
      {...(node.kind === 'assistant' ? { 'data-streaming': String(node.streaming === true) } : {})}
      {...(node.kind === 'tool'
        ? { 'data-status': node.status, 'aria-label': `工具 ${node.name}：${toolLabels[node.status]}` }
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

/** Read-only DOM projection of W3a `metadata.custom.node`; source IDs own React identity. */
export function ConversationMessages(props: ConversationMessagesProps) {
  const messages = useThread((state) => state.messages)
  return (
    <section data-agnes-conversation-messages="">
      {messages.map((message) => {
        const custom = message.metadata.custom as ConversationMessage['metadata']['custom'] | undefined
        const node = custom?.node
        return node && node.kind !== 'context' && node.kind !== 'context-sections' ? (
          <Message key={message.id} node={node} props={props} />
        ) : null
      })}
    </section>
  )
}
