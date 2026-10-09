import type { UINode } from '@agnes/protocol'
import { ThreadPrimitive, useThread } from '@assistant-ui/react'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ConversationMessage } from './runtime.js'
import {
  type ConversationMessagesProps,
  type ConversationMessageTarget,
  type ConversationMessageTargetContextValue,
  ConversationMessageTargetContext,
  registerConversationMessageTargetContext,
} from './messages/context.js'
import { assistantUiMessageComponents } from './messages/assistant-portal.js'
import { Turn } from './messages/turn.js'
import { Message } from './messages/message.js'

/** Read-only DOM projection of `metadata.custom.node`; source IDs own React identity. */
export function ConversationMessages(props: ConversationMessagesProps) {
  const messages = useThread((state) => state.messages)
  const targetsRef = useRef(new Map<string, ConversationMessageTarget>())
  const [targetVersion, setTargetVersion] = useState(0)
  const registerMessageTarget = useCallback((id: string, target: ConversationMessageTarget | undefined) => {
    const current = targetsRef.current.get(id)
    if (!target) {
      if (!current) return
      targetsRef.current.delete(id)
      setTargetVersion((version) => version + 1)
      return
    }
    if (
      current?.element === target.element &&
      current.context.node === target.context.node &&
      current.context.props === target.context.props &&
      current.context.hideThinking === target.context.hideThinking &&
      current.context.turnStatus === target.context.turnStatus &&
      current.context.thinkingHost === target.context.thinkingHost
    )
      return
    targetsRef.current.set(id, target)
    setTargetVersion((version) => version + 1)
  }, [])
  const targetContext = useMemo<ConversationMessageTargetContextValue>(
    () => ({ targets: targetsRef.current, version: targetVersion }),
    [targetVersion],
  )
  const visible = props.visibleNodeIds ? new Set(props.visibleNodeIds) : undefined
  const nodes = new Map<string, UINode>()
  for (const message of messages) {
    const custom = message.metadata.custom as ConversationMessage['metadata']['custom'] | undefined
    const node = custom?.node
    if (
      node &&
      (!visible || visible.has(message.id)) &&
      node.kind !== 'context' &&
      node.kind !== 'context-sections'
    )
      nodes.set(message.id, node)
  }
  if (props.turns?.length) {
    const assigned = new Set(props.turns.flatMap((turn) => turn.nodeIds))
    const ownerByNodeId = new Map(
      props.turns.flatMap((turn) => turn.nodeIds.map((id) => [id, turn.id] as const)),
    )
    return (
      <ConversationMessageTargetContext.Provider value={targetContext}>
        <registerConversationMessageTargetContext.Provider value={registerMessageTarget}>
          <section data-agnes-conversation-messages="">
            <ThreadPrimitive.Messages components={assistantUiMessageComponents} />
            {props.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} nodes={nodes} ownerByNodeId={ownerByNodeId} props={props} />
            ))}
            <section
              className="timeline-unassigned"
              hidden={[...nodes.keys()].every((id) => assigned.has(id))}
            >
              {[...nodes]
                .filter(([id]) => !assigned.has(id))
                .map(([id, node]) => (
                  <Message key={id} node={node} props={props} />
                ))}
            </section>
          </section>
        </registerConversationMessageTargetContext.Provider>
      </ConversationMessageTargetContext.Provider>
    )
  }
  return (
    <ConversationMessageTargetContext.Provider value={targetContext}>
      <registerConversationMessageTargetContext.Provider value={registerMessageTarget}>
        <section data-agnes-conversation-messages="">
          <ThreadPrimitive.Messages components={assistantUiMessageComponents} />
          {messages.map((message) => {
            if (visible && !visible.has(message.id)) return null
            const custom = message.metadata.custom as ConversationMessage['metadata']['custom'] | undefined
            const node = custom?.node
            return node && node.kind !== 'context' && node.kind !== 'context-sections' ? (
              <Message key={message.id} node={node} props={props} turnStatus={custom?.turnStatus} />
            ) : null
          })}
        </section>
      </registerConversationMessageTargetContext.Provider>
    </ConversationMessageTargetContext.Provider>
  )
}

export { type ConversationMarkdownState } from './messages/context.js'
export { type ConversationMessagesProps } from './messages/context.js'
export { toolOutcome } from './messages/tool-card.js'
export { ConversationToolCard } from './messages/tool-card.js'
