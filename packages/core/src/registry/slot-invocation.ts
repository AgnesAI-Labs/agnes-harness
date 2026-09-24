import { withTimeout } from '../effects/wrap.js'
import type { Timers } from '../log/session-log.js'

const nativeTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
}

/** End write authority at the deadline itself, before promise rejection microtasks run. */
export async function invokeSlot<T>(
  invoke: (signal: AbortSignal) => T | Promise<T>,
  ms: number,
  parent?: AbortSignal,
  timers: Timers = nativeTimers,
): Promise<T> {
  const scope = new AbortController()
  const signal = parent ? AbortSignal.any([parent, scope.signal]) : scope.signal
  try {
    return await withTimeout(
      Promise.resolve().then(() => {
        if (signal.aborted) throw new Error('slot invocation cancelled')
        return invoke(signal)
      }),
      ms,
      'UI slot',
      signal,
      {
        setTimeout: (fn, delay) =>
          timers.setTimeout(() => {
            scope.abort()
            fn()
          }, delay),
        clearTimeout: (handle) => timers.clearTimeout(handle),
      },
    )
  } finally {
    scope.abort()
  }
}
