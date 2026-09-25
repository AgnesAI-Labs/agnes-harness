import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type ThreadMessageLike,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessage,
  useThread,
} from '@assistant-ui/react'
import { type ComponentType, useEffect, useMemo } from 'react'
import type { SpikeProjection } from './projection.js'
import { projectVisible } from './projection.js'

function TextMessage() {
  const message = useMessage()
  const kind = String(message.metadata.custom.kind)
  const turnId = String(message.metadata.custom.turnId ?? '')
  const isFinal = String(message.metadata.custom.isFinal === true)
  const parts = message.content
    .filter((part) => part.type === 'text' || part.type === 'reasoning')
    .map((part) => (part.type === 'text' || part.type === 'reasoning' ? part.text : ''))
  return (
    <article
      data-node-id={message.id}
      data-node-kind={kind}
      data-status={message.status?.type}
      data-turn-id={turnId}
      data-final={isFinal}
    >
      {parts.join(' | ')}
    </article>
  )
}

const components = { Message: TextMessage }
const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message

function KeyedMessages({ messageComponent }: { messageComponent?: typeof TextMessage }) {
  const messages = useThread((state) => state.messages)
  return messages.map((message, index) => (
    <ThreadPrimitive.MessageByIndex
      key={message.id}
      index={index}
      components={messageComponent ? { Message: messageComponent } : components}
    />
  ))
}

export function RuntimeFixture({
  projection,
  onRuntime,
  onUnexpectedNew,
  messageComponent,
  mode = 'messages',
  listRenderer = 'default',
  keyedList: KeyedList,
}: {
  projection: SpikeProjection
  onRuntime?: (runtime: AssistantRuntime) => void
  onUnexpectedNew?: () => void
  messageComponent?: typeof TextMessage
  mode?: 'messages' | 'repository'
  listRenderer?: 'default' | 'keyed-index'
  keyedList?: ComponentType
}) {
  const messages = useMemo(() => projectVisible(projection), [projection])
  const messageRepository = useMemo(
    () => (mode === 'repository' ? ExportedMessageRepository.fromArray(messages) : undefined),
    [messages, mode],
  )
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    ...(messageRepository ? { messageRepository } : {}),
    isRunning: projection.nodes.some((node) => node.kind === 'assistant' && node.streaming === true),
    onNew: async () => {
      onUnexpectedNew?.()
      throw new Error('spike renderer must not submit a new SDK request')
    },
  })
  useEffect(() => onRuntime?.(runtime), [onRuntime, runtime])

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {KeyedList ? (
        <KeyedList />
      ) : listRenderer === 'keyed-index' ? (
        <KeyedMessages {...(messageComponent ? { messageComponent } : {})} />
      ) : (
        <ThreadPrimitive.Messages
          components={messageComponent ? { Message: messageComponent } : components}
        />
      )}
    </AssistantRuntimeProvider>
  )
}
