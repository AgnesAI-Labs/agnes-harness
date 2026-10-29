import type { PreparedClientStyles, ReadyClientModule } from './contracts.js'

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function prepareDocumentStyles(
  target: ReadyClientModule,
  timeoutMs: number,
): Promise<PreparedClientStyles> {
  if (target.styleUrls.length === 0) return { activate() {}, dispose() {} }
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="agnes-csp-nonce"]')?.content
  const links = target.styleUrls.map((href) => {
    const link = document.createElement(nonce ? 'style' : 'link')
    if (nonce) {
      // Use the page's existing style authorization for the import wrapper. Only the actual
      // stylesheet crosses the daemon's asset gate; relative imports still resolve against it.
      link.setAttribute('nonce', nonce)
      link.textContent = `@import url(${JSON.stringify(href)}) layer(app);\n`
    } else {
      const external = link as HTMLLinkElement
      external.rel = 'stylesheet'
      external.href = `${href}${href.includes('?') ? '&' : '?'}agnes_css_layer=app`
    }
    link.media = 'not all'
    link.dataset.plugin = target.packageId
    return link
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const loaded = Promise.all(
      links.map(
        (link) =>
          new Promise<void>((resolve, reject) => {
            link.addEventListener('load', () => resolve(), { once: true })
            link.addEventListener(
              'error',
              () => reject(new Error(`stylesheet failed: ${target.packageId}`)),
              {
                once: true,
              },
            )
            document.head.append(link)
          }),
      ),
    )
    await Promise.race([
      loaded,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`styles ${target.packageId} timeout after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    for (const link of links) link.remove()
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  let disposed = false
  return {
    activate() {
      if (!disposed) for (const link of links) link.media = 'all'
    },
    dispose() {
      disposed = true
      for (const link of links) link.remove()
    },
  }
}
