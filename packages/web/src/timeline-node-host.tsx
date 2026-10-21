import type { UINode, UITurn } from '@agnes/protocol'
import type { ClientResourceService, LocaleService, SessionService, SlotRegistry } from '@agnes/web-client'
import { isConversationNode } from '@agnes/web-conversation/conversation-visibility'
import {
  createConversationProjectionStore,
  TurnNav,
  useConversationProjection,
} from '@agnes/web-ui/conversation'
import type { TranscriptHandle, TranscriptMeta } from '@agnes/web-units/shell'
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { ClaimResolver } from './client-modules/boot.js'
import { WebConversationMessages } from './conversation-message-adapter.js'

const nearBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight <= 80

export interface TimelineNodeHostProps {
  registry: SlotRegistry
  claim?: ClaimResolver
  newContentButton?: HTMLButtonElement
  session?: SessionService
  locale?: LocaleService
  resources?: ClientResourceService
  onFork?: (turn: UITurn) => Promise<void>
  turnErrorActions?: import('@agnes/web-ui/conversation').TurnErrorActions
  markdownRenderer?: 'legacy' | 'xmarkdown'
}

/** The transcript root is the sole owner of every node article and history control. */
export const TimelineNodeHost = forwardRef<TranscriptHandle, TimelineNodeHostProps>(function TimelineNodeHost(
  { registry, claim, newContentButton, session, locale, resources, onFork, turnErrorActions, markdownRenderer },
  ref,
) {
  const content = useRef<HTMLDivElement>(null)
  const earlier = useRef<HTMLDivElement>(null)
  const metaRef = useRef<TranscriptMeta | undefined>(undefined)
  const scroll = useRef({
    follow: true,
    expectedTop: 0,
    firstShown: undefined as string | undefined,
    loadingEarlier: false,
    awaitingRender: false,
    loadEpoch: 0,
  })
  const translate = useCallback(
    (key: string, vars?: Readonly<Record<string, string | number>>) => locale?.t(key, vars) ?? key,
    [locale],
  )
  const [store] = useState(() =>
    createConversationProjectionStore({ sessionId: registry.sessionId ?? '', nodes: [] }),
  )
  const projection = useConversationProjection(store)
  // The prompt navigator draws beside the scrolling transcript, so it needs the element itself.
  const [viewportElement, setViewportElement] = useState<HTMLElement | null>(null)
  const viewport = useCallback(
    () => content.current?.closest<HTMLElement>('#transcript') ?? content.current,
    [],
  )
  // A skin may enable smooth reader scrolling. Programmatic positioning must not animate: a
  // streaming frame would never catch up with the bottom, and anchoring after a prepend would
  // visibly slide the whole transcript.
  const jumpTo = useCallback((element: HTMLElement, top: number) => {
    const previousBehavior = element.style.scrollBehavior
    element.style.scrollBehavior = 'auto'
    element.scrollTop = top
    element.style.scrollBehavior = previousBehavior
    scroll.current.expectedTop = element.scrollTop
  }, [])
  const scrollToBottom = useCallback(() => {
    const element = viewport()
    if (!element) return
    jumpTo(element, element.scrollHeight)
    if (newContentButton) newContentButton.hidden = true
  }, [viewport, jumpTo, newContentButton])
  const loadEarlier = useCallback(() => {
    const state = scroll.current
    const meta = metaRef.current
    if (state.loadingEarlier || !meta?.hasEarlier || !meta.loadEarlier) return
    state.loadingEarlier = true
    const epoch = ++state.loadEpoch
    const release = () => {
      if (state.loadEpoch === epoch) state.loadingEarlier = false
    }
    try {
      const result: unknown = meta.loadEarlier()
      if (result === undefined) {
        state.awaitingRender = true
        return
      }
      void Promise.resolve(result).then(release, release)
    } catch (error) {
      release()
      throw error
    }
  }, [])
  useLayoutEffect(() => {
    const element = viewport()
    if (!element) return
    setViewportElement(element)
    scroll.current.expectedTop = element.scrollTop
    const onScroll = () => {
      const state = scroll.current
      if (Math.abs(element.scrollTop - state.expectedTop) <= 1) return
      state.expectedTop = element.scrollTop
      state.follow = nearBottom(element)
      if (newContentButton) newContentButton.hidden = state.follow
    }
    const onNewContent = () => {
      scroll.current.follow = true
      scrollToBottom()
      element.focus({ preventScroll: true })
    }
    element.addEventListener('scroll', onScroll)
    newContentButton?.addEventListener('click', onNewContent)
    const contentResize =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (scroll.current.follow) scrollToBottom()
          })
        : undefined
    if (content.current) contentResize?.observe(content.current)
    const sentinel =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((seen) => {
            if (seen.some((item) => item.isIntersecting)) loadEarlier()
          })
        : undefined
    if (earlier.current) sentinel?.observe(earlier.current)
    return () => {
      element.removeEventListener('scroll', onScroll)
      newContentButton?.removeEventListener('click', onNewContent)
      contentResize?.disconnect()
      sentinel?.disconnect()
      scroll.current.loadEpoch++
      scroll.current.loadingEarlier = false
      scroll.current.awaitingRender = false
      if (newContentButton) newContentButton.hidden = true
    }
  }, [newContentButton, viewport, scrollToBottom, loadEarlier])
  useImperativeHandle(
    ref,
    () => ({
      render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TranscriptMeta) {
        const element = viewport()
        const state = scroll.current
        if (state.awaitingRender) {
          state.loadingEarlier = false
          state.awaitingRender = false
        }
        const firstShown = nodes.find(isConversationNode)?.id
        const prepended =
          state.firstShown !== undefined &&
          firstShown !== state.firstShown &&
          nodes.some((node) => node.id === state.firstShown)
        const fromBottom = element ? element.scrollHeight - element.scrollTop : 0
        state.firstShown = firstShown
        metaRef.current = meta
        flushSync(() =>
          store.update({
            sessionId: registry.sessionId ?? '',
            nodes,
            ...(turns ? { turns } : {}),
            ...(meta ? { meta } : {}),
          }),
        )
        if (element && state.follow) scrollToBottom()
        else if (element && prepended) jumpTo(element, element.scrollHeight - fromBottom)
        else if (element && newContentButton) newContentButton.hidden = nearBottom(element)
      },
      reset() {
        metaRef.current = undefined
        scroll.current.firstShown = undefined
        scroll.current.loadEpoch++
        scroll.current.loadingEarlier = false
        scroll.current.awaitingRender = false
        scroll.current.follow = true
        flushSync(() => store.update({ sessionId: registry.sessionId ?? '', nodes: [] }))
        scroll.current.expectedTop = viewport()?.scrollTop ?? 0
        if (newContentButton) newContentButton.hidden = true
      },
      pinToBottom() {
        scroll.current.follow = true
        scrollToBottom()
      },
    }),
    [registry, store, newContentButton, viewport, jumpTo, scrollToBottom],
  )
  return (
    <div
      className="transcript-node-host"
      data-agnes-region-owner="builtin"
      data-agnes-region-unit="transcript"
    >
      <div ref={earlier} className="transcript-earlier" hidden={!projection.meta?.hasEarlier}>
        <button type="button" onClick={loadEarlier}>
          {locale ? locale.t('timeline.loadEarlier') : 'Load earlier records'}
        </button>
      </div>
      <div id="transcript-content" ref={content}>
        <WebConversationMessages
          nodes={projection.nodes}
          registry={registry}
          {...(markdownRenderer ? { markdownRenderer } : {})}
          {...(projection.turns ? { turns: projection.turns } : {})}
          {...(onFork ? { onFork } : {})}
          {...(turnErrorActions ? { turnErrorActions } : {})}
          {...(claim ? { claim } : {})}
          {...(session ? { session } : {})}
          {...(locale ? { locale } : {})}
          {...(resources ? { resources } : {})}
        />
      </div>
      <TurnNav
        t={translate}
        nodes={projection.nodes}
        turns={projection.turns}
        viewport={viewportElement}
        hasEarlier={projection.meta?.hasEarlier}
        loadEarlier={loadEarlier}
        bookmarks={projection.meta?.setBookmarks ? projection.meta.bookmarks : undefined}
        onBookmarksChange={projection.meta?.setBookmarks}
      />
    </div>
  )
})
