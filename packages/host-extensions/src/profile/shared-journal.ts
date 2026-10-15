import type { StorageAdapter } from '@agnes/core'
import { ProfileJournal } from './journal.js'

type Shared = {
  stores: Map<StorageAdapter, number>
  pending?: Promise<ProfileJournal>
  closing?: Promise<void>
  before?: Promise<void>
}
const journals = new Map<string, Shared>()

/** Code generations share one AR1 writer; storage calls use a still-retained Host adapter. */
export function retainProfileJournal(
  key: string,
  profileId: string,
  storage: StorageAdapter,
  clock: () => number,
) {
  let entry = journals.get(key)
  if (!entry || entry.closing) {
    entry = { stores: new Map(), ...(entry?.closing ? { before: entry.closing } : {}) }
    journals.set(key, entry)
  }
  const shared = entry
  shared.stores.set(storage, (shared.stores.get(storage) ?? 0) + 1)
  let released = false
  const proxy = new Proxy({} as StorageAdapter, {
    get(_target, property) {
      return (...args: unknown[]) => {
        const current = shared.stores.keys().next().value as StorageAdapter | undefined
        if (!current) throw new Error('Profile persistence is closed')
        const method: unknown = Reflect.get(current, property, current)
        if (typeof method !== 'function') throw new Error('Invalid profile persistence method')
        return Reflect.apply(method, current, args)
      }
    },
  })
  return {
    get(): Promise<ProfileJournal> {
      if (released) throw new Error('Profile journal is closed')
      shared.pending ??= (shared.before ?? Promise.resolve()).then(() =>
        ProfileJournal.open(profileId, proxy, clock),
      )
      return shared.pending
    },
    async close() {
      if (released) return
      released = true
      const count = shared.stores.get(storage) ?? 0
      if (shared.stores.size === 1 && count === 1) {
        shared.closing = (async () => {
          await (await shared.pending)?.close()
        })()
        try {
          await shared.closing
        } finally {
          shared.stores.delete(storage)
          if (journals.get(key) === shared) journals.delete(key)
        }
      } else if (count > 1) shared.stores.set(storage, count - 1)
      else shared.stores.delete(storage)
    },
  }
}
