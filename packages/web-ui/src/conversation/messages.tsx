import type { ReactNode } from 'react'
import { Bubble, type BubbleItemType } from '../x/index.js'
import type { ConversationMessagesProps } from './messages/context.js'
import { isSystemInput, Message } from './messages/message.js'
import { Turn } from './messages/turn.js'
import { type ConversationNode, conversationNodes } from './projection.js'
import { ConversationXScope } from './x-scope.js'

// The transcript region owns scrolling, so the list never scrolls itself. A turn row and a loose
// node row carry no bubble of their own; the bubbles a reader sees are drawn inside the turn.
const ROLES = {
  turn: { variant: 'borderless', placement: 'start', rootClassName: 'agh-bubble agh-bubble-row' },
  node: { variant: 'borderless', placement: 'start', rootClassName: 'agh-bubble agh-bubble-row' },
  user: { variant: 'filled', placement: 'end', rootClassName: 'agh-bubble agh-bubble-user' },
} as const satisfies BubbleListRoles

type BubbleListRoles = NonNullable<Parameters<typeof Bubble.List>[0]['role']>

const item = (key: string, role: keyof typeof ROLES, content: ReactNode): BubbleItemType => ({
  key,
  role,
  content,
})

const nodeRole = (node: ConversationNode): keyof typeof ROLES =>
  node.kind === 'user' && !isSystemInput(node) ? 'user' : 'node'

/** Read-only projection of the controller's nodes; source IDs own React identity. */
export function ConversationMessages(props: ConversationMessagesProps) {
  const visible = props.visibleNodeIds ? new Set(props.visibleNodeIds) : undefined
  const nodes = conversationNodes(props.nodes)
  if (visible) for (const id of [...nodes.keys()]) if (!visible.has(id)) nodes.delete(id)
  let items: BubbleItemType[]
  if (props.turns?.length) {
    const assigned = new Set(props.turns.flatMap((turn) => turn.nodeIds))
    const ownerByNodeId = new Map(
      props.turns.flatMap((turn) => turn.nodeIds.map((id) => [id, turn.id] as const)),
    )
    const loose = [...nodes].filter(([id]) => !assigned.has(id))
    const last = props.turns.at(-1)
    items = props.turns.map((turn) =>
      item(
        turn.id,
        'turn',
        <Turn turn={turn} nodes={nodes} ownerByNodeId={ownerByNodeId} props={props} latest={turn === last} />,
      ),
    )
    items.push(
      item(
        'timeline-unassigned',
        'node',
        <section className="timeline-unassigned" hidden={loose.length === 0}>
          {loose.map(([id, node]) => (
            <Message key={id} node={node} props={props} />
          ))}
        </section>,
      ),
    )
  } else
    items = [...nodes].map(([id, node]) => item(id, nodeRole(node), <Message node={node} props={props} />))
  return (
    <ConversationXScope>
      <section data-agnes-conversation-messages="">
        <Bubble.List autoScroll={false} items={items} role={ROLES} />
      </section>
    </ConversationXScope>
  )
}

export type { ConversationMarkdownState, ConversationMessagesProps } from './messages/context.js'
export { ConversationToolCard, toolOutcome } from './messages/tool-card.js'
