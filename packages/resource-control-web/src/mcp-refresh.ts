/** Revalidate visible MCP panels on real invalidations or return to the panel, without a timer. */
export function watchMcpPanel(options: {
  root: HTMLElement
  visible(): boolean
  refresh(): Promise<void>
}): () => void {
  let disposed = false
  let busy = false
  let dirty = false
  const visible = () => !disposed && options.root.isConnected && !document.hidden && options.visible()
  let active = visible()
  const refresh = async () => {
    if (!visible() || busy) return
    busy = true
    try {
      do {
        dirty = false
        await options.refresh()
      } while (dirty && visible())
    } catch {
      /* The panel owns its explicit load failures. */
    } finally {
      busy = false
    }
  }
  const invalidate = () => {
    dirty = true
    void refresh()
  }
  const update = () => {
    const next = visible()
    if (next && !active) invalidate()
    active = next
  }
  const observer = new MutationObserver(update)
  observer.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ['hidden', 'aria-selected'],
  })
  const events = ['agnes:plugins-invalidated', 'agnes:packages-changed', 'agnes:resources-changed', 'online']
  for (const event of events) window.addEventListener(event, invalidate)
  document.addEventListener('visibilitychange', update)
  const dispose = () => {
    disposed = true
    observer.disconnect()
    for (const event of events) window.removeEventListener(event, invalidate)
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('pagehide', dispose)
  }
  window.addEventListener('pagehide', dispose)
  return dispose
}

/** Active resource operations back off, pause while hidden, and release waits on disposal. */
export function resourcePollDelay(attempt: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let elapsed = false
    const finish = () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const wake = () => {
      if (elapsed && !document.hidden) finish()
    }
    const timer = setTimeout(
      () => {
        elapsed = true
        wake()
      },
      // Local state changes usually finish before a 500ms poll; slow operations still back off.
      attempt < 3 ? 50 * 2 ** attempt : Math.min(30_000, 500 * 2 ** Math.min(6, attempt - 3)),
    )
    document.addEventListener('visibilitychange', wake)
    signal.addEventListener('abort', finish, { once: true })
  })
}
