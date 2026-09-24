import type { JournalStore } from './journal.js'
import { decodeJournal, freshJournal, type JournalState, storedJournal } from './journal-state.js'

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Best-effort persistence. A failed storage stays disabled for this instance so stale data
 * cannot overwrite commands accepted in memory. localStorage is not a cross-tab transaction. */
export function localStorageJournal(
  storage?: StorageLike,
  key = 'agnes-sdk-journal',
  initialClientId?: string,
): JournalStore {
  let available: StorageLike | undefined
  try {
    available = storage ?? globalThis.localStorage
  } catch {
    // Browsers may deny the property getter itself, e.g. an opaque/sandboxed origin.
  }
  let state: JournalState | undefined
  return storedJournal((change, write) => {
    let needsSave = write
    if (available) {
      let raw: string | null = null
      try {
        raw = available.getItem(key)
      } catch {
        available = undefined
      }
      if (available && raw !== null) {
        try {
          const decoded = decodeJournal(raw)
          state = decoded
        } catch {
          if (initialClientId !== undefined) throw new Error('invalid journal state')
          // Corrupt data must not supply counters or command payloads.
          state = freshJournal(initialClientId)
          needsSave = true
        }
      } else if (available) needsSave = true
    }
    if (!state) {
      state = freshJournal(initialClientId)
      needsSave = true
    }
    if (initialClientId !== undefined && state.clientId !== initialClientId)
      throw new Error('journal identity mismatch')
    const next = structuredClone(state)
    const result = change(next)
    if (available && needsSave) {
      try {
        available.setItem(key, JSON.stringify(next))
      } catch {
        available = undefined
      }
    }
    state = next
    return result
  })
}
