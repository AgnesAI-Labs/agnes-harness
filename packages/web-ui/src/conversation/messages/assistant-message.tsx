import { type RefObject, useRef } from 'react'
import type { Translate } from '../../locales/index.js'
import { useInteractionSnapshot } from '../markdown-snapshot.js'
import type { AssistantNode, ConversationMarkdownState, ConversationMessagesProps } from './context.js'
import { Thinking } from './thinking.js'

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
  const disclosure = useRef<HTMLDivElement>(null)
  const shownActive = useInteractionSnapshot(disclosure, active)
  const shownThinking = useInteractionSnapshot(disclosure, Boolean(node.thinking?.trim()))
  const body =
    node.lostChars !== undefined && !node.text
      ? t('timeline.lostOutput', { count: node.lostChars })
      : node.text
  return (
    <>
      <p className="node-label">{t('brand.agent')}</p>
      {!hideThinking && shownThinking && (
        <Thinking
          disclosure={disclosure}
          active={shownActive}
          label={t('timeline.thinkingSummary')}
          contentRef={thinkingHost}
        >
          {renderMarkdown ? renderMarkdown(node.thinking ?? '', 'thinking', state) : node.thinking}
        </Thinking>
      )}
      <div key="body" className="node-body markdown">
        {renderMarkdown ? renderMarkdown(body, 'body', state) : body}
      </div>
    </>
  )
}
