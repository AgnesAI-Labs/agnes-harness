import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

/** Keep axe's CSSOM preload working under the real page CSP, without exempting page styles. */
export async function scanAccessibility(
  page: Page,
  rules?: string[],
): Promise<Awaited<ReturnType<AxeBuilder['analyze']>>> {
  const restores = await Promise.all(
    page.frames().map((frame) =>
      frame.evaluateHandle(() => {
        const nonce = document.querySelector<HTMLMetaElement>('meta[name="agnes-csp-nonce"]')?.content
        if (!nonce) return () => undefined
        const implementation = document.implementation
        const original = implementation.createHTMLDocument
        const own = Object.getOwnPropertyDescriptor(implementation, 'createHTMLDocument')
        implementation.createHTMLDocument = (title) => {
          const detached = original.call(implementation, title)
          // axe preloads CSS into this detached document. The live document is never patched.
          if (title === 'Dynamic document for loading cssom') {
            const append = detached.head.appendChild.bind(detached.head)
            detached.head.appendChild = <T extends Node>(node: T): T => {
              if (node instanceof HTMLStyleElement) node.nonce = nonce
              return append(node)
            }
          }
          return detached
        }
        return () => {
          if (own) Object.defineProperty(implementation, 'createHTMLDocument', own)
          else Reflect.deleteProperty(implementation, 'createHTMLDocument')
        }
      }),
    ),
  )
  try {
    const scanner = new AxeBuilder({ page })
    return await (rules
      ? scanner.withRules(rules)
      : scanner.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    ).analyze()
  } finally {
    for (const restore of restores) {
      await restore.evaluate((release) => release())
      await restore.dispose()
    }
  }
}
