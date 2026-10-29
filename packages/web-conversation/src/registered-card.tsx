import { type ConversationCardInput, conversationCards, type UiExtensionContext } from '@agnes/web-client'
import { renderRegion } from '@agnes/web-ui'
import { type ReactNode, useSyncExternalStore } from 'react'
/** All presentation categories share registration, disposal, ordering and reactive resolution. */
export function RegisteredConversationCard({
  card,
  context,
  fallback = null,
}: {
  card: ConversationCardInput
  context: UiExtensionContext
  fallback?: ReactNode
}) {
  useSyncExternalStore(conversationCards.subscribe, conversationCards.getSnapshot)
  const Component = conversationCards.entries().find((entry) => entry.matches(card))?.component
  return Component ? <Component card={card} context={context} /> : fallback
}

export function renderSessionActions(
  host: HTMLElement,
  timeline: import('@agnes/protocol').UITimeline | undefined,
  disabled: boolean,
  command: (command: string) => void,
  t: UiExtensionContext['t'],
) {
  host.hidden = !timeline?.sessionId
  renderRegion(
    host,
    timeline?.sessionId ? (
      <RegisteredConversationCard
        key={timeline.sessionId}
        card={{ kind: 'session.actions', data: { timeline, disabled, command } }}
        context={{ t }}
      />
    ) : null,
  )
}
