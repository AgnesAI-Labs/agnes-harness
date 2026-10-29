/** Create a stable host for a short-lived React surface owned by the caller. */
export function createRegionHost(
  parent: HTMLElement,
  tagName: keyof HTMLElementTagNameMap,
  className?: string,
): HTMLElement {
  const owner = parent.ownerDocument ?? globalThis.document
  const host = owner.createElement(tagName)
  if (className) host.className = className
  const target = parent === owner.body ? (owner.getElementById('agnes-overlay-container') ?? parent) : parent
  target.append(host)
  return host
}
