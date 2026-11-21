import { BACKEND_FRAME_MESSAGE } from './frame-contract.js'
import { localWorkbenchRoute } from './local-route.js'

/** The outer window owns history for shareable routes. The local frame still runs the page routers. */
export function installLocalFrameRouting(parentOrigin: string) {
  const push = history.pushState
  const replace = history.replaceState
  const routeOf = (url: URL) => localWorkbenchRoute(`/${url.search}${url.hash}`)
  const currentRoute = () => routeOf(new URL(location.href))
  // Keep the existing push-stack state local when traversing within this frame's lifetime.
  const states = new Map<string, unknown>()
  let restoring = false
  const publish = (operation: 'push' | 'replace') => {
    const route = currentRoute()
    if (!route) return
    states.set(route, history.state)
    if (states.size > 64) states.delete(states.keys().next().value ?? '')
    window.parent.postMessage(
      { type: BACKEND_FRAME_MESSAGE, kind: 'local-route', route, operation },
      parentOrigin,
    )
  }
  history.pushState = (state, unused, url) => {
    const next = url == null ? undefined : new URL(url, location.href)
    const destination = next?.origin === location.origin && next.pathname === '/' ? routeOf(next) : undefined
    if (!destination || destination === currentRoute()) {
      push.call(history, state, unused, url)
      return
    }
    replace.call(history, state, unused, url)
    if (!restoring) publish('push')
  }
  history.replaceState = (state, unused, url) => {
    const before = currentRoute()
    replace.call(history, state, unused, url)
    if (!restoring && before !== currentRoute()) publish('replace')
  }
  return {
    sync() {
      publish('replace')
    },
    restore(route: string) {
      if (route !== currentRoute()) {
        restoring = true
        try {
          replace.call(history, states.get(route) ?? null, '', route)
          window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
        } finally {
          restoring = false
        }
      }
      publish('replace')
    },
    dispose() {
      history.pushState = push
      history.replaceState = replace
    },
  }
}
