/** Refresh while the MCP panel is visible, with a finite window and no overlapping requests. */
export function watchMcpPanel(options: {
  root: HTMLElement
  visible(): boolean
  refresh(): Promise<void>
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = false
  let remaining = 0
  let disposed = false
  let busy = false
  const schedule = () => {
    if (disposed || !active || busy || timer || remaining <= 0) return
    timer = setTimeout(async () => {
      timer = undefined
      if (disposed || !options.visible() || document.hidden) {
        update()
        return
      }
      remaining--
      busy = true
      try {
        await options.refresh()
      } catch {
        /* Opening the pane still exposes explicit load failures. */
      } finally {
        busy = false
        schedule()
      }
    }, 2_000)
  }
  const update = () => {
    const next = !disposed && options.root.isConnected && !document.hidden && options.visible()
    if (next && !active) remaining = 60
    active = next
    if (!active) {
      clearTimeout(timer)
      timer = undefined
    } else schedule()
  }
  const observer = new MutationObserver(update)
  observer.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ['hidden', 'aria-selected'],
  })
  document.addEventListener('visibilitychange', update)
  const dispose = () => {
    disposed = true
    clearTimeout(timer)
    observer.disconnect()
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('pagehide', dispose)
  }
  window.addEventListener('pagehide', dispose)
  update()
  return dispose
}
