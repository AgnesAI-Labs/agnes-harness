import { createRequire } from 'node:module'

const linux = process.platform === 'linux' // guards-allow-platform: glibc malloc_trim exists only in the Linux addon.

let running: Promise<void> | undefined

/**
 * Hand free malloc memory back to the OS: glibc keeps what V8 frees after parsing and compiling a
 * bundle (30-120 MB per AGH process). glibc `malloc_trim(0)`, run on Node's worker pool. On other
 * platforms or C libraries, or without the native addon, nothing happens. Never rejects; a call
 * while a trim is running shares it.
 */
export function trimNativeHeap(): Promise<void> {
  running ??= trim().finally(() => {
    running = undefined
  })
  return running
}

async function trim(): Promise<void> {
  if (!linux) return
  try {
    const addon = createRequire(import.meta.url)('@agnes/system-node/native') as {
      trimNativeHeap?: () => Promise<boolean>
    }
    if (typeof addon.trimNativeHeap === 'function') await addon.trimNativeHeap()
  } catch {
    // Best effort: the memory stays with malloc.
  }
}
