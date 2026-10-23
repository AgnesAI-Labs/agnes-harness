import type { StorageAdapter } from '@agnes/core'
import { type DecisionsChanged, ProfileJournal } from './journal.js'

type Shared = {
  stores: Map<StorageAdapter, number>
  listeners: Set<(detail: DecisionsChanged) => void>
  pending?: Promise<ProfileJournal>
  closing?: Promise<void>
  before?: Promise<void>
}
const journals = new Map<string, Shared>()

/** Code generations share one decision-journal writer; storage calls use a still-retained Host adapter. */
export function retainProfileJournal(
  key: string,
  profileId: string,
  storage: StorageAdapter,
  clock: () => number,
  changed?: (detail: DecisionsChanged) => void,
) {
  let entry = journals.get(key)
  if (!entry || entry.closing) {
    entry = { stores: new Map(), listeners: new Set(), ...(entry?.closing ? { before: entry.closing } : {}) }
    journals.set(key, entry)
  }
  const shared = entry
  const listener = changed ? (detail: DecisionsChanged) => changed(detail) : undefined
  if (listener) shared.listeners.add(listener)
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
        ProfileJournal.open(profileId, proxy, clock, (detail) => {
          // Generations share the writer and transport; publish once via a retained observer.
          const listener = [...shared.listeners].at(-1)
          listener?.(detail)
        }),
      )
      return shared.pending
    },
    async close() {
      if (released) return
      released = true
      if (listener) shared.listeners.delete(listener)
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
