import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

export type SnapshotSource<T> = {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}
export type StoreOptions = {
  notify?: 'sync' | 'animation-frame'
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
}

/** Controllers own snapshots. Frame batching delays notifications, never snapshot writes. */
export function createExternalStore<T>(initial: T, options: StoreOptions = {}) {
  let snapshot = initial
  let pending = false
  let frame: number | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const schedule =
    options.requestFrame ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined)
  const cancel =
    options.cancelFrame ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined)
  const flush = () => {
    if (!pending) return
    generation++
    if (frame !== undefined) cancel?.(frame)
    frame = undefined
    pending = false
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: T) {
      if (Object.is(snapshot, next)) return
      snapshot = next
      const alreadyPending = pending
      pending = true
      if (options.notify !== 'animation-frame' || !schedule) flush()
      else if (!alreadyPending) {
        const ticket = ++generation
        frame = schedule(() => {
          if (ticket !== generation) return
          frame = undefined
          flush()
        })
      }
    },
    /** Controlled operations and tests can synchronously publish a pending frame. */
    flush,
  }
}

/** One selector bridge: unchanged selections retain their reference and do not rerender consumers. */
export function useStoreSelector<T, S>(
  source: SnapshotSource<T>,
  selector: (snapshot: T) => S,
  equal: (a: S, b: S) => boolean = Object.is,
): S {
  const committed = useRef<{ value: S }>()
  const selectSnapshot = useMemo(() => {
    let previous: { snapshot: T; value: S } | undefined
    return () => {
      const snapshot = source.getSnapshot()
      if (previous && Object.is(previous.snapshot, snapshot)) return previous.value
      const value = selector(snapshot)
      const known = previous ?? committed.current
      const selected = known && equal(known.value, value) ? known.value : value
      previous = { snapshot, value: selected }
      return selected
    }
  }, [source, selector, equal])
  const value = useSyncExternalStore(source.subscribe, selectSnapshot, selectSnapshot)
  useEffect(() => {
    committed.current = { value }
  }, [value])
  return value
}
