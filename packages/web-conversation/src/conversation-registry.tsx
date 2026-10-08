import { type ConversationCardInput, conversationCards, type UiExtensionContext } from '@agnes/web-client'
import { ConversationCardLayout } from '@agnes/web-ui'
import { type ReactNode, useSyncExternalStore } from 'react'

/** All presentation categories share registration, disposal, ordering and reactive resolution. */
export function RegisteredConversationCard({
  card,
  context,
}: {
  card: ConversationCardInput
  context: UiExtensionContext
}) {
  useSyncExternalStore(conversationCards.subscribe, conversationCards.getSnapshot)
  const Component = conversationCards.entries().find((entry) => entry.matches(card))?.component
  return Component ? <Component card={card} context={context} /> : null
}
for (const [id, kind, testId] of [
  ['workflow-panel', 'workflow-run', 'workflow-run-card'],
  ['job', 'background-job', 'background-job-card'],
  ['child', 'child-agent', 'child-agent-card'],
  ['plan', 'plan', 'plan-card'],
  ['plugin', 'plugin', 'plugin-card'],
  ['tool', 'tool', 'conversation-tool-card'],
] as const) {
  if (!conversationCards.get(id))
    conversationCards.register({
      id,
      order: 100,
      matches: (card) => card.kind === kind,
      component: ({ card, context }) => (
        <ConversationCardLayout
          as="section"
          variant="plain"
          className="conversation-tool-surface"
          data-testid={testId}
          data-tool-name={
            card.data && typeof card.data === 'object' && 'name' in card.data
              ? String(card.data.name)
              : undefined
          }
        >
          {context.data as ReactNode}
        </ConversationCardLayout>
      ),
    })
}
