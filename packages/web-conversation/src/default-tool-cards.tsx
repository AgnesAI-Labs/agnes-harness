import type { UINode } from '@agnes/protocol'
import type { ToolCardInlinePayload } from '@agnes/protocol/gen/slots'
import type { ClientResourceService, SessionService } from '@agnes/web-client'
import { RegisteredConversationCard } from './conversation-registry.js'

/** Installed inline cards use the registry; preset surfaces have their own shared placement. */
export function DefaultToolCards({
  node,
  session,
  resources,
  t = (key) => key,
}: {
  node: Extract<UINode, { kind: 'tool' }>
  session?: SessionService | undefined
  resources?: ClientResourceService | undefined
  t?: (key: string) => string
}) {
  return (
    <>
      {node.slots?.map((fill) =>
        fill.slot === 'tool.card.inline' ? (
          <RegisteredConversationCard
            key={`${fill.extId}:${(fill.payload as ToolCardInlinePayload).title}`}
            card={{ kind: 'tool-inline', data: { node, payload: fill.payload, extId: fill.extId } }}
            context={{ t, session, resources }}
          />
        ) : null,
      )}
    </>
  )
}
