export type ChannelDialogRequest = {
  sessionId?: string | undefined
  extension?: string
  instanceId?: string
  rebind?: boolean
}
// Composer and home pages can live in separate lazily bundled modules. The shell event joins them.
const eventName = 'agnes-channel-dialog'
let request: ChannelDialogRequest | undefined
export function openChannelDialog(value: ChannelDialogRequest = {}) {
  request = value
  window.dispatchEvent(new CustomEvent(eventName, { detail: value }))
}
export function closeChannelDialog() {
  request = undefined
  window.dispatchEvent(new CustomEvent(eventName))
}
export const channelDialogState = {
  getSnapshot: () => request,
  subscribe: (listener: () => void) => {
    const changed = (event: Event) => {
      request = (event as CustomEvent<ChannelDialogRequest | undefined>).detail
      listener()
    }
    window.addEventListener(eventName, changed)
    return () => window.removeEventListener(eventName, changed)
  },
}
