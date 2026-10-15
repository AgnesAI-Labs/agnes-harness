import { randomUUID } from 'node:crypto'
import type { OwnedStore as HostStore } from '@agnes/extension-api'
import { type Json, MhsError, object } from '@agnes/mhs-device'
import type { OwnedStore } from '@agnes/mhs-hub'

/** The Host binds the owner. The Hub owns revision envelopes and compare-and-set semantics. */
export function mhsOwnedStore(store: HostStore): OwnedStore {
  const read = (key: string) => {
    const value = store.get(key)
    if (value === undefined) return undefined
    const row = object(value)
    if (typeof row.revision !== 'string' || !Object.hasOwn(row, 'value')) throw new MhsError('store-corrupt')
    return { revision: row.revision, value: row.value as Json }
  }
  return {
    async transaction(work) {
      return store.transaction(() =>
        work({
          get: read,
          put(key, value, expected) {
            if ((read(key)?.revision ?? null) !== expected) throw new MhsError('CAS_CONFLICT')
            store.set(key, { revision: randomUUID(), value })
          },
          remove(key, expected) {
            if (read(key)?.revision !== expected) throw new MhsError('CAS_CONFLICT')
            store.delete(key)
          },
        }),
      )
    },
    async scan(input) {
      const page = store.scan(input)
      return {
        rows: page.rows.map(({ key }) => ({ key, ...read(key)! })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      }
    },
  }
}
