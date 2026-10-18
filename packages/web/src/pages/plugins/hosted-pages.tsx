import { cancelDialogHost, PushPage, usePushStack } from '@agnes/web-ui'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** What a deep link found: the controller opened it, needs its data first, or has no such item. */
export type HostedOpen = 'opened' | 'pending' | 'missing'

/** Route segments some hosted page owns; a flow that moves from one to the next replaces the top. */
const hostedOwners = new Set<(segment: string) => boolean>()
const isHosted = (segment: string | undefined) => !!segment && [...hostedOwners].some((owns) => owns(segment))

/**
 * A controller draws a detail or a form into a native `<dialog>` it found by id. Inside this page
 * that host is a pushed page instead: it opens in place, its segment goes into the address, back
 * (the header, a breadcrumb or the browser) closes it the way its own Escape does, and a link that
 * names it asks the controller to open it.
 */
export function useHostedDialog({
  id,
  pageOf,
  owns,
  open,
  ready,
  returnFocus,
}: {
  /** The host's element id. */
  id: string
  /** The segment for what the open host shows, read from its controller. */
  pageOf(host: HTMLDialogElement): string | undefined
  owns(segment: string): boolean
  /** Ask the controller to show this segment, for a link or a forward step. */
  open(segment: string): HostedOpen
  /** Changes whenever the controller's data changes, so a pending link is tried again. */
  ready: unknown
  /** Focus the invoking control after a page closes and its parent is visible again. */
  returnFocus?(): HTMLElement | null | undefined
}): HTMLDialogElement | undefined {
  const nav = usePushStack()
  const navRef = useRef(nav)
  navRef.current = nav
  const latest = useRef({ pageOf, owns, open, returnFocus })
  latest.current = { pageOf, owns, open, returnFocus }
  const [host, setHost] = useState<HTMLDialogElement>()
  const shown = useRef<string>()
  const [restoreFocus, setRestoreFocus] = useState(false)
  useLayoutEffect(() => {
    const element = document.getElementById(id)
    if (!(element instanceof HTMLDialogElement)) return
    const owner = (segment: string) => latest.current.owns(segment)
    hostedOwners.add(owner)
    element.dataset.presentation = 'page'
    setHost(element)
    let active = true
    const observer = new MutationObserver(() => {
      const top = navRef.current.stack.at(-1)
      if (element.open) {
        const segment = latest.current.pageOf(element)
        if (!segment) return
        shown.current = segment
        if (segment === top) return
        // A finished step of a flow gives way to the next; anything else is a new level.
        if (isHosted(top)) navRef.current.replace(segment)
        else navRef.current.open(segment)
        return
      }
      const closed = shown.current
      shown.current = undefined
      if (!closed) return
      // Another host may open in the same turn (a form gives way to the detail it produced):
      // wait for it, and finish only if nothing replaced this page. A completed controller flow
      // commits its route at once; a pending history traversal could reopen it on a data refresh.
      setTimeout(() => {
        if (!active) return
        if (navRef.current.stack.at(-1) === closed) {
          navRef.current.finish()
          setRestoreFocus(true)
        }
      })
    })
    observer.observe(element, { attributes: true, attributeFilter: ['open'] })
    return () => {
      active = false
      observer.disconnect()
      hostedOwners.delete(owner)
      delete element.dataset.presentation
      // Leaving the page leaves its pages: the host is a modal again for anyone else.
      if (element.open) cancelDialogHost(element)
    }
  }, [id])
  const top = nav.stack.at(-1)
  const levels = nav.stack.join('/')
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of the stack or of the controller's data is what makes this check again.
  useEffect(() => {
    if (!host) return
    if (host.open) {
      // Back, a breadcrumb or the browser left this page: close it as its own Escape would. A host
      // that has just opened and is not in the stack yet is the controller's, not a step back.
      const showing = shown.current
      if (!showing || navRef.current.stack.includes(showing)) return
      shown.current = undefined
      // The controller commits synchronously when it closes; let this commit finish first.
      let current = true
      queueMicrotask(() => {
        if (!current) return
        cancelDialogHost(host)
        setRestoreFocus(true)
      })
      return () => {
        current = false
      }
    }
    if (!top || !latest.current.owns(top)) return
    let current = true
    queueMicrotask(() => {
      if (!current || host.open || navRef.current.stack.at(-1) !== top) return
      const result = latest.current.open(top)
      if (result === 'missing') navRef.current.back()
      // A host takes focus as it opens; on a link the page's title already had it, so give it back.
      else if (result === 'opened' && host.contains(document.activeElement))
        document.querySelector<HTMLElement>('.agh-push-header h2')?.focus({ preventScroll: true })
    })
    return () => {
      current = false
    }
  }, [host, top, levels, ready])
  useEffect(() => {
    if (!restoreFocus) return
    if (!isHosted(top)) latest.current.returnFocus?.()?.focus({ preventScroll: true })
    setRestoreFocus(false)
  }, [restoreFocus, top])
  return host
}

/**
 * The pushed page a host shows in: while the page is in the stack the host element sits in its
 * body, and it goes back where it was when the page leaves, so the controller never loses it.
 */
export function HostedPage({
  segment,
  host,
  title,
  description,
}: {
  segment: string
  host: HTMLDialogElement | undefined
  title: ReactNode
  description?: ReactNode
}) {
  return (
    <PushPage id={segment} title={title} description={description}>
      {host && <Adopt node={host} />}
    </PushPage>
  )
}

function Adopt({ node }: { node: HTMLElement }) {
  const slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const target = slot.current
    const home = node.parentNode
    if (!target || !home) return
    const marker = document.createComment('hosted page')
    home.replaceChild(marker, node)
    target.appendChild(node)
    return () => {
      if (marker.parentNode) marker.parentNode.replaceChild(node, marker)
      else node.remove()
    }
  }, [node])
  return <div ref={slot} className="plugins-page-hosted" />
}
