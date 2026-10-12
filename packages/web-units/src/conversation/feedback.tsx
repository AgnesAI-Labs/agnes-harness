import { createRegionHost, renderRegion, unmountRegion } from '@agnes/web-ui'

export interface ConversationFeedback {
  readonly element: HTMLElement
  clear(): void
  report(message: string, durationMs?: number): void
  dispose(): void
}

/** A turn-local live region with an independently owned dismissal timer. */
export function createConversationFeedback(): ConversationFeedback {
  const host = createRegionHost(document.body, 'span')
  host.remove()
  host.className = 'turn-feedback'
  host.setAttribute('role', 'status')
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const render = (message: string) => renderRegion(host, message)
  render('')
  const element = host
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!disposed) render('')
  }
  return {
    element,
    clear,
    report(message, durationMs) {
      if (disposed) return
      clear()
      render(message)
      if (durationMs !== undefined) timer = setTimeout(clear, durationMs)
    },
    dispose() {
      if (disposed) return
      clear()
      disposed = true
      queueMicrotask(() => unmountRegion(host))
    },
  }
}
