/** Keep a native host visible while a detail surface temporarily owns modal focus. */
export function releaseDialogModal(host: HTMLDialogElement | null): () => void {
  if (!host?.open || !host.matches(':modal')) return () => {}
  const focused = host.ownerDocument.activeElement
  host.close()
  host.show()
  if (focused instanceof HTMLElement && focused.isConnected) focused.focus()
  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (!host.isConnected || !host.open) return
    host.close()
    host.showModal()
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus()
  }
}

/** A host marked as a page draws in place inside the page that holds it, not over everything. */
export function isPageDialog(host: HTMLDialogElement): boolean {
  return host.dataset.presentation === 'page'
}

/**
 * Open a native host: in place when it is presented as a page, as a modal otherwise. Opening an
 * open host does nothing, so a refresh that renders it again never throws.
 */
export function showDialogHost(host: HTMLDialogElement): void {
  if (host.open) return
  try {
    if (isPageDialog(host)) host.show()
    else host.showModal()
  } catch {
    host.setAttribute('open', '')
  }
}

/**
 * Close a host the way its own Escape does: its `cancel` listeners run their clean-up (focus
 * return, cleared selection) and may keep it open; a host with no listener closes.
 */
export function cancelDialogHost(host: HTMLDialogElement): void {
  if (!host.open) return
  if (!host.dispatchEvent(new Event('cancel', { cancelable: true }))) return
  if (host.open) host.close()
}
