// Adapted from dsh-superagent (MIT)
/** Async coordination helpers for tests. */
import { vi } from 'vitest'

/** Create an externally resolvable promise. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
/** Observe whether a promise has settled without awaiting it. */
export function track<T>(promise: Promise<T>) {
  const state = { settled: false, error: undefined as unknown, promise }
  promise.then(
    () => {
      state.settled = true
    },
    (error: unknown) => {
      state.settled = true
      state.error = error
    },
  )
  return state
}
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const waitUntil = (check: () => boolean, timeout = 3000) =>
  vi.waitFor(
    () => {
      if (!check()) throw new Error('not yet')
    },
    { timeout, interval: 2 },
  )
