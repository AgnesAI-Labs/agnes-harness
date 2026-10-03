import type * as Wire from '@agnes/protocol/runtime'

/** Synchronous atomic domain transactions; callbacks must not perform asynchronous work.
 * A thrown callback must roll back every write. Revision reads and writes share that transaction.
 * Each handle belongs exclusively to one workspace/tenant domain and provider lifecycle.
 */
export interface MemoryStorage {
  assertOwner(scopeDigest: string): void
  transaction<T>(work: () => T): T
  revision(): number
  setRevision(revision: number): void
  items(): readonly Wire.MemoryItem[]
  putItem(item: Wire.MemoryItem): void
  delivery(id: string): { fingerprint: string; output: unknown } | null
  putDelivery(id: string, fingerprint: string, output: unknown): void
  putDeletion(receipt: Wire.DeletionReceipt): void
  pendingDeletions(): readonly Wire.DeletionReceipt[]
  acknowledgeDeletion(id: string): void
  close(): void
}
