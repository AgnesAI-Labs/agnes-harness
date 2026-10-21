import { setImmediate } from 'node:timers/promises'
import type { InstalledInventory } from './inventory.js'
import { readBoundary } from './inventory-boundary.js'
import { withoutPackageVerification, withPackageVerification } from './verification-operation.js'

/** Share unfinished reads only; fresh publication retains its independent full gate. */
export function readInventoryOperation(input: {
  profileDir: string
  key: string
  fresh: boolean
  pending: Map<string, { boundary: string; promise: Promise<InstalledInventory> }>
  read(): Promise<InstalledInventory>
  lock(read: () => Promise<InstalledInventory>): Promise<InstalledInventory>
}): Promise<InstalledInventory> {
  return (input.fresh ? withoutPackageVerification : withPackageVerification)(async () => {
    const boundary = readBoundary(input.profileDir)
    if (input.fresh) input.pending.delete(input.key)
    const existing = input.pending.get(input.key)
    if (existing?.boundary === boundary) return existing.promise
    let reading: Promise<InstalledInventory>
    const clear = () => {
      if (input.pending.get(input.key)?.promise === reading) input.pending.delete(input.key)
    }
    reading = input
      .lock(async () => {
        await setImmediate()
        try {
          return await input.read()
        } finally {
          clear()
        }
      })
      .finally(clear)
    if (!input.fresh) input.pending.set(input.key, { boundary, promise: reading })
    return reading
  })
}
