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
  const links = target.styleUrls.map((href) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
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
            link.addEventListener('error', () => reject(new Error(`stylesheet failed: ${link.href}`)), {
              once: true,
            })
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
