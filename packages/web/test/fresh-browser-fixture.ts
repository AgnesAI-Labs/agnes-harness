import { GlobalWindow } from 'happy-dom'
import { populateGlobal } from 'vitest/runtime'

/** A terminal navigation retires its Document, rather than only removing its DOM nodes. */
export function createBrowserFixture(): { close(): Promise<void> } {
  const aliases = new Map(
    ['window', 'self', 'top', 'parent'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  )
  const window = new GlobalWindow({
    url: 'http://localhost:3000',
    console,
    settings: { disableErrorCapturing: true },
  })
  const { keys, originals } = populateGlobal(globalThis, window, {
    bindFunctions: true,
    additionalKeys: [
      'Request',
      'Response',
      'MessagePort',
      'fetch',
      'Headers',
      'AbortController',
      'AbortSignal',
      'URL',
      'URLSearchParams',
      'FormData',
      'happyDOM',
    ],
  })
  let closing: Promise<void> | undefined
  return {
    close: () =>
      (closing ??= (async () => {
        try {
          // Window.close() intentionally ignores top-level windows not opened by a script.
          await window.happyDOM.close()
          if (!window.closed) throw new Error('The fixture browser did not close')
        } finally {
          for (const key of keys) Reflect.deleteProperty(globalThis, key)
          for (const [key, descriptor] of originals) Object.defineProperty(globalThis, key, descriptor)
          for (const [key, descriptor] of aliases) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor)
            else Reflect.deleteProperty(globalThis, key)
          }
        }
      })()),
  }
}
