import { workbenchNavigation } from '@agnes/web-client'

const browserTools = new Set([
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_scroll',
  'browser_navigate',
  'browser_tabs',
  'browser_tab',
  'browser_screenshot',
])

// Observe the already-attached session; never create another subscription or poll the browser.
export function autoOpenBrowser(ctx) {
  let detach = () => {}
  let disposed = false
  const bind = () => {
    detach()
    const id = ctx.session.getSnapshot()
    if (!id || ctx.session.readiness.getSnapshot().status !== 'ready') return
    const handle = ctx.agnes.sessions.get(id)
    if (!handle) return
    let through = handle.cursor().fromSeq
    let opened = false
    const listener = (method, params) => {
      const event = params.event
      if (
        disposed ||
        ctx.session.getSnapshot() !== id ||
        method !== '_agnes/v1/session.event' ||
        params.sessionId !== id ||
        !event ||
        event.seq <= through
      )
        return
      through = event.seq
      if ((event.lane ?? 'main') !== 'main') return
      if (event.type === 'turn/start') opened = false
      if (
        event.type !== 'tool/call' ||
        event.origin !== 'model' ||
        event.trust !== 'trusted' ||
        !browserTools.has(event.data?.name) ||
        opened
      )
        return
      // Once per turn: closing the panel while the agent continues must remain effective.
      opened = workbenchNavigation.open('browser')
    }
    handle.listeners.add(listener)
    detach = () => handle.listeners.delete(listener)
  }
  const offSession = ctx.session.subscribe(bind)
  const offReady = ctx.session.readiness.subscribe(bind)
  bind()
  return () => {
    disposed = true
    offSession()
    offReady()
    detach()
  }
}
