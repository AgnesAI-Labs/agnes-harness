import type { HomeEntry } from './ui-registries.js'
import { homeEntries } from './ui-registries.js'

const pending = new Map<string, { owner: string; dispose(): void }>()

/** Package identity is attached by the host facade, never by an ordinary entry's payload. */
export function registerOwnedHomeEntry(packageId: string, entry: HomeEntry): () => void {
  return homeEntries.registerOwned(packageId, entry)
}

export function resolveHomeEntry(ref: string): HomeEntry | undefined {
  return homeEntries.resolve(ref)
}

/** Host-owned navigation while a declared profile module waits for its first page open. */
export function reserveHomeEntry(owner: string, entry: HomeEntry, packageId?: string): () => void {
  const off = packageId ? registerOwnedHomeEntry(packageId, entry) : homeEntries.register(entry)
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
