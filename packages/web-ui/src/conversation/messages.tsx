import type { ContentBlock, UINode, UITurn } from '@agnes/protocol'
import { decodeSafeImage, USER_MESSAGE_IMAGE_LIMITS } from '@agnes/protocol-validation'
import { MessagePrimitive, ThreadPrimitive, useAssistantState, useThread } from '@assistant-ui/react'
import { Image } from 'antd'
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { Translate } from '../locales/index.js'
import { ConversationCost } from './cost.js'
import { interactionToolPresentation } from './interaction-result.js'
import { useInteractionSnapshot } from './markdown-snapshot.js'
import type { ConversationMessage } from './runtime.js'

type AssistantNode = Extract<UINode, { kind: 'assistant' }>
type ToolNode = Extract<UINode, { kind: 'tool' }>
type CostNode = Extract<UINode, { kind: 'cost' }>
type ApprovalNode = Extract<UINode, { kind: 'approval' }>

/** 组件未拿到宿主注入时的兜底：显示 key 本身，让漏接线在界面上可见。 */
const fallbackT: Translate = (key) => key

export interface ConversationMarkdownState {
  nodeId: string
  streaming: boolean
  turnStatus?: UITurn['status'] | undefined
}

export interface ConversationMessagesProps {
  /** Locale-bound translate injected by the host; called during render, never cached. */
  t: Translate
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
  /** Host-owned interactive cards and deliverables can stay outside collapsed process history. */
  keepNodeVisible?: (node: UINode) => boolean
}

type ConversationMessageContextValue = {
  node: UINode
  props: ConversationMessagesProps
  hideThinking: boolean
  turnStatus?: UITurn['status']
  thinkingHost?: RefObject<HTMLDivElement>
}
// A shell result ends with `[exit N]`. When the projection marks that call failed, N says why: a
// nonzero exit is the command's own answer, and what it printed is its output, not an error report.
// A result cut before its last line has no marker and keeps the general wording.
const SHELL_EXIT = /\n?\[exit (-?\d+)\](?: \[output truncated by sandbox\])?\s*$/
/** How a tool call's outcome is named and its result introduced, for the card and its detail. */
export function toolOutcome(
  node: ToolNode,
  t: Translate = fallbackT,
): { label: string; section: string; text: string | undefined } {
  const preview = node.resultPreview
  const exit =
    node.name === 'shell' && node.status === 'failed' && preview !== undefined
      ? SHELL_EXIT.exec(preview)
      : null
  if (exit && preview !== undefined)
    return {
      label: t('tool.status.exitCode', { code: Number(exit[1]) }),
      section: t('tool.detail.result'),
      text: preview.slice(0, exit.index).trimEnd() || t('tool.detail.noOutput'),
    }
  return {
    label: t(toolLabelKeys[node.status]),
    section: t(node.status === 'failed' ? 'tool.detail.error' : 'tool.detail.result'),
    text: preview,
  }
}

const ConversationMessageContext = createContext<ConversationMessageContextValue | null>(null)

type ConversationMessageTarget = {
  element: HTMLDivElement
  context: ConversationMessageContextValue
}

type ConversationMessageTargetContextValue = {
  targets: ReadonlyMap<string, ConversationMessageTarget>
  version: number
}

const ConversationMessageTargetContext = createContext<ConversationMessageTargetContextValue | null>(null)
const registerConversationMessageTargetContext = createContext<
  ((id: string, target: ConversationMessageTarget | undefined) => void) | null
>(null)

const approvalLabelKeys: Record<ApprovalNode['state'], string> = {
  pending: 'timeline.approval.pending',
  decided: 'timeline.approval.decided',
  expired: 'timeline.approval.expired',
}
const verdictLabelKeys: Record<string, string> = {
  'allowed-once': 'timeline.decision.allowedOnce',
  'allowed-session': 'timeline.decision.allowedSession',
  'allowed-permanent': 'timeline.decision.allowedPermanent',
  rejected: 'timeline.decision.rejected',
  cancelled: 'timeline.decision.cancelled',
}
/** Why the decision ended as it did. A ledger from before reasons existed has none and falls back to the verdict. */
const reasonLabelKeys: Record<string, string> = {
  user_rejected: 'timeline.reason.userRejected',
  timeout: 'timeline.reason.timeout',
  no_approver: 'timeline.reason.noApprover',
  stopped: 'timeline.reason.stopped',
  policy_denied: 'timeline.reason.policyDenied',
  subagent_scope: 'timeline.reason.subagentScope',
}
const toolLabelKeys: Record<ToolNode['status'], string> = {
  planned: 'tool.status.planned',
  awaiting_approval: 'tool.status.awaitingApproval',
  running: 'tool.status.running',
  completed: 'tool.status.completed',
  failed: 'tool.status.failed',
  cancelled: 'tool.status.cancelled',
}
const approvalStatus = (node: ApprovalNode, t: Translate) =>
  node.state === 'decided' && node.decision
    ? (() => {
        const key =
          (node.decision.reason ? reasonLabelKeys[node.decision.reason] : undefined) ??
          verdictLabelKeys[node.decision.verdict]
        return key === undefined ? t(approvalLabelKeys.decided) : t(key)
      })()
    : t(approvalLabelKeys[node.state])

/** 缩略图固定 72×56，和输入框里的待发图片同尺寸：图片不再按原图比例把消息撑长。 */
const USER_MESSAGE_IMAGE_THUMBNAIL = { width: 72, height: 56 } as const

/** 历史消息里的图片按服务端同一套预算重新判一遍，超出的一张只显示占位说明。 */
function imageBlobBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function UserMessageImage({
  image,
  index,
  allowed,
  t,
}: {
  image: Extract<ContentBlock, { type: 'image' }>
  index: number
  allowed: boolean
  t: Translate
}) {
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [unavailable, setUnavailable] = useState(false)
  const { data, mimeType } = image
  useEffect(() => {
    if (!allowed) {
      setUnavailable(true)
      return
    }
    let url: string
    try {
      const decoded = decodeSafeImage({ data, mimeType }, USER_MESSAGE_IMAGE_LIMITS)
      url = URL.createObjectURL(new Blob([imageBlobBytes(decoded.bytes)], { type: decoded.mime }))
      setPreviewUrl(url)
      setUnavailable(false)
    } catch {
      setUnavailable(true)
      return
    }
    return () => URL.revokeObjectURL(url)
  }, [allowed, data, mimeType])

  if (unavailable)
    return (
      <span className="user-message-image-unavailable" role="status">
        {t('conversation.imageUnavailable')}
      </span>
    )
  if (!previewUrl) return null
  // antd 的 Image 自带点击放大预览（缩放、旋转、多图左右切换），比自绘弹层省事。
  return (
    <Image
      className="user-message-image"
      src={previewUrl}
      alt={t('conversation.imageAlt', { index: index + 1 })}
      width={USER_MESSAGE_IMAGE_THUMBNAIL.width}
      height={USER_MESSAGE_IMAGE_THUMBNAIL.height}
    />
  )
}

/**
 * 一条用户消息的全部内联图片。原生兜底与 assistant-ui 门户是两棵各渲染一份的 DOM：
 * 门户负责可见内容，兜底只是 CSS 隐藏的备份，两条路径都要带上图片，否则门户一份只剩文字。
 */
function UserMessageImages({ node, t }: { node: Extract<UINode, { kind: 'user' }>; t: Translate }) {
  const images = node.content.filter((block) => block.type === 'image')
  if (images.length === 0) return null
  let imageBytes = 0
  // 同一条消息里可以粘贴重复的图片：内容摘要相同就靠出现次数区分 key，否则 React 会认成同一张。
  const imageKeys = new Map<string, number>()
  return (
    // 同一条消息的图片归到一个预览组：点开大图后能用左右箭头在几张之间翻。
    <Image.PreviewGroup>
      <div className="user-message-images">
        {images.map((block, index) => {
          const decodedLength =
            Math.floor((block.data.length * 3) / 4) -
            (block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0)
          const allowed =
            decodedLength > 0 &&
            decodedLength <= USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage &&
            imageBytes + decodedLength <= USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes
          if (allowed) imageBytes += decodedLength
          const imageKey = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 16)}:${block.data.slice(-16)}`
          const occurrence = imageKeys.get(imageKey) ?? 0
          imageKeys.set(imageKey, occurrence + 1)
          return (
            <UserMessageImage
              key={`${imageKey}:${occurrence}`}
              image={block}
              index={index}
              allowed={allowed}
              t={t}
            />
          )
        })}
      </div>
    </Image.PreviewGroup>
  )
}

function UserMessage({ node, t }: { node: Extract<UINode, { kind: 'user' }>; t: Translate }) {
  const value = node.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return (
    <>
      <p className="node-label">{t('timeline.userLabel')}</p>
      <UserMessageImages node={node} t={t} />
      <UserMessageFiles node={node} />
      <div className="node-body">{value}</div>
    </>
  )
}

function UserMessageFiles({ node }: { node: Extract<UINode, { kind: 'user' }> }) {
  const files = node.content.filter((block) => block.type === 'file')
  if (files.length === 0) return null
  const occurrences = new Map<string, number>()
  return (
    <ul className="user-message-files">
      {files.map((file) => {
        const key = `${file.name}:${file.mimeType}:${file.data.length}`
        const occurrence = occurrences.get(key) ?? 0
        occurrences.set(key, occurrence + 1)
        return (
          <li key={`${key}:${occurrence}`} title={file.name}>
            <span>{file.name}</span>
            <small>{file.mimeType}</small>
          </li>
        )
      })}
    </ul>
  )
}

function AssistantMessage({
  node,
  state,
  renderMarkdown,
  hideThinking = false,
  thinkingHost,
  t,
}: {
  node: AssistantNode
  state: ConversationMarkdownState
  renderMarkdown?: ConversationMessagesProps['renderMarkdown']
  hideThinking?: boolean
  thinkingHost?: RefObject<HTMLDivElement> | undefined
  t: Translate
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
    node.lostChars !== undefined && !node.text
      ? t('timeline.lostOutput', { count: node.lostChars })
      : node.text
  return (
    <>
      <p className="node-label">Agnes</p>
      {!hideThinking && (
        <details ref={disclosure} className="thinking" hidden={!shownThinking}>
          <summary>{t('timeline.thinkingSummary')}</summary>
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

function UserTextPart({ text }: { text: string }) {
  return (
    <div
      className="node-body aui:mt-0 aui:rounded-none aui:border-0 aui:bg-transparent aui:p-0 aui:text-sm aui:leading-5 aui:text-[var(--agnes-text-primary)]"
      data-assistant-ui-part="text"
    >
      {text}
    </div>
  )
}

function AssistantTextPart({ text }: { text: string }) {
  const context = useContext(ConversationMessageContext)
  const node = context?.node
  const t = context?.props.t ?? fallbackT
  const source =
    node?.kind === 'assistant' && node.lostChars !== undefined && !node.text
      ? t('timeline.lostOutput', { count: node.lostChars })
      : text
  const state = node ? markdownState(node, context?.turnStatus) : undefined
  return (
    <div className="node-body markdown" data-assistant-ui-part="text">
      {context?.props.renderMarkdown ? context.props.renderMarkdown(source, 'body', state) : source}
    </div>
  )
}

function AssistantReasoningPart({ text }: { text: string }) {
  const context = useContext(ConversationMessageContext)
  const node = context?.node
  const assistant = node?.kind === 'assistant' ? node : undefined
  const state = assistant ? markdownState(assistant, context?.turnStatus) : undefined
  const active = Boolean(text.trim()) && Boolean(state?.streaming) && !assistant?.text.trim()
  const wasActive = useRef(active)
  const initiallyActive = useRef(active)
  const disclosure = useRef<HTMLDetailsElement>(null)
  const shownActive = useInteractionSnapshot(disclosure, active)
  const shownThinking = useInteractionSnapshot(disclosure, Boolean(text.trim()))
  useLayoutEffect(() => {
    if (disclosure.current && wasActive.current !== shownActive) disclosure.current.open = shownActive
    wasActive.current = shownActive
  }, [shownActive])
  useLayoutEffect(() => {
    if (disclosure.current) disclosure.current.open = initiallyActive.current
  }, [])
  if (!context || !assistant || context.hideThinking) return null
  const t = context.props.t ?? fallbackT
  return (
    <details ref={disclosure} className="thinking" data-assistant-ui-part="reasoning" hidden={!shownThinking}>
      <summary>{t('timeline.thinkingSummary')}</summary>
      <div ref={context.thinkingHost} className="thinking-content markdown">
        {context.props.renderMarkdown ? context.props.renderMarkdown(text, 'thinking', state) : text}
      </div>
    </details>
  )
}

const userMessageParts = { Text: UserTextPart }
const assistantMessageParts = { Text: AssistantTextPart, Reasoning: AssistantReasoningPart }

// Adapt the v0.11.27 registry message shells while leaving Agnes turn actions in their existing owner.
function ConversationMessageView() {
  const context = useContext(ConversationMessageContext)
  if (!context) return null
  const { node, props, hideThinking, turnStatus, thinkingHost } = context
  const t = props.t ?? fallbackT
  const native = nativeContent(node, props, hideThinking, turnStatus, thinkingHost)
  const className =
    node.kind === 'user'
      ? 'aui-user-message-root aui:mx-auto aui:grid aui:w-full aui:auto-rows-auto aui:grid-cols-[minmax(72px,1fr)_auto] aui:gap-y-2 aui:px-2'
      : node.kind === 'assistant'
        ? 'aui-assistant-message-root aui:relative aui:mx-auto aui:flex aui:w-full aui:flex-col aui:items-start'
        : undefined

  return (
    <MessagePrimitive.Root
      {...(className ? { className } : {})}
      {...(node.kind === 'user' || node.kind === 'assistant'
        ? { 'data-agnes-assistant-ui-message': node.kind }
        : {})}
    >
      {node.kind === 'user' ? (
        <div
          data-slot="user-message"
          className="aui-user-message-content-wrapper aui:relative aui:col-start-2 aui:min-w-0"
        >
          <div className="aui-user-message-content aui:rounded-3xl aui:border aui:border-[var(--agnes-line-primary)] aui:bg-[var(--agnes-bg-card)] aui:px-5 aui:py-2.5 aui:text-sm aui:leading-relaxed aui:text-[var(--agnes-text-primary)]">
            <p className="node-label">{t('timeline.userLabel')}</p>
            <UserMessageImages node={node} t={t} />
            <UserMessageFiles node={node} />
            <MessagePrimitive.Parts components={userMessageParts} />
          </div>
        </div>
      ) : node.kind === 'assistant' ? (
        <>
          <p className="node-label">Agnes</p>
          <div className="aui-assistant-message-content aui:mx-2 aui:self-stretch aui:min-w-0 aui:min-h-[4.25rem] aui:text-sm aui:leading-relaxed aui:text-[var(--agnes-text-primary)]">
            <MessagePrimitive.Parts components={assistantMessageParts} />
          </div>
        </>
      ) : (
        native
      )}
    </MessagePrimitive.Root>
  )
}

function AssistantUiMessagePortal() {
  const id = useAssistantState(({ message }) => message.id)
  const targetContext = useContext(ConversationMessageTargetContext)
  const target = targetContext?.targets.get(id)
  const isAgnesMessage = target?.context.node.kind === 'user' || target?.context.node.kind === 'assistant'

  useLayoutEffect(() => {
    if (!target || !isAgnesMessage) return
    target.element.dataset.agnesAssistantUiReady = 'true'
    return () => {
      delete target.element.dataset.agnesAssistantUiReady
    }
  }, [target, isAgnesMessage])

  if (!target || !isAgnesMessage) return null
  return createPortal(
    <ConversationMessageContext.Provider value={target.context}>
      <ConversationMessageView />
    </ConversationMessageContext.Provider>,
    target.element,
    id,
  )
}

const assistantUiMessageComponents = { Message: AssistantUiMessagePortal }

export function ConversationToolCard({
  node,
  icon,
  onExpandedChange,
  presentation,
  t = fallbackT,
}: {
  node: ToolNode
  icon?: ReactNode
  onExpandedChange?: (expanded: boolean) => void
  presentation?: { name: string; summary: string } | undefined
  t?: Translate
}) {
  const [expanded, setExpanded] = useState(false)
  const cardHost = useRef<HTMLDivElement>(null)
  const detailHost = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const article = cardHost.current?.closest<HTMLElement>('.timeline-node.tool')
    if (article && (expanded || article.dataset.expanded !== undefined))
      article.dataset.expanded = String(expanded)
  }, [expanded])
  const interaction = presentation ?? interactionToolPresentation(node, t)
  const summary = interaction?.summary ?? node.summary.trim()
  const remainder = summary.startsWith(node.name) ? summary.slice(node.name.length).trim() : summary
  const meaningful =
    summary && summary !== node.name && remainder && !remainder.startsWith('{') && !remainder.startsWith('[')
  const outcome = toolOutcome(node, t)
  const nextDetail = [
    t('tool.detail.header', { name: node.name }),
    t('tool.detail.status', { status: outcome.label }),
    ...(node.argsPreview ? ['', t('tool.detail.args'), node.argsPreview] : []),
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
          <span className="tool-name">{interaction?.name ?? node.name}</span>
          <span className="tool-status">{outcome.label}</span>
        </div>
        <button
          type="button"
          className="tool-detail"
          data-testid="tool-detail-toggle"
          aria-expanded={expanded}
          onClick={() => {
            const next = !expanded
            onExpandedChange?.(next)
            flushSync(() => setExpanded(next))
          }}
        >
          {expanded ? t('tool.detail.collapse') : t('tool.detail.expand')}
        </button>
      </div>
      <div className="tool-summary" hidden={!meaningful}>
        {meaningful ? summary : ''}
      </div>
      <div className="tool-detail-body">
        <div className="tool-detail-inner">
          <div ref={detailHost} className="tool-detail-text" data-testid="tool-detail-text">
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

const TURN_STATUS_KEYS: Record<UITurn['status'], string> = {
  running: 'turn.status.running',
  waiting: 'turn.status.waiting',
  completed: 'turn.status.completed',
  failed: 'turn.status.failed',
  cancelled: 'turn.status.cancelled',
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
          <summary data-testid="turn-process-toggle">
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

/** Read-only DOM projection of `metadata.custom.node`; source IDs own React identity. */
export function ConversationMessages(props: ConversationMessagesProps) {
  const messages = useThread((state) => state.messages)
  const targetsRef = useRef(new Map<string, ConversationMessageTarget>())
  const [targetVersion, setTargetVersion] = useState(0)
  const registerMessageTarget = useCallback((id: string, target: ConversationMessageTarget | undefined) => {
    const current = targetsRef.current.get(id)
    if (!target) {
      if (!current) return
      targetsRef.current.delete(id)
      setTargetVersion((version) => version + 1)
      return
    }
    if (
      current?.element === target.element &&
      current.context.node === target.context.node &&
      current.context.props === target.context.props &&
      current.context.hideThinking === target.context.hideThinking &&
      current.context.turnStatus === target.context.turnStatus &&
      current.context.thinkingHost === target.context.thinkingHost
    )
      return
    targetsRef.current.set(id, target)
    setTargetVersion((version) => version + 1)
  }, [])
  const targetContext = useMemo<ConversationMessageTargetContextValue>(
    () => ({ targets: targetsRef.current, version: targetVersion }),
    [targetVersion],
  )
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
      <ConversationMessageTargetContext.Provider value={targetContext}>
        <registerConversationMessageTargetContext.Provider value={registerMessageTarget}>
          <section data-agnes-conversation-messages="">
            <ThreadPrimitive.Messages components={assistantUiMessageComponents} />
            {props.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} nodes={nodes} ownerByNodeId={ownerByNodeId} props={props} />
            ))}
            <section
              className="timeline-unassigned"
              hidden={[...nodes.keys()].every((id) => assigned.has(id))}
            >
              {[...nodes]
                .filter(([id]) => !assigned.has(id))
                .map(([id, node]) => (
                  <Message key={id} node={node} props={props} />
                ))}
            </section>
          </section>
        </registerConversationMessageTargetContext.Provider>
      </ConversationMessageTargetContext.Provider>
    )
  }
  return (
    <ConversationMessageTargetContext.Provider value={targetContext}>
      <registerConversationMessageTargetContext.Provider value={registerMessageTarget}>
        <section data-agnes-conversation-messages="">
          <ThreadPrimitive.Messages components={assistantUiMessageComponents} />
          {messages.map((message) => {
            if (visible && !visible.has(message.id)) return null
            const custom = message.metadata.custom as ConversationMessage['metadata']['custom'] | undefined
            const node = custom?.node
            return node && node.kind !== 'context' && node.kind !== 'context-sections' ? (
              <Message key={message.id} node={node} props={props} turnStatus={custom?.turnStatus} />
            ) : null
          })}
        </section>
      </registerConversationMessageTargetContext.Provider>
    </ConversationMessageTargetContext.Provider>
  )
}
