import type { UINode, UITurn } from '@agnes/protocol'
import type { ClientResourceService, LocaleService, SessionService, SlotRegistry } from '@agnes/web-client'
import {
  AssistantRuntimeProvider,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import type { TranscriptHandle } from '@agnes/web-units'
import { forwardRef, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import type { ClaimResolver } from './client-modules/boot.js'
import { WebConversationMessages } from './conversation-message-adapter.js'
import type { TimelineMeta } from './timeline.js'

export interface TimelineNodeHostProps {
  registry: SlotRegistry
  claim?: ClaimResolver
  newContentButton?: HTMLButtonElement
  session?: SessionService
  locale?: LocaleService
  resources?: ClientResourceService
  onFork?: (turn: UITurn) => Promise<void>
}

/** W4a opt-in: the enclosing transcript root is the sole owner of every node article. */
export const TimelineNodeHost = forwardRef<TranscriptHandle, TimelineNodeHostProps>(function TimelineNodeHost(
  { registry, claim, newContentButton, session, locale, resources, onFork },
  ref,
) {
  const content = useRef<HTMLDivElement>(null)
  const [store] = useState(() =>
    createConversationProjectionStore({ sessionId: registry.sessionId ?? '', nodes: [] }),
  )
  const runtime = useConversationRuntime(store)
  const projection = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useImperativeHandle(
    ref,
    () => ({
      render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TimelineMeta) {
        flushSync(() =>
          store.update({
            sessionId: registry.sessionId ?? '',
            nodes,
            ...(turns ? { turns } : {}),
            ...(meta ? { meta } : {}),
          }),
        )
      },
      reset() {
        flushSync(() => store.update({ sessionId: registry.sessionId ?? '', nodes: [] }))
        if (newContentButton) newContentButton.hidden = true
      },
      pinToBottom() {
        const viewport = content.current?.closest<HTMLElement>('#transcript') ?? content.current
        if (viewport) viewport.scrollTop = viewport.scrollHeight
        if (newContentButton) newContentButton.hidden = true
      },
    }),
    [registry, store, newContentButton],
  )
  return (
    <div
      style={{ display: 'contents' }}
      data-agnes-region-owner="builtin"
      data-agnes-region-unit="transcript"
    >
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
