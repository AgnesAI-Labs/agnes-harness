import type { UINode, UITurn } from '@agnes/protocol'
import { type ReactNode, useMemo, useRef } from 'react'
import { Bubble, type BubbleItemType } from '../x/index.js'
import type { ConversationMessagesProps } from './messages/context.js'
import { isSystemInput, Message } from './messages/message.js'
import { Turn } from './messages/turn.js'
import { type ConversationNode, conversationNodes } from './projection.js'
import { stableRecords } from './stable-records.js'
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
  const previous = useRef<{
    nodes: readonly UINode[]
    turns: readonly UITurn[]
  }>({ nodes: [], turns: [] })
  const stable = {
    nodes: stableRecords(previous.current.nodes, props.nodes),
    turns: stableRecords(previous.current.turns, props.turns ?? []),
  }
  previous.current = stable
  const presentation = useMemo(
    () => ({
      t: props.t,
      readAttachment: props.readAttachment,
      ...(props.renderTurnActions ? { renderTurnActions: props.renderTurnActions } : {}),
      ...(props.renderTurnDeliverables ? { renderTurnDeliverables: props.renderTurnDeliverables } : {}),
      ...(props.processStep ? { processStep: props.processStep } : {}),
      ...(props.renderMarkdown ? { renderMarkdown: props.renderMarkdown } : {}),
      ...(props.renderTool ? { renderTool: props.renderTool } : {}),
      ...(props.renderCost ? { renderCost: props.renderCost } : {}),
      ...(props.renderSlot ? { renderSlot: props.renderSlot } : {}),
      ...(props.renderNode ? { renderNode: props.renderNode } : {}),
    }),
    [
      props.t,
      props.readAttachment,
      props.renderTurnActions,
      props.renderTurnDeliverables,
      props.processStep,
      props.renderMarkdown,
      props.renderTool,
      props.renderCost,
      props.renderSlot,
      props.renderNode,
    ],
  )
  const visible = props.visibleNodeIds ? new Set(props.visibleNodeIds) : undefined
  const nodes = conversationNodes(stable.nodes)
  if (visible) for (const id of [...nodes.keys()]) if (!visible.has(id)) nodes.delete(id)
  let items: BubbleItemType[]
  if (stable.turns.length) {
    const assigned = new Set(stable.turns.flatMap((turn) => turn.nodeIds))
    const ownerByNodeId = new Map(
      stable.turns.flatMap((turn) => turn.nodeIds.map((id) => [id, turn.id] as const)),
    )
    const loose = [...nodes].filter(([id]) => !assigned.has(id))
    const last = stable.turns.at(-1)
    items = stable.turns.map((turn) =>
      item(
        turn.id,
        'turn',
        <Turn
          turn={turn}
          members={turn.nodeIds.flatMap((id) => {
            const node = nodes.get(id)
            return node && ownerByNodeId.get(id) === turn.id ? [node] : []
          })}
          attentionIds={turn.nodeIds.filter((id) => {
            const node = nodes.get(id)
            return (
              node &&
              ownerByNodeId.get(id) === turn.id &&
              node.kind !== 'assistant' &&
              node.kind !== 'user' &&
              node.kind !== 'cost' &&
              props.keepNodeVisible?.(node)
            )
          })}
          props={presentation}
          latest={turn === last}
        />,
      ),
    )
    items.push(
      item(
        'timeline-unassigned',
        'node',
        <section className="timeline-unassigned" hidden={loose.length === 0}>
          {loose.map(([id, node]) => (
            <Message key={id} node={node} props={presentation} />
          ))}
        </section>,
      ),
    )
  } else
    items = [...nodes].map(([id, node]) =>
      item(id, nodeRole(node), <Message node={node} props={presentation} />),
    )
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
