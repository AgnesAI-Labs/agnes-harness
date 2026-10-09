import type { UINode, UITurn } from '@agnes/protocol'
import { isConversationNode } from '@agnes/web-conversation/conversation-visibility'
import type { Translate } from '@agnes/web-conversation/presentation'
import { createTurnProjector } from '@agnes/web-conversation/turns'
import { mountMessageFeedback } from './message-feedback.js'
import type { Entry, TimelineMeta, TimelineRenderer, TimelineRendererOptions } from './timeline/contracts.js'
import { mountDshNode } from './timeline/dsh-node.js'
import { createEntry } from './timeline/native-entry.js'
import { fingerprint } from './timeline/node-presentation.js'
import { nearBottom, restoreTranscriptSelection, saveTranscriptSelection } from './timeline/selection.js'

export function createTimelineRenderer(options: TimelineRendererOptions): TimelineRenderer {
  const scrollContainer = options.scrollContainer ?? options.transcript
  // 渲染时取词：t 只在渲染/更新瞬间调用；locale 变化经订阅触发一次带滚动保持的全量重渲染。
  const locale = options.locale
  const t: Translate = locale ? (key, vars) => locale.t(key, vars) : (key) => key
  const localeVersion = locale ? () => locale.getSnapshot() : (): string => 'en'
  const entries = new Map<string, Entry>()
  const turnProjector = createTurnProjector({
    transcript: options.transcript,
    ...(options.onFork ? { onFork: options.onFork } : {}),
    translate: t,
    localeTag: () => (options.locale?.getSnapshot() === 'zh-CN' ? 'zh-CN' : 'en-US'),
  })
  // 贴底跟随是**粘性**的：只有用户主动滚动（滚轮/触摸/拖滚动条）才解除，
  // 程序写入的滚动不算。判定依据是"位置是否等于程序最后一次写入的位置"：
  // 此前每次渲染现算 nearBottom，会被会话区外的布局变化破坏——审批卡出现把
  // 会话视口压矮（远超 80px 容差），跟随被静默关闭；随后审批节点挪进过程
  // details、底部内容塌缩，scrollTop 被向上钳制，视图跳到顶只剩"有新内容"。
  let follow = true
  let expectedTop = scrollContainer.scrollTop
  const jumpTo = (top: number): void => {
    // The document skin intentionally enables smooth reader scrolling. Programmatic positioning
    // must not animate: a streaming frame would never catch up with the bottom, and anchoring
    // after a prepend would visibly slide the whole transcript.
    const previousBehavior = scrollContainer.style.scrollBehavior
    scrollContainer.style.scrollBehavior = 'auto'
    scrollContainer.scrollTop = top
    scrollContainer.style.scrollBehavior = previousBehavior
    expectedTop = scrollContainer.scrollTop
  }
  const scrollToBottom = (): void => {
    jumpTo(scrollContainer.scrollHeight)
    options.newContentButton.hidden = true
  }
  // Node objects are immutable once rendered, so an unchanged object keeps its fingerprint.
  // The current locale joins the fingerprint: switching languages invalidates every entry so the
  // next render (the subscription below forces one) refreshes all rendered copy in place.
  const fingerprints = new WeakMap<UINode, { locale: string; value: string }>()
  const fingerprintOf = (node: UINode): string => {
    const locale = localeVersion()
    const cached = fingerprints.get(node)
    if (cached?.locale === locale) return cached.value
    const value = `${locale}|${fingerprint(node)}`
    fingerprints.set(node, { locale, value })
    return value
  }
  // "Load earlier" sits above the content, outside the node container the entries own.
  const earlier = document.createElement('div')
  earlier.className = 'transcript-earlier'
  earlier.hidden = true
  const earlierButton = document.createElement('button')
  earlierButton.type = 'button'
  earlierButton.textContent = t('timeline.loadEarlier')
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
  const render = (
    nodes: readonly UINode[],
    turns?: readonly UITurn[],
    nextMeta?: TimelineMeta,
    opts?: { preserveScroll?: boolean },
  ): void => {
    meta = nextMeta
    loadingEarlier = false
    earlier.hidden = !nextMeta?.hasEarlier
    earlierButton.textContent = t('timeline.loadEarlier')
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
        old?.messageFeedback?.dispose()
        old?.dispose?.()
        old?.dshNode?.dispose()
        old?.element.remove()
        entry = createEntry(node, t, nextFingerprint)
        if (node.kind === 'assistant')
          entry.messageFeedback = mountMessageFeedback(entry.element, options.session)
        entry.dshNode = mountDshNode(entry, node, options)
        entries.set(node.id, entry)
        changed = true
      } else if (entry.fingerprint !== nextFingerprint) {
        entry.update(node)
        entry.dshNode?.update(node)
        entry.fingerprint = nextFingerprint
        changed = true
      }
      entry.messageFeedback?.update(node, turns)
      entry.element.dataset.nodeId = node.id
    }
    for (const [id, entry] of entries) {
      if (nextIds.has(id)) continue
      entry.messageFeedback?.dispose()
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
      if (opts?.preserveScroll) jumpTo(scrollContainer.scrollHeight - fromBottom)
      else if (follow) scrollToBottom()
      else if (prepended) jumpTo(scrollContainer.scrollHeight - fromBottom)
      else options.newContentButton.hidden = nearBottom(scrollContainer)
    }
    restoreTranscriptSelection(options.transcript, savedSelection)
    // The observer only reports visibility changes. A sentinel that never left the screen while a
    // page loaded would never report again, so re-observing asks for a fresh reading, which the
    // browser takes after this layout. Only a page that actually landed re-arms it: a failed load
    // re-renders the same window, and re-arming then would retry without end.
    if (sentinel && nextMeta?.hasEarlier && prepended) {
      sentinel.unobserve(earlier)
      sentinel.observe(earlier)
    }
  }

  // 语言切换：记住最近一次渲染入参，locale 变化时重跑一次 render。fingerprint 掺了 locale
  // 版本，全部 entry 原地更新文案；preserveScroll 保证阅读位置不跳底。
  let lastRender: { nodes: readonly UINode[]; turns?: readonly UITurn[]; meta?: TimelineMeta } | undefined
  const renderAndRemember = (
    nodes: readonly UINode[],
    turns?: readonly UITurn[],
    nextMeta?: TimelineMeta,
  ): void => {
    lastRender = {
      nodes,
      ...(turns === undefined ? {} : { turns }),
      ...(nextMeta === undefined ? {} : { meta: nextMeta }),
    }
    render(nodes, turns, nextMeta)
  }
  const unsubscribeLocale = options.locale?.subscribe(() => {
    const last = lastRender
    if (last) render(last.nodes, last.turns, last.meta, { preserveScroll: true })
  })

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

  const reset = () => {
    for (const entry of entries.values()) {
      entry.messageFeedback?.dispose()
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
  }

  return {
    render: renderAndRemember,
    reset,
    dispose() {
      reset()
      unsubscribeLocale?.()
      scrollContainer.removeEventListener('scroll', onScroll)
      sentinel?.disconnect()
      earlier.remove()
    },
    pinToBottom: scrollToBottom,
  }
}

export type { TimelineMeta, TimelineRenderer, TimelineRendererOptions } from './timeline/contracts.js'
export { nearBottom } from './timeline/selection.js'
