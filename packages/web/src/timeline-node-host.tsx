import type { UINode, UITurn } from '@agnes/protocol'
import type { ClientResourceService, LocaleService, SessionService, SlotRegistry } from '@agnes/web-client'
import {
  AssistantRuntimeProvider,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import type { TranscriptHandle } from '@agnes/web-units'
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { flushSync } from 'react-dom'
import type { ClaimResolver } from './client-modules/boot.js'
import { WebConversationMessages } from './conversation-message-adapter.js'
import { isConversationNode } from './conversation-visibility.js'
import type { TimelineMeta } from './timeline.js'

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
}

/** The opt-in transcript root is the sole owner of every node article and history control. */
export const TimelineNodeHost = forwardRef<TranscriptHandle, TimelineNodeHostProps>(function TimelineNodeHost(
  { registry, claim, newContentButton, session, locale, resources, onFork },
  ref,
) {
  const content = useRef<HTMLDivElement>(null)
  const earlier = useRef<HTMLDivElement>(null)
  const metaRef = useRef<TimelineMeta | undefined>(undefined)
  const scroll = useRef({
    follow: true,
    expectedTop: 0,
    firstShown: undefined as string | undefined,
    loadingEarlier: false,
    awaitingRender: false,
    loadEpoch: 0,
  })
  const [store] = useState(() =>
    createConversationProjectionStore({ sessionId: registry.sessionId ?? '', nodes: [] }),
  )
  const runtime = useConversationRuntime(store)
  const projection = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const viewport = useCallback(
    () => content.current?.closest<HTMLElement>('#transcript') ?? content.current,
    [],
  )
  const scrollToBottom = useCallback(() => {
    const element = viewport()
    if (!element) return
    const previousBehavior = element.style.scrollBehavior
    element.style.scrollBehavior = 'auto'
    element.scrollTop = element.scrollHeight
    element.style.scrollBehavior = previousBehavior
    scroll.current.expectedTop = element.scrollTop
    if (newContentButton) newContentButton.hidden = true
  }, [viewport, newContentButton])
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
      render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TimelineMeta) {
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
        else if (element && prepended) {
          element.scrollTop = element.scrollHeight - fromBottom
          state.expectedTop = element.scrollTop
        } else if (element && newContentButton) newContentButton.hidden = nearBottom(element)
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
    [registry, store, newContentButton, viewport, scrollToBottom],
  )
  return (
    <div
      style={{ display: 'contents' }}
      data-agnes-region-owner="builtin"
      data-agnes-region-unit="transcript"
    >
      <div ref={earlier} className="transcript-earlier" hidden={!projection.meta?.hasEarlier}>
        <button type="button" onClick={loadEarlier}>
          加载更早的记录
        </button>
      </div>
      <div id="transcript-content" ref={content}>
        <AssistantRuntimeProvider runtime={runtime}>
          <WebConversationMessages
            registry={registry}
            {...(projection.turns ? { turns: projection.turns } : {})}
            visibleNodeIds={projection.nodes.map((node) => node.id)}
            {...(onFork ? { onFork } : {})}
            {...(claim ? { claim } : {})}
            {...(session ? { session } : {})}
            {...(locale ? { locale } : {})}
            {...(resources ? { resources } : {})}
          />
        </AssistantRuntimeProvider>
      </div>
    </div>
  )
})
