import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

export type RegionElement = ReactNode

const roots = new Map<HTMLElement, Root>()

/**
 * Mount one replaceable React surface. Host code must use the returned disposer (or
 * unmountRegion) so it never removes a subtree that React still owns.
 */
export function mountRegion(host: HTMLElement, element: RegionElement): () => void {
  if (roots.has(host)) throw new Error('React region is already mounted')
  const root = createRoot(host)
  roots.set(host, root)
  flushSync(() => root.render(element))
  let active = true
  return () => {
    if (!active) return
    active = false
    if (roots.get(host) !== root) return
    root.unmount()
    roots.delete(host)
  }
}

/** Replace the element owned by an already-mounted region without replacing its root. */
export function renderRegion(host: HTMLElement, element: RegionElement): void {
  const root = roots.get(host)
  if (!root) {
    mountRegion(host, element)
    return
  }
  flushSync(() => root.render(element))
}

/** Create a stable host for a short-lived React surface owned by the caller. */
export function createRegionHost(
  parent: HTMLElement,
  tagName: keyof HTMLElementTagNameMap,
  className?: string,
): HTMLElement {
  const owner = parent.ownerDocument ?? globalThis.document
  const host = owner.createElement(tagName)
  if (className) host.className = className
  parent.append(host)
  return host
}

export function unmountRegion(host: HTMLElement): void {
  roots.get(host)?.unmount()
  roots.delete(host)
}
