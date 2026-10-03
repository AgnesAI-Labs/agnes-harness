import type { DeletionReceipt } from '@agnes/protocol/runtime'

/** Ack follows durable index removal. A crash in between safely redelivers the same receipt. */
export async function propagateMemoryDeletions(
  source: { pendingDeletions(): readonly DeletionReceipt[]; acknowledgeDeletion(id: string): void },
  targets: readonly { removeDeleted(receipt: DeletionReceipt): Promise<void> }[],
  signal: AbortSignal,
): Promise<number> {
  let completed = 0
  for (const receipt of source.pendingDeletions()) {
    signal.throwIfAborted()
    for (const target of targets) {
      signal.throwIfAborted()
      await target.removeDeleted(structuredClone(receipt))
    }
    signal.throwIfAborted()
    source.acknowledgeDeletion(receipt.deletionId)
    completed++
  }
  return completed
}
