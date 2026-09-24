export interface ConversationFeedback {
  readonly element: HTMLElement
  clear(): void
  report(message: string, durationMs?: number): void
  dispose(): void
}

/**
 * A turn-local live region. It owns its dismissal timer so replacing one turn
 * cannot clear feedback belonging to a sibling turn.
 */
export function createConversationFeedback(): ConversationFeedback {
  const element = document.createElement('span')
  element.className = 'turn-feedback'
  element.setAttribute('role', 'status')
  let timer: ReturnType<typeof setTimeout> | undefined

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    element.textContent = ''
  }

  return {
    element,
    clear,
    report(message, durationMs) {
      clear()
      element.textContent = message
      if (durationMs !== undefined) {
        timer = setTimeout(() => {
          timer = undefined
          if (element.textContent === message) element.textContent = ''
        }, durationMs)
      }
    },
    dispose: clear,
  }
}
