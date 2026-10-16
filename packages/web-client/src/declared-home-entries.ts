import type { HomeEntry } from './ui-registries.js'
import { homeEntries } from './ui-registries.js'

const pending = new Map<string, { owner: string; dispose(): void }>()

/** Host-owned navigation while a declared profile module waits for its first page open. */
export function reserveHomeEntry(owner: string, entry: HomeEntry): () => void {
  const off = homeEntries.register(entry)
  const reservation = {
    owner,
    dispose() {
      if (pending.get(entry.id) !== reservation) return
      pending.delete(entry.id)
      off()
    },
  }
  pending.set(entry.id, reservation)
  return reservation.dispose
}

/** Only the declaring contribution may replace its host placeholder with a live registration. */
export function claimHomeEntry(owner: string, id: string): void {
  const reservation = pending.get(id)
  if (reservation?.owner === owner) reservation.dispose()
}
