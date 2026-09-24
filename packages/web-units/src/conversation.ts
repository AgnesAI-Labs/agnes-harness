import {
  createElement,
  type ForwardedRef,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'

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
  { onMount, onUnmount, slots }: ConversationProps,
  ref: ForwardedRef<ConversationHandle>,
) {
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

  return createElement(
    'div',
    {
      className: 'conversation-region-root',
      'data-agnes-region-owner': 'builtin',
      'data-agnes-region-unit': 'conversation',
    },
    createElement(
      'div',
      { style: { display: 'contents' }, 'data-agnes-conversation-dsh': 'session' },
      slots?.sessionHeader,
      slots?.session,
    ),
    createElement('section', {
      ref: transcript,
      id: 'transcript',
      'data-agnes-region': 'transcript',
      'aria-label': '对话',
      tabIndex: -1,
    }),
    createElement('section', {
      ref: emptyState,
      id: 'empty-state',
      'data-agnes-region': 'empty-state',
      'aria-labelledby': 'empty-state-title',
      hidden: true,
    }),
    createElement(
      'button',
      { ref: newContentButton, id: 'new-content', className: 'new-content', type: 'button', hidden: true },
      createElement(
        'svg',
        { className: 'icon', 'data-agnes-region': 'icon', viewBox: '0 0 24 24', 'aria-hidden': true },
        createElement('path', { d: NEW_CONTENT_ICON_PATH }),
      ),
      createElement('span', null, '有新内容'),
    ),
    // These outlet hosts are intentionally display-contents: card renderers own the existing
    // timeline layout, while independently replaceable units get stable child mount points.
    createElement('div', {
      ref: messageActions,
      style: { display: 'contents' },
      'data-agnes-conversation-slot': 'message-actions',
    }),
    createElement('div', {
      ref: attachments,
      style: { display: 'contents' },
      'data-agnes-conversation-slot': 'attachments',
    }),
    createElement('div', {
      ref: toolCard,
      style: { display: 'contents' },
      'data-agnes-conversation-slot': 'tool-card',
    }),
    createElement('div', {
      ref: feedback,
      style: { display: 'contents' },
      'data-agnes-conversation-slot': 'feedback',
    }),
  )
})
