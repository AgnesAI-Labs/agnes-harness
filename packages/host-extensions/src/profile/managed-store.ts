import type { OwnedStore } from '@agnes/extension-api'

/** Shutdown may flush its owner state; a retained port is revoked as soon as shutdown settles. */
export function managedStore(store: OwnedStore, alive: () => void): OwnedStore {
  return Object.freeze({
    get(key) {
      alive()
      return store.get(key)
    },
    set(key, value) {
      alive()
      store.set(key, value)
    },
    delete(key) {
      alive()
      store.delete(key)
    },
    scan(input) {
      alive()
      return store.scan(input)
    },
    transaction<T>(work: () => T): T {
      alive()
      return store.transaction(() => {
        const result = work()
        alive()
        return result
      })
    },
  } satisfies OwnedStore)
}
