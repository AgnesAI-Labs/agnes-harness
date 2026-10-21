import type { ArtifactRef } from '@agnes/protocol'

/** Scope is supplied by Core/Host, never inferred from a digest or a client filename. */
export type AttachmentScope = Readonly<{ sessionKey: string; lane: string }>
export type AttachmentReceipt = Readonly<{ id: string; artifact: ArtifactRef }>
export type AttachmentRootSnapshot = Readonly<{
  /** Incomplete snapshots prohibit every deletion, including apparently orphaned receipts. */
  complete: boolean
  roots: readonly ArtifactRef[]
}>

export type AttachmentImagePolicy = Readonly<{
  maxWidth: number
  maxHeight: number
  maxBytes: number
  jpegQuality: number
}>
export type AttachmentImageVersion = AttachmentReceipt & { width: number; height: number }

/** Optional artifacts capability. Bytes and durable receipts belong to the storage provider. */
export interface AttachmentStore {
  /** Caller must first authorize and verify the original. Cache entries never grant read authority.
   * A returned receipt protects derived bytes until publication (thumbnail) or expiry (request input).
   * Implementations must bound native decode memory, concurrency and total duration.
   */
  imageVersion?(
    scope: AttachmentScope,
    original: ArtifactRef,
    policy: AttachmentImagePolicy,
    signal: AbortSignal,
  ): Promise<AttachmentImageVersion>

  /** Optional bounded-memory intake. Consume with backpressure, verify the exact artifact before
   * publication, and clean partial bytes on abort/failure. Chunks are at most FILE_UPLOAD_CHUNK_BYTES;
   * sources may reuse a chunk after yield.
   * The scoped pending receipt and GC protection have the same semantics as `store`.
   */
  storeStream?(
    scope: AttachmentScope,
    source: AsyncIterable<Uint8Array>,
    artifact: ArtifactRef,
    signal: AbortSignal,
  ): Promise<AttachmentReceipt>

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
