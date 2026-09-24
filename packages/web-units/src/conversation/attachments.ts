export interface ConversationAttachmentsRenderer {
  readonly element: HTMLElement
  clear(): void
}

/**
 * The current protocol has no attachment node. Keep the surface explicit and
 * empty rather than manufacturing attachment content in the conversation host.
 */
export function createConversationAttachmentsRenderer(): ConversationAttachmentsRenderer {
  const element = document.createElement('div')
  element.className = 'conversation-attachments'
  element.hidden = true
  element.setAttribute('data-agnes-conversation-renderer', 'attachments')
  return {
    element,
    clear() {
      element.replaceChildren()
      element.hidden = true
    },
  }
}
