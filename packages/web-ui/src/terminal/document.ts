/** Give only this emulator's DOM the same style authorization as the application UI. */
export function terminalDocument(owner: Document): Document {
  const nonce = owner.querySelector<HTMLMetaElement>('meta[name="agnes-csp-nonce"]')?.content
  return new Proxy(owner, {
    get(target, key) {
      if (key === 'createElement')
        return new Proxy(target.createElement, {
          // Forward xterm's own creation calls; this adapter adds no independent UI nodes.
          apply(createElement, _receiver, [tag, options]: [string, ElementCreationOptions?]) {
            const element: HTMLElement = Reflect.apply(createElement, target, [tag, options])
            if (tag === 'style') {
              if (nonce) element.setAttribute('nonce', nonce)
              // xterm owns these generated rules; keep them below the app and skin layers.
              Object.defineProperty(element, 'textContent', {
                get: () => [...element.childNodes].map((node) => node.textContent ?? '').join(''),
                set: (css: string | null) =>
                  element.replaceChildren(target.createTextNode(`@layer vendor {\n${css ?? ''}\n}`)),
              })
            } else if (tag === 'span') {
              const setAttribute = element.setAttribute.bind(element)
              // CSP permits CSSOM writes, while setAttribute('style', ...) is an inline style violation.
              let writingStyle = false
              element.setAttribute = (name, value) => {
                if (name.toLowerCase() !== 'style' || writingStyle) {
                  setAttribute(name, value)
                  return
                }
                // DOM emulators can implement cssText through setAttribute; don't recurse there.
                writingStyle = true
                try {
                  element.style.cssText = value
                } finally {
                  writingStyle = false
                }
              }
            }
            return element
          },
        })
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' && key !== 'constructor' ? value.bind(target) : value
    },
  })
}
