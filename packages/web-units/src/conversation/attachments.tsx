import { createRegionHost, renderRegion, unmountRegion } from '@agnes/web-ui'

export interface ConversationAttachmentsRenderer {
  readonly element: HTMLElement
  clear(): void
  dispose(): void
}

/** The protocol has no attachment node; keep this explicit surface empty. */
export function createConversationAttachmentsRenderer(): ConversationAttachmentsRenderer {
  const host = createRegionHost(document.body, 'div')
  host.remove()
  host.className = 'conversation-attachments'
  host.hidden = true
  host.dataset.agnesConversationRenderer = 'attachments'
  renderRegion(host, null)
  const element = host
  let disposed = false
  return {
    element,
    clear() {
      if (disposed) return
      element.replaceChildren()
      element.hidden = true
    },
    dispose() {
      if (disposed) return
      disposed = true
      queueMicrotask(() => unmountRegion(host))
    },
  }
}
