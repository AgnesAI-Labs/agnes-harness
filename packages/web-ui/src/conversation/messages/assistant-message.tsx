import { type RefObject, useContext, useLayoutEffect, useRef } from 'react'
import type { Translate } from '../../locales/index.js'
import { useInteractionSnapshot } from '../markdown-snapshot.js'
import {
  type AssistantNode,
  type ConversationMarkdownState,
  type ConversationMessagesProps,
  ConversationMessageContext,
  fallbackT,
} from './context.js'
import { markdownState } from './markdown-state.js'

export function AssistantMessage({
  node,
  state,
  renderMarkdown,
  hideThinking = false,
  thinkingHost,
  t,
}: {
  node: AssistantNode
  state: ConversationMarkdownState
  renderMarkdown?: ConversationMessagesProps['renderMarkdown']
  hideThinking?: boolean
  thinkingHost?: RefObject<HTMLDivElement> | undefined
  t: Translate
}) {
  const active = Boolean(node.thinking?.trim()) && state.streaming && node.text.trim() === ''
  const wasActive = useRef(active)
  const initiallyActive = useRef(active)
  const disclosure = useRef<HTMLDetailsElement>(null)
  const shownActive = useInteractionSnapshot(disclosure, active)
  const shownThinking = useInteractionSnapshot(disclosure, Boolean(node.thinking?.trim()))
  useLayoutEffect(() => {
    if (disclosure.current && wasActive.current !== shownActive) disclosure.current.open = shownActive
    wasActive.current = shownActive
  }, [shownActive])
  useLayoutEffect(() => {
    if (disclosure.current) disclosure.current.open = initiallyActive.current
  }, [])
  const body =
    node.lostChars !== undefined && !node.text
      ? t('timeline.lostOutput', { count: node.lostChars })
      : node.text
  return (
    <>
      <p className="node-label">{t('brand.agent')}</p>
      {!hideThinking && (
        <details ref={disclosure} className="thinking" hidden={!shownThinking}>
          <summary>{t('timeline.thinkingSummary')}</summary>
          <div ref={thinkingHost} className="thinking-content markdown">
            {renderMarkdown ? renderMarkdown(node.thinking ?? '', 'thinking', state) : node.thinking}
          </div>
        </details>
      )}
      <div key="body" className="node-body markdown">
        {renderMarkdown ? renderMarkdown(body, 'body', state) : body}
      </div>
    </>
  )
}

export function UserTextPart({ text }: { text: string }) {
  return (
    <div
      className="node-body aui:mt-0 aui:rounded-none aui:border-0 aui:bg-transparent aui:p-0 aui:text-sm aui:leading-5 aui:text-[var(--agnes-text-primary)]"
      data-assistant-ui-part="text"
    >
      {text}
    </div>
  )
}

export function AssistantTextPart({ text }: { text: string }) {
  const context = useContext(ConversationMessageContext)
  const node = context?.node
  const t = context?.props.t ?? fallbackT
  const source =
    node?.kind === 'assistant' && node.lostChars !== undefined && !node.text
      ? t('timeline.lostOutput', { count: node.lostChars })
      : text
  const state = node ? markdownState(node, context?.turnStatus) : undefined
  return (
    <div className="node-body markdown" data-assistant-ui-part="text">
      {context?.props.renderMarkdown ? context.props.renderMarkdown(source, 'body', state) : source}
    </div>
  )
}

export function AssistantReasoningPart({ text }: { text: string }) {
  const context = useContext(ConversationMessageContext)
  const node = context?.node
  const assistant = node?.kind === 'assistant' ? node : undefined
  const state = assistant ? markdownState(assistant, context?.turnStatus) : undefined
  const active = Boolean(text.trim()) && Boolean(state?.streaming) && !assistant?.text.trim()
  const wasActive = useRef(active)
  const initiallyActive = useRef(active)
  const disclosure = useRef<HTMLDetailsElement>(null)
  const shownActive = useInteractionSnapshot(disclosure, active)
  const shownThinking = useInteractionSnapshot(disclosure, Boolean(text.trim()))
  useLayoutEffect(() => {
    if (disclosure.current && wasActive.current !== shownActive) disclosure.current.open = shownActive
    wasActive.current = shownActive
  }, [shownActive])
  useLayoutEffect(() => {
    if (disclosure.current) disclosure.current.open = initiallyActive.current
  }, [])
  if (!context || !assistant || context.hideThinking) return null
  const t = context.props.t ?? fallbackT
  return (
    <details ref={disclosure} className="thinking" data-assistant-ui-part="reasoning" hidden={!shownThinking}>
      <summary>{t('timeline.thinkingSummary')}</summary>
      <div ref={context.thinkingHost} className="thinking-content markdown">
        {context.props.renderMarkdown ? context.props.renderMarkdown(text, 'thinking', state) : text}
      </div>
    </details>
  )
}

export const userMessageParts = { Text: UserTextPart }

export const assistantMessageParts = { Text: AssistantTextPart, Reasoning: AssistantReasoningPart }
