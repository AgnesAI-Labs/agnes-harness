import { Button } from '@agnes/web-ui'
import {
  type ForwardedRef,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
import type { Translate } from './locales/index.js'

export interface ConversationChildContainers {
  transcript: HTMLElement
  emptyState: HTMLElement
  newContentButton: HTMLButtonElement
  messageActions: HTMLElement
  attachments: HTMLElement
  toolCard: HTMLElement
  feedback: HTMLElement
}

export interface ConversationHandle {
  setEmptyStateVisible(visible: boolean): void
  isTranscriptNearBottom(): boolean
}

export interface ConversationProps {
  onMount?(children: ConversationChildContainers): void
  onUnmount?(): void
  /** Locale-bound translate injected by the host; render-time lookup only. */
  translate?: Translate
  slots?: {
    session?: ReactNode
    sessionHeader?: ReactNode
  }
}

const NEW_CONTENT_ICON_PATH = 'M12 5v13M7 13l5 5 5-5'

function nearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 80
}

/**
 * The conversation shell owns the stable child surfaces. Child web units can replace the
 * transcript/empty-state rows while the parent remains mounted, so the app's session bridge
 * never needs to reach into a child implementation.
 */
export const Conversation = forwardRef<ConversationHandle, ConversationProps>(function Conversation(
  { onMount, onUnmount, translate, slots }: ConversationProps,
  ref: ForwardedRef<ConversationHandle>,
) {
  const t: Translate = translate ?? ((key) => key)
  const transcript = useRef<HTMLElement>(null)
  const emptyState = useRef<HTMLElement>(null)
  const newContentButton = useRef<HTMLButtonElement>(null)
  const messageActions = useRef<HTMLDivElement>(null)
  const attachments = useRef<HTMLDivElement>(null)
  const toolCard = useRef<HTMLDivElement>(null)
  const feedback = useRef<HTMLDivElement>(null)

  useImperativeHandle(
    ref,
    () => ({
      setEmptyStateVisible(visible) {
        if (emptyState.current) emptyState.current.hidden = !visible
      },
      isTranscriptNearBottom() {
        return transcript.current ? nearBottom(transcript.current) : false
      },
    }),
    [],
  )

  useLayoutEffect(() => {
    const transcriptElement = transcript.current
    const emptyStateElement = emptyState.current
    const newContentElement = newContentButton.current
    if (
      !transcriptElement ||
      !emptyStateElement ||
      !newContentElement ||
      !messageActions.current ||
      !attachments.current ||
      !toolCard.current ||
      !feedback.current
    )
      return
    onMount?.({
      transcript: transcriptElement,
      emptyState: emptyStateElement,
      newContentButton: newContentElement,
      messageActions: messageActions.current,
      attachments: attachments.current,
      toolCard: toolCard.current,
      feedback: feedback.current,
    })
    return onUnmount
  }, [onMount, onUnmount])

  return (
    <div
      className="conversation-region-root"
      data-agnes-region-owner="builtin"
      data-agnes-region-unit="conversation"
    >
      <div style={{ display: 'contents' }} data-agnes-conversation-dsh="session">
        {slots?.sessionHeader}
        {slots?.session}
      </div>
      <section
        ref={transcript}
        id="transcript"
        data-agnes-region="transcript"
        aria-label={t('conversation.transcriptAria')}
        tabIndex={-1}
      />
      <section
        ref={emptyState}
        id="empty-state"
        data-agnes-region="empty-state"
        aria-labelledby="empty-state-title"
        hidden={true}
      />
      <Button
        ref={newContentButton}
        id="new-content"
        className="new-content"
        htmlType="button"
        shape="circle"
        title={t('conversation.newContent')}
        hidden={true}
      >
        <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden={true}>
          <path d={NEW_CONTENT_ICON_PATH} />
        </svg>
        <span className="visually-hidden">{t('conversation.newContent')}</span>
      </Button>
      <div
        ref={messageActions}
        style={{ display: 'contents' }}
        data-agnes-conversation-slot="message-actions"
      />
      <div ref={attachments} style={{ display: 'contents' }} data-agnes-conversation-slot="attachments" />
      <div ref={toolCard} style={{ display: 'contents' }} data-agnes-conversation-slot="tool-card" />
      <div ref={feedback} style={{ display: 'contents' }} data-agnes-conversation-slot="feedback" />
    </div>
  )
})
