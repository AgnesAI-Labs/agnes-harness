/** Cycle the four task regions without entering a modal or a hidden surface. */
export function cycleTaskFocus(event: KeyboardEvent): void {
  if (event.key !== 'F6' || event.defaultPrevented) return
  const modal = [
    ...document.querySelectorAll<HTMLElement>(
      'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
    ),
  ].some((node) => node.getClientRects().length > 0 && !node.closest('[hidden]'))
  if (modal) return
  const regions = ['.sidebar', '.conversation-shell', '#workbench-right:not([hidden])', '#composer']
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .filter(
      (region): region is HTMLElement =>
        !!region && !region.closest('[hidden], [inert]') && region.getClientRects().length > 0,
    )
  if (!regions.length) return
  const current = regions.findIndex((region) => region.contains(document.activeElement))
  const index = current < 0 ? (event.shiftKey ? 0 : -1) : current
  const next = regions[(index + (event.shiftKey ? -1 : 1) + regions.length) % regions.length]
  if (!next) return
  event.preventDefault()
  const overlay = document.getElementById('workbench-right')
  if (window.innerWidth < 1280 && overlay?.contains(document.activeElement) && !overlay.contains(next))
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  const target =
    [
      ...next.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]',
      ),
    ].find(
      (node) =>
        !node.closest('[hidden], [inert]') &&
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility !== 'hidden',
    ) ?? next
  if (target === next) target.tabIndex = -1
  target.focus()
}
