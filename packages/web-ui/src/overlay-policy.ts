/** Shared baseline layers; nested popups stay in their modal's focus/top-layer scope. */
export const overlayLayers = {
  dropdown: 1000,
  drawer: 1100,
  modal: 1200,
  tooltip: 1300,
  notification: 1400,
} as const

/** Also use this container for any custom/Radix portal supplied by a client contribution. */
export function getOverlayContainer(trigger?: HTMLElement, owner: Document = document): HTMLElement {
  return (
    trigger?.closest<HTMLElement>(
      'dialog[open], [popover], .ant-modal, .ant-drawer-section, .ant-drawer-content, .ant-popover',
    ) ??
    owner.getElementById('agnes-overlay-container') ??
    owner.body
  )
}
