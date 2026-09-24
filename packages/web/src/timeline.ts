import type { UINode, UITurn } from '@agnes/protocol'
import {
  type ClientResourceService,
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import { createConversationToolCard } from '@agnes/web-units'
import { createElement, useLayoutEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { getSlotCardContext, mountSlotCard } from './client-modules/timeline-slot.js'
import { isConversationNode } from './conversation-visibility.js'
import { createMarkdownRenderer } from './markdown.js'
import { toolIcon } from './tool-icon.js'
import { createTurnProjector } from './turns.js'
import { createCostDetails } from './usage.js'

export type TimelineRendererOptions = {
  /** Node entries are owned and ordered inside this content container. */
  transcript: HTMLElement
  /** Optional scrolling viewport around the content container. */
  scrollContainer?: HTMLElement
  newContentButton: HTMLButtonElement
  onFork?: (turn: UITurn) => Promise<void>
  /** Optional DSH registry used to project keyed conversation node renderers. */
  registry?: SlotRegistry
  session?: SessionService
  locale?: LocaleService
  resources?: ClientResourceService
}

/** Whether older records exist before the loaded window, and how to load a page of them. */
export type TimelineMeta = { hasEarlier: boolean; loadEarlier?: () => void }

export type TimelineRenderer = {
  render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TimelineMeta): void
  reset(): void
  dispose?(): void
  /** 程序化贴底（瞬时、不计为用户滚动）。会话区外的布局变化（审批卡显隐）后由宿主调用。 */
  pinToBottom(): void
}

type UserNode = Extract<UINode, { kind: 'user' }>
type ApprovalNode = Extract<UINode, { kind: 'approval' }>

type TextRef = { element: HTMLElement; node: Text; value: string }

type Entry = {
  kind: UINode['kind']
  element: HTMLElement
  thinking?: HTMLDetailsElement
  fingerprint: string
  update(node: UINode): void
  /**
   * 把思考块放回自己的 article。
   * 回合投影会把「最后一个思考」临时搬进过程折叠（见 `turns.ts`），所以每条渲染路径都要先
   * 恢复归属再分发：否则无回合分组、游离节点或回合被撤下时，思考会留在旧容器里丢掉。
   */
  rehome?: () => void
  dispose?(): void
  dshNode?: DshNodeMount | undefined
}

type DshNodeMount = {
  update(node: UINode): void
  dispose(): void
}

const APPROVAL_LABEL: Record<ApprovalNode['state'], string> = {
  pending: '需要你确认',
  decided: '审批已处理',
  expired: '审批已过期',
}
const APPROVAL_DECISION_LABEL = new Map<string, string>([
  ['allowed-once', '仅允许这次'],
  ['allowed-session', '本会话允许'],
  ['allowed-permanent', '对此配置始终允许'],
  ['rejected', '已拒绝'],
  ['cancelled', '已取消'],
])

const textContent = (node: UserNode): string =>
  node.content
    .filter(
      (block): block is Extract<(typeof node.content)[number], { type: 'text' }> => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')

/** What an assistant node says; an attempt whose streamed text died with its process says so. */
function assistantText(node: Extract<UINode, { kind: 'assistant' }>): string {
  if (node.lostChars === undefined || node.text !== '') return node.text
  return `_输出中断，至少 ${node.lostChars} 字未保存_`
}

// 流式期间每个 preview 都会对全部节点重算一次 fingerprint，全文拼接是 O(会话总长) 的
// 字符串分配。流式正文与思考只追加（PreviewMerger 按 offset 累加后覆盖到节点上，落定时
// streaming 翻转必然改变 fingerprint），用户行内容按行 id 不可变，所以「长度 + 尾部采样」
// 足以区分真实变化。唯一盲区是等长且尾部 64 字符相同的改写：只可能出现在工具 args/result
// 预览这类瞬时文本上，接受。注意 tool.summary 不参与采样：状态文案存在等长替换。
const FINGERPRINT_TAIL = 64
const sampledPart = (value: string | undefined): string =>
  `${(value ?? '').length}:${value ? value.slice(-FINGERPRINT_TAIL) : ''}`

function fingerprint(node: UINode): string {
  switch (node.kind) {
    case 'user': {
      const body = textContent(node)
      return `${node.kind}:${node.id}:${sampledPart(body)}`
    }
    case 'assistant':
      return `${node.kind}:${node.id}:${sampledPart(node.thinking)}:${sampledPart(node.text)}:${
        node.streaming === true
      }:${node.lostChars ?? ''}`
    case 'tool':
      return `${node.kind}:${node.id}:${node.name}:${node.status}:${node.summary}:${sampledPart(
        node.argsPreview,
      )}:${sampledPart(node.resultPreview)}`
    case 'approval':
      return `${node.kind}:${node.id}:${node.state}:${node.summary}:${node.decision?.verdict ?? ''}`
    case 'contribute-conflict':
      return `${node.kind}:${node.id}:${node.key}:${JSON.stringify(node.ops)}`
    case 'compaction':
      return `${node.kind}:${node.id}:${node.summary ?? ''}:${node.range.join('-')}`
    case 'cost':
      // Cost nodes are filled incrementally: the same node id can first arrive without credits,
      // then receive token/billing details from the gateway. Include the complete payload so the
      // existing entry updates instead of being incorrectly treated as unchanged.
      return `${node.kind}:${node.id}:${JSON.stringify(node)}`
    case 'artifact':
      return `${node.kind}:${node.id}:${node.name}`
    case 'slot':
      return `${node.kind}:${node.id}:${node.fill.extId}`
  }
  return ''
}

/** Update a text node in place so a selection never loses its owner during a stream update. */
function updateText(ref: TextRef, value: string): void {
  if (ref.value === value) return
  if (value.startsWith(ref.value)) ref.node.appendData(value.slice(ref.value.length))
  else ref.node.replaceData(0, ref.node.length, value)
  ref.value = value
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

function heading(parent: HTMLElement, className: string, value: string): TextRef {
  const element = document.createElement('p')
  element.className = className
  const node = document.createTextNode(value)
  element.append(node)
  parent.append(element)
  return { element, node, value }
}

function article(node: UINode): HTMLElement {
  const element = document.createElement('article')
  element.className = `timeline-node ${node.kind}`
  element.dataset.nodeId = node.id
  element.dataset.nodeKind = node.kind
  return element
}

const approvalStatus = (node: ApprovalNode): string =>
  (node.state === 'decided' && node.decision
    ? APPROVAL_DECISION_LABEL.get(node.decision.verdict)
    : undefined) ?? APPROVAL_LABEL[node.state]

function approvalLabel(node: ApprovalNode): string {
  return `审批：${approvalStatus(node)}`
}

function compactionSummary(node: Extract<UINode, { kind: 'compaction' }>): string {
  return node.summary ?? `已整理上下文（范围：${node.range.join('–')}）`
}

function createEntry(node: UINode): Entry {
  const element = article(node)

  if (node.kind === 'user') {
    const title = heading(element, 'node-label', '你')
    const body = text(element, 'node-body', textContent(node))
    return {
      kind: node.kind,
      element,
      fingerprint: fingerprint(node),
      update(next) {
        if (next.kind !== 'user') return
        updateText(title, '你')
        updateText(body, textContent(next))
      },
    }
  }

  if (node.kind === 'assistant') {
    const title = heading(element, 'node-label', 'Agnes')
    const thinking = document.createElement('details')
    thinking.className = 'thinking'
    thinking.hidden = !node.thinking?.trim()
    // 「正在思考」= 还在流式、且正文还没开始。正文一出现（或整条消息落定）就说明思考结束，
    // 此时自动收起一次；之后的开合只认用户点击（记在 thinkingPreference），
    // 与回合过程区（turns.ts 的 processPreference）同一套语义。
    const thinkingActive = (next: Extract<UINode, { kind: 'assistant' }>): boolean =>
      Boolean(next.thinking?.trim()) && next.streaming === true && next.text.trim() === ''
    let thinkingPreference: boolean | undefined
    let thinkingWasActive = thinkingActive(node)
    thinking.open = thinkingWasActive
    const thinkingSummary = document.createElement('summary')
    thinkingSummary.textContent = '深度思考'
    thinkingSummary.addEventListener('click', () => {
      thinkingPreference = !thinking.open
    })
    const thinkingContent = document.createElement('div')
    thinkingContent.className = 'thinking-content markdown'
    thinking.append(thinkingSummary, thinkingContent)
    element.append(thinking)
    const thinkingRenderer = createMarkdownRenderer(thinkingContent, node.thinking ?? '')
    const body = document.createElement('div')
    body.className = 'node-body markdown'
    element.append(body)
    const bodyRenderer = createMarkdownRenderer(body, assistantText(node))
    element.dataset.streaming = String(node.streaming === true)
    return {
      kind: node.kind,
      element,
      thinking,
      fingerprint: fingerprint(node),
      // 思考块固定排在 `.node-body` 之前（标题之后）。归属容器取 `body` 的实际父节点：
      // DSH 宿主会把原生内容整体搬进 `[data-agnes-timeline-native]`，写死 `element` 会让
      // 插入参照物不在同一父节点上而抛错。
      rehome() {
        const home = body.parentElement
        if (home === null) return
        if (thinking.parentElement === home && thinking.nextElementSibling === body) return
        home.insertBefore(thinking, body)
      },
      update(next) {
        if (next.kind !== 'assistant') return
        element.dataset.streaming = String(next.streaming === true)
        updateText(title, 'Agnes')
        thinking.hidden = !next.thinking?.trim()
        const active = thinkingActive(next)
        // 只在「思考结束」的那一刻收起一次，不会反复覆盖用户此后的手动开合。
        if (thinkingWasActive && !active) thinkingPreference = false
        thinkingWasActive = active
        thinking.open = thinkingPreference ?? active
        if (next.thinking !== undefined) thinkingRenderer.update(next.thinking)
        bodyRenderer.update(assistantText(next))
      },
      dispose() {
        thinkingRenderer.dispose()
        bodyRenderer.dispose()
      },
    }
  }

  if (node.kind === 'tool') {
    const card = createConversationToolCard(element, node, { icon: toolIcon })
    return {
      kind: node.kind,
      element,
      fingerprint: fingerprint(node),
      update(next) {
        if (next.kind !== 'tool') return
        card.update(next)
      },
    }
  }

  if (node.kind === 'approval') {
    const head = document.createElement('div')
    head.className = 'approval-head'
    const title = label(head, 'node-label', '审批')
    const status = label(head, 'tool-status', approvalStatus(node))
    const summary = text(element, 'approval-summary', node.summary)
    element.prepend(head)
    element.setAttribute('aria-label', approvalLabel(node))
    return {
      kind: node.kind,
      element,
      fingerprint: fingerprint(node),
      update(next) {
        if (next.kind !== 'approval') return
        updateText(title, '审批')
        updateText(status, approvalStatus(next))
        updateText(summary, next.summary)
        element.setAttribute('aria-label', approvalLabel(next))
        element.dataset.state = next.state
      },
    }
  }

  if (node.kind === 'cost') {
    const update = createCostDetails(element)
    update(node)
    return {
      kind: node.kind,
      element,
      fingerprint: fingerprint(node),
      update(next) {
        if (next.kind === 'cost') update(next)
      },
    }
  }

  if (node.kind === 'artifact') {
    const title = heading(element, 'node-label', '产物')
    const body = text(element, 'node-body', node.name)
    return {
      kind: node.kind,
      element,
      fingerprint: fingerprint(node),
      update(next) {
        if (next.kind !== 'artifact') return
        updateText(title, '产物')
        updateText(body, next.name)
      },
    }
  }

  if (node.kind === 'compaction') {
    const title = heading(element, 'node-label', '上下文整理')
    const body = text(element, 'node-body', compactionSummary(node))
    return {
      kind: node.kind,
      element,
      fingerprint: fingerprint(node),
      update(next) {
        if (next.kind !== 'compaction') return
        updateText(title, '上下文整理')
        updateText(body, compactionSummary(next))
      },
    }
  }

  if (node.kind === 'slot') {
    // WC9：slot 节点的稳定容器。client-modules 底座未启动时由 mountSlotCard 降级为静态占位。
    const mount = mountSlotCard({ node, context: getSlotCardContext() })
    element.append(mount.element)
    return {
      kind: node.kind,
      element,
      fingerprint: fingerprint(node),
      update(next) {
        if (next.kind !== 'slot') return
        mount.update(next)
      },
    }
  }

  const title = heading(element, 'node-label', '暂不支持的内容')
  const body = text(element, 'node-body', '')
  const update = (next: UINode) => {
    if (next.kind !== 'contribute-conflict') return
    updateText(title, '上下文配置冲突')
    updateText(body, `${next.key}：${next.ops.join('、')}`)
    element.setAttribute('role', 'note')
  }
  update(node)
  return {
    kind: node.kind,
    element,
    fingerprint: fingerprint(node),
    update,
  }
}

// 与 NativeDshChildren 的子槽位清单保持一致（那边带 entryKey，这里只关心名字），
// 供「有没有人认领」判定使用；声明占位条目（key: '__agnes-native-child-declarations__'）
// 不是真实注册项，不会被 entriesOfSlot 之外的判断误伤。
const dshChildSlotNames = (slotName: string, kind: UINode['kind']): readonly string[] =>
  slotName === 'tool.call.toolview'
    ? ['tool.call.images', 'tool.view.cordis']
    : [
        ...(kind === 'assistant' ? ['conversation.chat.assistant-actions'] : []),
        'conversation.chat.commandview',
        'conversation.chat.turnTail',
        'conversation.message.images',
        'conversation.trajectory.images',
      ]

function mountDshNode(
  entry: Entry,
  node: UINode,
  options: Pick<TimelineRendererOptions, 'registry' | 'session' | 'locale' | 'resources'>,
): DshNodeMount | undefined {
  const registry = options.registry
  const projection = dshProjection(node)
  if (!registry || !projection || !registry.spec(projection.slotName)) return undefined

  const native = document.createElement('div')
  native.dataset.agnesTimelineNative = '1'
  while (entry.element.firstChild) native.append(entry.element.firstChild)
  entry.element.append(native)

  const host = document.createElement('div')
  host.dataset.agnesDshSlot = projection.slotName
  entry.element.append(host)
  const childHost = document.createElement('div')
  childHost.dataset.agnesDshChildren = projection.slotName
  native.append(childHost)
  const root = createRoot(host)
  const childRoot = createRoot(childHost)

  // 流式期间每个 delta 都会走到 update()。没有任何插件认领本节点或其子槽位时，
  // 两遍 root.render 是无产出的 reconcile——原生内容才是显示者。此时跳过 React，
  // 只监听注册表变化；一旦出现认领方（或认领方撤离），用最新节点补一次完整渲染。
  // 认领口径与 ChatNodeOutlet 的 active 相同：父槽位按 entryKey 命中，或任一子槽位有注册项。
  let latest = node
  const isClaimed = (next: UINode): boolean => {
    const nextProjection = dshProjection(next)
    if (!nextProjection) return false
    if (
      registry
        .entriesOfSlot(nextProjection.slotName)
        .some((item) => item.options.key === nextProjection.entryKey)
    )
      return true
    return dshChildSlotNames(nextProjection.slotName, next.kind).some(
      (name) => registry.entriesOfSlot(name).length > 0,
    )
  }
  let claimed = isClaimed(node)
  const render = (next: UINode): void => {
    const nextProjection = dshProjection(next)
    if (!nextProjection) return
    host.dataset.agnesDshSlot = nextProjection.slotName
    childHost.dataset.agnesDshChildren = nextProjection.slotName
    childRoot.render(
      createElement(
        SlotsProvider,
        {
          registry,
          ...(options.session ? { session: options.session } : {}),
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.resources ? { resources: options.resources } : {}),
        },
        createElement(NativeDshChildren, {
          projection: nextProjection,
        }),
      ),
    )
    root.render(
      createElement(
        SlotsProvider,
        {
          registry,
          ...(options.session ? { session: options.session } : {}),
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.resources ? { resources: options.resources } : {}),
        },
        createElement(ChatNodeOutlet, {
          registry,
          slotName: nextProjection.slotName,
          entryKey: nextProjection.entryKey,
          props: nextProjection.props,
          onActive(active: boolean) {
            native.hidden = active
            host.hidden = !active
          },
        }),
      ),
    )
  }
  const sync = (): void => {
    const active = isClaimed(latest)
    if (active || claimed) render(latest)
    if (active !== claimed) {
      native.hidden = active
      host.hidden = !active
    }
    claimed = active
  }
  const stops = [projection.slotName, ...dshChildSlotNames(projection.slotName, node.kind)].map((name) =>
    registry.subscribeBatched(name, sync),
  )
  if (!claimed) {
    native.hidden = false
    host.hidden = true
  } else render(node)
  return {
    update(next) {
      latest = next
      if (claimed) render(next)
    },
    dispose() {
      for (const stop of stops) stop()
      root.unmount()
      childRoot.unmount()
      host.remove()
      native.remove()
    },
  }
}

function NativeDshChildren({
  projection,
}: {
  projection: ReturnType<typeof dshProjection>
}): ReturnType<typeof createElement> {
  if (!projection) return createElement('div')
  const props = projection.props
  const owner = props.owner
  const isAssistant =
    typeof owner === 'object' && owner !== null && 'kind' in owner && owner.kind === 'assistant'
  const slots =
    projection.slotName === 'tool.call.toolview'
      ? [
          { name: 'tool.call.images' as const },
          { name: 'tool.view.cordis' as const, entryKey: projection.entryKey },
        ]
      : [
          ...(isAssistant ? [{ name: 'conversation.chat.assistant-actions' as const }] : []),
          { name: 'conversation.chat.commandview' as const, entryKey: projection.entryKey },
          { name: 'conversation.chat.turnTail' as const },
          { name: 'conversation.message.images' as const },
          { name: 'conversation.trajectory.images' as const },
        ]
  return createElement(
    'div',
    { 'data-agnes-dsh-child-outlets': projection.slotName },
    ...slots.map((slot) =>
      createElement(SlotOutlet, {
        key: slot.name,
        name: slot.name,
        ...(slot.entryKey === undefined ? {} : { entryKey: slot.entryKey }),
        props,
        hideWhenEmpty: true,
      }),
    ),
  )
}

function dshProjection(
  node: UINode,
):
  | { slotName: 'conversation.chat.node'; entryKey: string; props: Record<string, unknown> }
  | { slotName: 'tool.call.toolview'; entryKey: string; props: Record<string, unknown> }
  | undefined {
  if (node.kind === 'tool') {
    return {
      slotName: 'tool.call.toolview',
      entryKey: node.name,
      props: {
        owner: {
          callId: node.toolUseId,
          toolName: node.name,
          block: node,
        },
      },
    }
  }
  return {
    slotName: 'conversation.chat.node',
    entryKey: node.kind,
    props: { owner: { node, nodeId: node.id, kind: node.kind } },
  }
}

function ChatNodeOutlet({
  registry,
  slotName,
  entryKey,
  props,
  onActive,
}: {
  registry: SlotRegistry
  slotName: 'conversation.chat.node' | 'tool.call.toolview'
  entryKey: string
  props: Record<string, unknown>
  onActive(active: boolean): void
}): ReturnType<typeof createElement> {
  const version = useSyncExternalStore(
    (listener) => registry.subscribeBatched(slotName, listener),
    () => registry.getVersion(slotName),
  )
  void version
  const active = registry.entriesOfSlot(slotName).some((entry) => entry.options.key === entryKey)
  useLayoutEffect(() => {
    onActive(active)
  }, [active, onActive])
  return createElement(SlotOutlet, {
    name: slotName,
    entryKey,
    props,
    hideWhenEmpty: true,
  })
}

export function nearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 80
}

type SavedSelection = {
  text: string
  ranges: Array<{ start: Node; startOffset: number; end: Node; endOffset: number }>
}

function saveTranscriptSelection(transcript: HTMLElement): SavedSelection | undefined {
  const selection = globalThis.getSelection?.()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
  if (
    !ranges.every(
      (range) => transcript.contains(range.startContainer) && transcript.contains(range.endContainer),
    )
  )
    return undefined
  return {
    text: selection.toString(),
    ranges: ranges.map((range) => ({
      start: range.startContainer,
      startOffset: range.startOffset,
      end: range.endContainer,
      endOffset: range.endOffset,
    })),
  }
}

function restoreTranscriptSelection(transcript: HTMLElement, saved: SavedSelection | undefined): void {
  const selection = globalThis.getSelection?.()
  if (!saved || !selection || selection.toString() === saved.text) return
  if (!saved.ranges.every((range) => transcript.contains(range.start) && transcript.contains(range.end)))
    return
  try {
    selection.removeAllRanges()
    for (const savedRange of saved.ranges) {
      const range = document.createRange()
      range.setStart(savedRange.start, savedRange.startOffset)
      range.setEnd(savedRange.end, savedRange.endOffset)
      selection.addRange(range)
    }
  } catch {
    // A renderer may have shortened a still-connected text node. In that case the
    // browser's adjusted selection is safer than manufacturing a replacement range.
  }
}

export function createTimelineRenderer(options: TimelineRendererOptions): TimelineRenderer {
  const scrollContainer = options.scrollContainer ?? options.transcript
  const entries = new Map<string, Entry>()
  const turnProjector = createTurnProjector({
    transcript: options.transcript,
    ...(options.onFork ? { onFork: options.onFork } : {}),
  })
  // 贴底跟随是**粘性**的：只有用户主动滚动（滚轮/触摸/拖滚动条）才解除，
  // 程序写入的滚动不算。判定依据是"位置是否等于程序最后一次写入的位置"：
  // 此前每次渲染现算 nearBottom，会被会话区外的布局变化破坏——审批卡出现把
  // 会话视口压矮（远超 80px 容差），跟随被静默关闭；随后审批节点挪进过程
  // details、底部内容塌缩，scrollTop 被向上钳制，视图跳到顶只剩"有新内容"。
  let follow = true
  let expectedTop = scrollContainer.scrollTop
  const scrollToBottom = (): void => {
    // The document skin intentionally enables smooth reader scrolling. It must not turn each
    // streaming frame into a new animation, otherwise repeated deltas never catch up with the
    // bottom and the next real user scroll cannot reliably leave follow mode.
    const previousBehavior = scrollContainer.style.scrollBehavior
    scrollContainer.style.scrollBehavior = 'auto'
    scrollContainer.scrollTop = scrollContainer.scrollHeight
    scrollContainer.style.scrollBehavior = previousBehavior
    expectedTop = scrollContainer.scrollTop
    options.newContentButton.hidden = true
  }
  // Node objects are immutable once rendered, so an unchanged object keeps its fingerprint.
  const fingerprints = new WeakMap<UINode, string>()
  const fingerprintOf = (node: UINode): string => {
    let value = fingerprints.get(node)
    if (value === undefined) {
      value = fingerprint(node)
      fingerprints.set(node, value)
    }
    return value
  }
  // "Load earlier" sits above the content, outside the node container the entries own.
  const earlier = document.createElement('div')
  earlier.className = 'transcript-earlier'
  earlier.hidden = true
  const earlierButton = document.createElement('button')
  earlierButton.type = 'button'
  earlierButton.textContent = '加载更早的记录'
  earlier.append(earlierButton)
  if (options.transcript.parentElement && scrollContainer !== options.transcript)
    options.transcript.before(earlier)
  let meta: TimelineMeta | undefined
  let loadingEarlier = false
  // The first node the previous render showed; a new node before it means earlier ones came in.
  let firstShown: string | undefined
  const loadEarlier = (): void => {
    if (loadingEarlier || !meta?.hasEarlier || !meta.loadEarlier) return
    loadingEarlier = true
    meta.loadEarlier()
  }
  earlierButton.addEventListener('click', loadEarlier)
  const sentinel =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((seen) => {
          if (seen.some((item) => item.isIntersecting)) loadEarlier()
        })
      : undefined
  sentinel?.observe(earlier)
  const render = (nodes: readonly UINode[], turns?: readonly UITurn[], nextMeta?: TimelineMeta): void => {
    meta = nextMeta
    loadingEarlier = false
    earlier.hidden = !nextMeta?.hasEarlier
    const visibleNodes = nodes.filter(isConversationNode)
    const savedSelection = saveTranscriptSelection(options.transcript)
    // Earlier nodes inserted above keep the reader where they were, measured from the bottom.
    const previousFirst = firstShown
    firstShown = visibleNodes[0]?.id
    const prepended =
      previousFirst !== undefined &&
      firstShown !== previousFirst &&
      visibleNodes.some((node) => node.id === previousFirst)
    const fromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop
    const nextIds = new Set<string>()
    let changed = visibleNodes.length !== entries.size
    for (const node of visibleNodes) {
      nextIds.add(node.id)
      const old = entries.get(node.id)
      const nextFingerprint = fingerprintOf(node)
      let entry = old
      if (!entry || entry.kind !== node.kind) {
        old?.dispose?.()
        old?.dshNode?.dispose()
        old?.element.remove()
        entry = createEntry(node)
        entry.dshNode = mountDshNode(entry, node, options)
        entries.set(node.id, entry)
        changed = true
      } else if (entry.fingerprint !== nextFingerprint) {
        entry.update(node)
        entry.dshNode?.update(node)
        entry.fingerprint = nextFingerprint
        changed = true
      }
      entry.element.dataset.nodeId = node.id
    }
    for (const [id, entry] of entries) {
      if (nextIds.has(id)) continue
      entry.dispose?.()
      entry.dshNode?.dispose()
      entry.element.remove()
      entries.delete(id)
      changed = true
    }

    // 每次分发前先把思考块收回各自的 article：回合投影会把它搬进过程折叠，这一步保证
    // 「有回合 / 无回合 / 节点游离」三种路径下它都不会滞留在上一次的容器里。
    for (const entry of entries.values()) entry.rehome?.()

    if (turns?.length) {
      changed = turnProjector.render(visibleNodes, turns, (id) => entries.get(id)) || changed
    } else {
      turnProjector.render(visibleNodes, undefined, () => undefined)
      let index = 0
      for (const node of visibleNodes) {
        const entry = entries.get(node.id)
        if (!entry) continue
        const child = options.transcript.children[index]
        if (child !== entry.element) options.transcript.insertBefore(entry.element, child ?? null)
        index++
      }
    }

    if (changed) {
      if (follow) scrollToBottom()
      else if (prepended) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight - fromBottom
        expectedTop = scrollContainer.scrollTop
      } else options.newContentButton.hidden = nearBottom(scrollContainer)
    }
    restoreTranscriptSelection(options.transcript, savedSelection)
  }

  const onScroll = () => {
    const top = scrollContainer.scrollTop
    if (Math.abs(top - expectedTop) <= 1) return
    follow = nearBottom(scrollContainer)
    // 离开底部的那一刻就要亮出「有新内容」，不必等下一次渲染。
    options.newContentButton.hidden = follow
  }
  scrollContainer.addEventListener('scroll', onScroll)
  options.newContentButton.addEventListener('click', () => {
    follow = true
    scrollToBottom()
    scrollContainer.focus({ preventScroll: true })
  })

  return {
    render,
    reset() {
      for (const entry of entries.values()) {
        entry.dispose?.()
        entry.dshNode?.dispose()
      }
      options.transcript.replaceChildren()
      entries.clear()
      firstShown = undefined
      turnProjector.reset()
      follow = true
      expectedTop = scrollContainer.scrollTop
      options.newContentButton.hidden = true
    },
    dispose() {
      turnProjector.reset()
      scrollContainer.removeEventListener('scroll', onScroll)
      sentinel?.disconnect()
      earlier.remove()
    },
    pinToBottom: scrollToBottom,
  }
}
