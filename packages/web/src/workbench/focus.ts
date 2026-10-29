/** Cycle visible task regions without entering a modal or a hidden surface. */
export function cycleTaskFocus(event: KeyboardEvent): void {
  if (event.key !== 'F6' || event.defaultPrevented) return
  const modal = [
    ...document.querySelectorAll<HTMLElement>(
      'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
    ),
  ].some((node) => node.getClientRects().length > 0 && !node.closest('[hidden]'))
  if (modal) return
  const regions = [
    '.sidebar',
    '.conversation-shell',
    '#trace-panel',
    '#workbench-right',
    '#rightbar-panel',
    '#workbench-bottom',
    '#composer',
  ]
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .filter(
      (region): region is HTMLElement =>
        !!region &&
        !region.closest('[hidden], [inert]') &&
        region.getClientRects().length > 0 &&
        getComputedStyle(region).visibility !== 'hidden',
    )
  if (!regions.length) return
  const current = regions.findIndex((region) => region.contains(document.activeElement))
  const index = current < 0 ? (event.shiftKey ? 0 : -1) : current
  const next = regions[(index + (event.shiftKey ? -1 : 1) + regions.length) % regions.length]
  if (!next) return
  event.preventDefault()
  const active = document.activeElement
  for (const id of ['workbench-right', 'workbench-bottom']) {
    const overlay = document.getElementById(id)
    if (
      overlay?.contains(active) &&
      !overlay.contains(next) &&
      (getComputedStyle(overlay).position === 'fixed' ||
        (getComputedStyle(overlay).position === 'absolute' && window.innerWidth < 1280))
    )
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  }
  const target =
    [
      ...next.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]',
      ),
    ].find(
      (node) =>
        !node.closest('[hidden], [inert]') &&
        node.tabIndex >= 0 &&
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility !== 'hidden',
    ) ?? next
  if (target === next) target.tabIndex = -1
  target.focus()
}
