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
