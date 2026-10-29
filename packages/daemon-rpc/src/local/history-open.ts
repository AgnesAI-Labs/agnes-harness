type Progress = { verifiedSeq: number; lastSeq: number }
type Preparation = {
  listeners: Set<(progress: Progress) => void>
  pending: Set<Promise<unknown>>
  controller: AbortController
}
const preparations = new WeakMap<object, Map<string, Preparation>>()

async function wait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([pending, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Registry.open shares cold preparation across callers. Cancel only this caller's wait: the
 * registry owns the bounded preparation, which may also belong to another connection. In
 * particular, never lend it the first page's AbortSignal and thereby cancel every later waiter.
 * Every caller still calls registry.open, so its binding checks remain in force.
 */
export async function waitForHistoryOpen<T>(
  registry: object,
  key: string,
  signal: AbortSignal,
  progress: (value: Progress) => void,
  open: (onProgress: (value: Progress) => void, historySignal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  let group = preparations.get(registry)
  if (!group) {
    group = new Map()
    preparations.set(registry, group)
  }
  let preparation = group.get(key)
  if (preparation?.controller.signal.aborted) {
    // A→B→A can return before the old registry promise unwinds. Do not inherit its cancellation.
    await wait(Promise.allSettled([...preparation.pending]), signal)
    return waitForHistoryOpen(registry, key, signal, progress, open)
  }
  if (!preparation) {
    preparation = { listeners: new Set(), pending: new Set(), controller: new AbortController() }
    group.set(key, preparation)
  }
  preparation.listeners.add(progress)
  const current = preparation
  const pending = Promise.resolve()
    .then(() =>
      open((value) => {
        for (const listener of current.listeners) listener(value)
      }, current.controller.signal),
    )
    .finally(() => {
      current.pending.delete(pending)
      if (!current.pending.size && group.get(key) === current) group.delete(key)
    })
  current.pending.add(pending)
  try {
    return await wait(pending, signal)
  } finally {
    current.listeners.delete(progress)
    if (!current.listeners.size && current.pending.size)
      current.controller.abort(new Error('session loading cancelled'))
  }
}
