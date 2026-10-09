import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { useContext, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { UserMessageReferences } from '../reference-chips.js'
import { assistantMessageParts, userMessageParts } from './assistant-message.js'
import { ConversationMessageContext, ConversationMessageTargetContext, fallbackT } from './context.js'
import { nativeContent } from './message.js'
import { UserMessageFiles, UserMessageImages } from './user-message.js'

// Adapt the v0.11.27 registry message shells while leaving Agnes turn actions in their existing owner.
export function ConversationMessageView() {
  const context = useContext(ConversationMessageContext)
  if (!context) return null
  const { node, props, hideThinking, turnStatus, thinkingHost } = context
  const t = props.t ?? fallbackT
  const native = nativeContent(node, props, hideThinking, turnStatus, thinkingHost)
  const className =
    node.kind === 'user'
      ? 'aui-user-message-root aui:mx-auto aui:grid aui:w-full aui:auto-rows-auto aui:grid-cols-[minmax(72px,1fr)_auto] aui:gap-y-2 aui:px-2'
      : node.kind === 'assistant'
        ? 'aui-assistant-message-root aui:relative aui:mx-auto aui:flex aui:w-full aui:flex-col aui:items-start'
        : undefined

  return (
    <MessagePrimitive.Root
      {...(className ? { className } : {})}
      {...(node.kind === 'user' || node.kind === 'assistant'
        ? { 'data-agnes-assistant-ui-message': node.kind }
        : {})}
    >
      {node.kind === 'user' ? (
        <div
          data-slot="user-message"
          className="aui-user-message-content-wrapper aui:relative aui:col-start-2 aui:min-w-0"
        >
          <div className="aui-user-message-content aui:rounded-3xl aui:border aui:border-[var(--agnes-line-primary)] aui:bg-[var(--agnes-bg-card)] aui:px-5 aui:py-2.5 aui:text-sm aui:leading-relaxed aui:text-[var(--agnes-text-primary)]">
            <p className="node-label">{t('timeline.userLabel')}</p>
            <UserMessageImages node={node} t={t} />
            <UserMessageFiles node={node} />
            <UserMessageReferences node={node} t={t} />
            <MessagePrimitive.Parts components={userMessageParts} />
          </div>
        </div>
      ) : node.kind === 'assistant' ? (
        <>
          <p className="node-label">{t('brand.agent')}</p>
          <div className="aui-assistant-message-content aui:mx-2 aui:self-stretch aui:min-w-0 aui:min-h-[4.25rem] aui:text-sm aui:leading-relaxed aui:text-[var(--agnes-text-primary)]">
            <MessagePrimitive.Parts components={assistantMessageParts} />
          </div>
        </>
      ) : (
        native
      )}
    </MessagePrimitive.Root>
  )
}

export function AssistantUiMessagePortal() {
  const id = useAssistantState(({ message }) => message.id)
  const targetContext = useContext(ConversationMessageTargetContext)
  const target = targetContext?.targets.get(id)
  const isAgnesMessage = target?.context.node.kind === 'user' || target?.context.node.kind === 'assistant'

  useLayoutEffect(() => {
    if (!target || !isAgnesMessage) return
    target.element.dataset.agnesAssistantUiReady = 'true'
    return () => {
      delete target.element.dataset.agnesAssistantUiReady
    }
  }, [target, isAgnesMessage])

  if (!target || !isAgnesMessage) return null
  return createPortal(
    <ConversationMessageContext.Provider value={target.context}>
      <ConversationMessageView />
    </ConversationMessageContext.Provider>,
    target.element,
    id,
  )
}

export const assistantUiMessageComponents = { Message: AssistantUiMessagePortal }
