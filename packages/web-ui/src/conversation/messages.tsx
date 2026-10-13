import type { ConversationMessagesProps } from './messages/context.js'
import { Message } from './messages/message.js'
import { Turn } from './messages/turn.js'
import { conversationNodes } from './projection.js'

/** Read-only DOM projection of the controller's nodes; source IDs own React identity. */
export function ConversationMessages(props: ConversationMessagesProps) {
  const visible = props.visibleNodeIds ? new Set(props.visibleNodeIds) : undefined
  const nodes = conversationNodes(props.nodes)
  if (visible) for (const id of [...nodes.keys()]) if (!visible.has(id)) nodes.delete(id)
  if (!props.turns?.length)
    return (
      <section data-agnes-conversation-messages="">
        {[...nodes].map(([id, node]) => (
          <Message key={id} node={node} props={props} />
        ))}
      </section>
    )
  const assigned = new Set(props.turns.flatMap((turn) => turn.nodeIds))
  const ownerByNodeId = new Map(
    props.turns.flatMap((turn) => turn.nodeIds.map((id) => [id, turn.id] as const)),
  )
  return (
    <section data-agnes-conversation-messages="">
      {props.turns.map((turn) => (
        <Turn key={turn.id} turn={turn} nodes={nodes} ownerByNodeId={ownerByNodeId} props={props} />
      ))}
      <section className="timeline-unassigned" hidden={[...nodes.keys()].every((id) => assigned.has(id))}>
        {[...nodes]
          .filter(([id]) => !assigned.has(id))
          .map(([id, node]) => (
            <Message key={id} node={node} props={props} />
          ))}
      </section>
    </section>
  )
}

export type { ConversationMarkdownState, ConversationMessagesProps } from './messages/context.js'
export { ConversationToolCard, toolOutcome } from './messages/tool-card.js'
