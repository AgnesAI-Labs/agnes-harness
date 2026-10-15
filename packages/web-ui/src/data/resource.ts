import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * One way to read: every page read goes through `useResource`. A read is cached for this page
 * session under its key; opening it again shows the cached value at once and refreshes it behind
 * (stale-while-revalidate); a write invalidates the keys it touched. Page-level reads also drive the
 * one progress bar at the top of the window.
 */

export type ResourceState<T> = {
  /** The last value read, kept while a refresh runs and when a refresh fails. */
  data: T | undefined
  /** The last failure; cleared by the next success. */
  error: unknown
  /** A read is running (the first one or a refresh). */
  loading: boolean
}

type ResourceWrite = {
  owner: object | undefined
  write(): Promise<unknown>
  result: Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
}

type Entry = {
  version: number
  writes: Promise<unknown> | undefined
  pendingWrites: ResourceWrite[]
  state: ResourceState<unknown>
  /** The read running for this key, shared by everyone asking for it. */
  inflight: Promise<unknown> | undefined
  /** Set by invalidation: the next subscriber (or the current ones) read again. */
  stale: boolean
  listeners: Set<() => void>
  fetch: (() => Promise<unknown>) | undefined
  page: boolean
}

const entries = new Map<string, Entry>()
const empty: ResourceState<never> = { data: undefined, error: undefined, loading: false }

function entry(key: string): Entry {
  let found = entries.get(key)
  if (!found) {
    found = {
      version: 0,
      writes: undefined,
      pendingWrites: [],
      state: empty,
      inflight: undefined,
      stale: true,
      listeners: new Set(),
      fetch: undefined,
      page: false,
    }
    entries.set(key, found)
  }
  return found
}

function publish(target: Entry, state: ResourceState<unknown>) {
  target.state = state
  for (const listener of [...target.listeners]) listener()
}

/* The progress bar: the count of page-level reads in flight. */
let pageReads = 0
const progressListeners = new Set<() => void>()
function changePageReads(delta: number) {
  pageReads = Math.max(0, pageReads + delta)
  for (const listener of [...progressListeners]) listener()
}

/** Count a page-level request the resource cache does not own (a save, a session switch). */
export function trackPageRequest<T>(work: Promise<T>): Promise<T> {
  changePageReads(1)
  return work.finally(() => changePageReads(-1))
}

/** Whether any page-level request is in flight; drives the top progress bar. */
export function usePageRequestsInFlight(): boolean {
  return useSyncExternalStore(
    (listener) => {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
    () => pageReads > 0,
    () => false,
  )
}

/** Read `key` now (sharing a read already running) and publish the result to every subscriber. */
function revalidate(key: string): Promise<unknown> | undefined {
  const target = entry(key)
  if (target.inflight) return target.inflight
  const fetch = target.fetch
  if (!fetch) return undefined
  target.stale = false
  publish(target, { ...target.state, loading: true })
  const version = target.version
  const run = fetch()
  const tracked = target.page ? trackPageRequest(run) : run
  const settled = tracked.then(
    (data) => {
      if (target.inflight !== settled) return data
      target.inflight = undefined
      if (version === target.version) publish(target, { data, error: undefined, loading: false })
      else publish(target, { ...target.state, loading: false })
      return data
    },
    (error: unknown) => {
      if (target.inflight !== settled) return undefined
      target.inflight = undefined
      // A failed refresh keeps what was already shown.
      publish(target, {
        ...target.state,
        error: version === target.version ? error : target.state.error,
        loading: false,
      })
      return undefined
    },
  )
  target.inflight = settled
  return settled
}

/**
 * Mark cached reads out of date after a write: a key equal to `prefix` or starting with `prefix:`.
 * Mounted readers read again at once; others read again when next shown.
 */
export function invalidateResource(prefix: string): void {
  for (const [key, target] of entries) {
    if (key !== prefix && !key.startsWith(`${prefix}:`)) continue
    target.version++
    target.inflight = undefined
    target.stale = true
    if (target.listeners.size) void revalidate(key)
  }
}

/** Replace a cached value (a write that returned the new value); readers show it at once. */
export function setResource<T>(key: string, data: T): void {
  const target = entry(key)
  target.version++
  target.stale = false
  publish(target, { data, error: undefined, loading: target.state.loading })
}

/** Forget every cached read and in-flight count (tests, signing out). */
export function clearResources(): void {
  entries.clear()
  changePageReads(-pageReads)
}

/**
 * Read through the cache. `key` names the read (`agents:list`); without a key nothing is read.
 * `page` marks a read the page waits on: it drives the top progress bar.
 */
export function useResource<T>(
  key: string | undefined,
  fetch: () => Promise<T>,
  options: {
    page?: boolean
    /** Polling owners can handle focus/visibility themselves to avoid duplicate reads. */
    revalidateOnFocus?: boolean
  } = {},
): ResourceState<T> & { reload(): void } {
  const fetchRef = useRef(fetch)
  fetchRef.current = fetch
  const page = options.page ?? true
  const revalidateOnFocus = options.revalidateOnFocus ?? true
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {}
      const target = entry(key)
      target.listeners.add(listener)
      return () => target.listeners.delete(listener)
    },
    [key],
  )
  const state = useSyncExternalStore(
    subscribe,
    () => (key ? entry(key).state : empty) as ResourceState<T>,
    () => empty as ResourceState<T>,
  )
  useEffect(() => {
    if (!key) return
    const target = entry(key)
    target.fetch = () => fetchRef.current()
    target.page = page
    // Shown from cache at once; read again behind it (on every mount, and when invalidated).
    void revalidate(key)
    if (!revalidateOnFocus) return
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void revalidate(key)
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [key, page, revalidateOnFocus])
  const reload = useCallback(() => {
    if (!key) return
    const target = entry(key)
    target.inflight = undefined
    void revalidate(key)
  }, [key])
  return { ...state, reload }
}

/**
 * Serialize writes to a resource, including across unmount/remount. An optional owner coalesces
 * that editor's unsent replacements at the latest intent's position; ordinary operations stay FIFO.
 * Use an owner only for full-value replacements of one value type. Coalesced promises settle
 * with the latest replacement's outcome.
 */
export function queueResourceWrite<T>(key: string, write: () => Promise<T>, owner?: object): Promise<T> {
  const target = entry(key)
  const pending = owner && target.pendingWrites.find((queued) => queued.owner === owner)
  if (pending) {
    pending.write = write
    target.pendingWrites.splice(target.pendingWrites.indexOf(pending), 1)
    target.pendingWrites.push(pending)
    // One editor keeps the same value type for its replacements.
    return pending.result as Promise<T>
  }
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const result = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  void result.catch(() => {})
  target.pendingWrites.push({ owner, write, result, resolve, reject })
  if (!target.writes) startResourceWrite(target)
  return result as Promise<T>
}

function startResourceWrite(target: Entry): void {
  const next = target.pendingWrites.shift()
  target.writes = next?.result
  if (!next) return
  void Promise.resolve()
    .then(() => next.write())
    .then(next.resolve, next.reject)
    .then(() => startResourceWrite(target))
}

const scopes = new WeakMap<object, number>()
let scopeSequence = 0
/** An API/connection identity owns its remote snapshots and write ordering. */
export function scopedResourceKey(scope: object, name: string): string {
  let id = scopes.get(scope)
  if (id === undefined) {
    id = ++scopeSequence
    scopes.set(scope, id)
  }
  return `${name}:scope-${id}`
}

export function resourceWritePending(key: string): boolean {
  return !!entry(key).writes
}
