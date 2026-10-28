type StyleScope = { users: number; observer: MutationObserver; head: HTMLHeadElement }
const scopes = new WeakMap<Document, StyleScope>()

/** Ant Design still injects variable defaults in zeroRuntime mode. Keep them below the theme bridge. */
export function retainAntdStyles(document: Document): () => void {
  let scope = scopes.get(document)
  if (!scope) {
    const { head } = document
    const layer = (style: HTMLStyleElement) => {
      const css = style.textContent ?? ''
      if (!css.trim() || css.trimStart().startsWith('@layer vendor {')) return false
      style.textContent = `@layer vendor {\n${css}\n}`
      return true
    }
    const layerStyles = () => {
      for (const style of document.querySelectorAll<HTMLStyleElement>('style[data-css-hash]')) {
        // cssinjs prepends sheets; the canonical order must precede their first layer use.
        if (layer(style)) head.append(style)
      }
    }
    // The observer runs after antd's layout reads, whose first style resolution would
    // otherwise see the unlayered variable defaults and animate to the themed values.
    const isAntdStyle = (node: Node): node is HTMLStyleElement =>
      node.nodeName === 'STYLE' && (node as Element).hasAttribute('data-rc-order')
    const appendChild = Node.prototype.appendChild
    head.insertBefore = (<T extends Node>(node: T, ref: Node | null) => {
      if (!isAntdStyle(node)) return Node.prototype.insertBefore.call(head, node, ref) as T
      layer(node)
      return appendChild.call(head, node) as T
    }) as typeof head.insertBefore
    head.appendChild = (<T extends Node>(node: T) => {
      if (isAntdStyle(node)) layer(node)
      return appendChild.call(head, node) as T
    }) as typeof head.appendChild
    const observer = new MutationObserver(layerStyles)
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    layerStyles()
    scope = { users: 0, observer, head }
    scopes.set(document, scope)
  }
  scope.users += 1
  let released = false
  return () => {
    if (released) return
    released = true
    scope.users -= 1
    if (scope.users === 0) {
      scope.observer.disconnect()
      delete (scope.head as Partial<HTMLHeadElement>).insertBefore
      delete (scope.head as Partial<HTMLHeadElement>).appendChild
      scopes.delete(document)
    }
  }
}
