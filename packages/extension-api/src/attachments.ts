import type { ArtifactRef } from '@agnes/protocol'

/** Scope is supplied by Core/Host, never inferred from a digest or a client filename. */
export type AttachmentScope = Readonly<{ sessionKey: string; lane: string }>
export type AttachmentReceipt = Readonly<{ id: string; artifact: ArtifactRef }>
export type AttachmentRootSnapshot = Readonly<{
  /** Incomplete snapshots prohibit every deletion, including apparently orphaned receipts. */
  complete: boolean
  roots: readonly ArtifactRef[]
}>

/** Optional artifacts capability. Bytes and durable receipts belong to the storage provider. */
export interface AttachmentStore {
  store(
    scope: AttachmentScope,
    bytes: Uint8Array,
    mime: string,
    signal: AbortSignal,
  ): Promise<AttachmentReceipt>
  /** A pending receipt is exact scope+digest+size+MIME authority, not a bearer URL. */
  authorize(scope: AttachmentScope, receipt: AttachmentReceipt, signal: AbortSignal): Promise<boolean>
  /** Confirm only after the referencing inbox/message has committed. Idempotent. */
  confirm(scope: AttachmentScope, receiptId: string): Promise<void>
  /** Discards only this pending receipt; duplicate uploads retain their independent roots. */
  discard(scope: AttachmentScope, receiptId: string): Promise<void>
  pendingRoots(): Promise<AttachmentRootSnapshot>
}
