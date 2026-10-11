/** Cycle the four task regions without entering a modal or a hidden surface. */
export function cycleTaskFocus(event: KeyboardEvent): void {
  if (event.key !== 'F6' || event.defaultPrevented || document.querySelector('dialog[open]')) return
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
