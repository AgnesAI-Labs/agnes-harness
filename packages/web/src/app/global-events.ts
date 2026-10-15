/**
 * The workbench's window- and document-level listeners.
 *
 * Page lifecycle, history and the `agnes:*` events other surfaces send to the controller layer are
 * bound here and nowhere else in the controller composition. Every function returns its disposer.
 */

type Stop = () => void

const listen = (target: EventTarget, type: string, handler: (event: Event) => void): Stop => {
  target.addEventListener(type, handler)
  return () => target.removeEventListener(type, handler)
}

/** A terminal navigation releases the app; BFCache freezes it for a later restore. */
export function onPageHide(handler: () => void): void {
  const finish = (event: PageTransitionEvent): void => {
    if (event.persisted) return
    window.removeEventListener('pagehide', finish)
    handler()
  }
  // A persisted event must neither tear down the app nor consume the eventual teardown listener.
  window.addEventListener('pagehide', finish)
}

/** The window regained focus. */
export const onWindowFocus = (handler: () => void): Stop => listen(window, 'focus', handler)

export const pageVisible = (): boolean => document.visibilityState === 'visible'

/** The tab became visible again. */
export const onPageVisible = (handler: () => void): Stop =>
  listen(document, 'visibilitychange', () => {
    if (pageVisible()) handler()
  })

/** Back/forward navigation changed the address. */
export const onHistoryNavigation = (handler: () => void): Stop => listen(window, 'popstate', handler)

/** An `agnes:*` event a rendered surface bubbles to the document. */
export const onSurfaceEvent = (name: `agnes:${string}`, handler: (event: Event) => void): Stop =>
  listen(document, name, handler)

/** An `agnes:*` broadcast on the window, such as a changed package set or session configuration. */
export const onBroadcast = (name: `agnes:${string}`, handler: (event: Event) => void): Stop =>
  listen(window, name, handler)

/** Tell every surface in this document that a preference changed. */
export function broadcast(name: `agnes:${string}`, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}
