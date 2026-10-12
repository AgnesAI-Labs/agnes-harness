type StyleScope = { users: number; observer: MutationObserver }
const scopes = new WeakMap<Document, StyleScope>()

/** Ant Design still injects variable defaults in zeroRuntime mode. Keep them below the theme bridge. */
export function retainAntdStyles(document: Document): () => void {
  let scope = scopes.get(document)
  if (!scope) {
    const layerStyles = () => {
      for (const style of document.querySelectorAll<HTMLStyleElement>('style[data-css-hash]')) {
        const css = style.textContent ?? ''
        if (css.trim() && !css.trimStart().startsWith('@layer vendor {')) {
          style.textContent = `@layer vendor {\n${css}\n}`
          // cssinjs prepends sheets; the canonical order must precede their first layer use.
          document.head.append(style)
        }
      }
    }
    const observer = new MutationObserver(layerStyles)
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    layerStyles()
    scope = { users: 0, observer }
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
      scopes.delete(document)
    }
  }
}
