import { decodeAttachmentData } from '@agnes/protocol-validation'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'
import type { AttachmentEntry, AttachmentKind } from './attachment-index.js'

/**
 * What a session reads user attachments through. `read` is the attachment store: a whole read checks
 * the digest, a range read does not. The two optional calls keep a copy of an old inline attachment
 * in that store, keyed by its place in the session, so it is decoded from its row only once.
 */
export type AttachmentReadPort = Readonly<{
  read(sha256: string, range?: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
  cacheInline?(input: {
    sessionKey: string
    seq: number
    kind: string
    index: number
    bytes: Uint8Array
    mimeType: string
  }): Promise<{ sha256: string; bytes: number }>
  cachedInline?(
    sessionKey: string,
    seq: number,
    kind: string,
    index: number,
  ): Promise<{ sha256: string; bytes: number } | undefined>
}>

/** The largest attachment a tool reads whole; anything larger is exported, not loaded. */
export const SESSION_ATTACHMENT_READ_MAX_BYTES = 256 * 1024 * 1024

export type AttachmentFailure =
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_MISSING'
  | 'ATTACHMENT_CORRUPT'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_UNREADABLE'
  | 'ATTACHMENT_RANGE'

export const attachmentFailure = (
  code: AttachmentFailure,
  message: string,
  extra: Record<string, unknown> = {},
) => new CoreError('E_ENVELOPE', message, { code, ...extra })

/** The failure code a thrown attachment error carries, if it is one. */
export function attachmentFailureCode(error: unknown): AttachmentFailure | undefined {
  if (!(error instanceof CoreError) || error.code !== 'E_ENVELOPE') return undefined
  const code = error.detail?.code
  return typeof code === 'string' && code.startsWith('ATTACHMENT_') ? (code as AttachmentFailure) : undefined
}

type Reader = Pick<SessionImpl, 'key' | 'd'>

const storeCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

/** A store failure as the reader reports it; a cancelled read stays a cancellation. */
function fromStore(error: unknown, signal: AbortSignal | undefined): Error {
  if (signal?.aborted)
    return signal.reason instanceof Error ? signal.reason : new Error('Attachment read cancelled.')
  const code = storeCode(error)
  if (code === 'ATTACHMENT_CORRUPT' || code === 'ATTACHMENT_HASH_MISMATCH')
    return attachmentFailure(
      'ATTACHMENT_CORRUPT',
      'The stored attachment is corrupt (its bytes no longer match their digest).',
    )
  // The store reports a range past the end of the object this way: the object is shorter than the
  // reference says, so it is not the object the reference names.
  if (code === 'ATTACHMENT_INVALID_ID')
    return attachmentFailure(
      'ATTACHMENT_CORRUPT',
      'The stored attachment does not have the size its message records.',
    )
  if (code === 'ATTACHMENT_MISSING')
    return attachmentFailure(
      'ATTACHMENT_MISSING',
      'The stored attachment is missing from the attachment store.',
    )
  if (code === 'ATTACHMENT_TOO_LARGE')
    return attachmentFailure('ATTACHMENT_TOO_LARGE', 'The stored attachment is too large to read whole.')
  return attachmentFailure('ATTACHMENT_UNREADABLE', 'The stored attachment could not be read.')
}

function port(s: Reader): AttachmentReadPort | undefined {
  return s.d.attachments
}

/** A whole, digest-checked read of a stored object that must be `bytes` long. */
async function storedWhole(
  p: AttachmentReadPort,
  sha256: string,
  bytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let out: Uint8Array
  try {
    out = await p.read(sha256, undefined, signal)
  } catch (error) {
    throw fromStore(error, signal)
  }
  if (out.byteLength !== bytes)
    throw attachmentFailure(
      'ATTACHMENT_CORRUPT',
      'The stored attachment does not have the size its message records.',
    )
  return out
}

/** The block's bytes decoded from its own ledger row, which is read in full (not the lean view). */
async function fromRow(s: Reader, entry: AttachmentEntry, signal?: AbortSignal): Promise<Uint8Array> {
  const [row] = await s.d.log.scan({
    fromSeq: entry.seq,
    toSeq: entry.seq,
    type: 'user/message',
    lane: entry.lane,
    limit: 1,
  })
  signal?.throwIfAborted()
  const content = (row?.data as { content?: unknown } | undefined)?.content
  const block = (Array.isArray(content) ? content : []).filter(
    (b): b is Record<string, unknown> =>
      !!b && typeof b === 'object' && (b as { type?: unknown }).type === entry.kind,
  )[entry.index - 1]
  if (!block || typeof block.data !== 'string')
    throw attachmentFailure('ATTACHMENT_MISSING', 'The attachment data is not in its message.')
  try {
    return decodeAttachmentData(block.data, SESSION_ATTACHMENT_READ_MAX_BYTES)
  } catch {
    throw attachmentFailure('ATTACHMENT_CORRUPT', 'The attachment data in its message cannot be decoded.')
  }
}

/** The store copy an old inline block was given, if one was kept with the size the block records. */
async function cachedCopy(
  s: Reader,
  entry: AttachmentEntry,
): Promise<{ sha256: string; bytes: number } | undefined> {
  const p = port(s)
  const cached = await p?.cachedInline?.(s.key, entry.seq, entry.kind, entry.index).catch(() => undefined)
  return cached && cached.bytes === entry.bytes ? cached : undefined
}

/**
 * The bytes of one user attachment, whatever form its row holds. A reference is read from the
 * attachment store with its digest checked; an inline or lean block is decoded from its row once and
 * then kept in the store, so later reads do not rescan the ledger. The ledger itself is never written.
 * Missing or damaged bytes fail with a coded `E_ENVELOPE`, never with a crash or with other bytes.
 */
export async function attachmentBytes(
  s: Reader,
  entry: AttachmentEntry,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (entry.bytes > SESSION_ATTACHMENT_READ_MAX_BYTES)
    throw attachmentFailure('ATTACHMENT_TOO_LARGE', 'The attachment is larger than 256 MiB.', {
      bytes: entry.bytes,
    })
  const p = port(s)
  if (entry.form === 'reference') {
    if (!p || entry.sha256 === undefined)
      throw attachmentFailure('ATTACHMENT_MISSING', 'The attachment store is unavailable in this runtime.')
    return storedWhole(p, entry.sha256, entry.bytes, signal)
  }
  const cached = await cachedCopy(s, entry)
  if (cached && p) {
    // A copy that is gone or damaged is only a cache: the row still holds the bytes.
    const copy = await storedWhole(p, cached.sha256, cached.bytes, signal).catch(() => undefined)
    if (copy) return copy
    signal?.throwIfAborted()
  }
  const bytes = await fromRow(s, entry, signal)
  await p
    ?.cacheInline?.({
      sessionKey: s.key,
      seq: entry.seq,
      kind: entry.kind,
      index: entry.index,
      bytes,
      mimeType: entry.mimeType,
    })
    .catch(() => undefined)
  return bytes
}

/** The most bytes one range read hands back. */
export const ATTACHMENT_RANGE_MAX_BYTES = 1024 * 1024

/** Thumbnails are JPEG unless their bytes say PNG; the reference block does not name their type. */
const thumbnailMime = (bytes: Uint8Array) =>
  bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ? 'image/png'
    : 'image/jpeg'

/**
 * One window of an attachment, or of its thumbnail, for a client that downloads it in pieces. An
 * object that fits one window is read whole, so its digest is checked; a larger stored object is read
 * by range, which the store does not check (the client holds the digest from the reference block).
 * An old inline block is copied into the store on its first window and later windows come from there.
 */
export async function attachmentRange(
  s: Reader,
  locate: { seq: number; kind: AttachmentKind; index: number },
  window: { offset: number; length: number; thumbnail?: boolean },
  entry: AttachmentEntry | undefined,
  signal?: AbortSignal,
): Promise<{ mimeType: string; totalBytes: number; bytes: Uint8Array }> {
  if (!entry)
    throw attachmentFailure('ATTACHMENT_NOT_FOUND', 'No such attachment in this session.', { ...locate })
  const p = port(s)
  const length = Math.min(window.length, ATTACHMENT_RANGE_MAX_BYTES)
  const slice = (bytes: Uint8Array, total: number) => {
    if (window.offset > total)
      throw attachmentFailure('ATTACHMENT_RANGE', 'The offset is past the end of the attachment.')
    return bytes.subarray(window.offset, Math.min(total, window.offset + length))
  }
  if (window.thumbnail) {
    if (!entry.thumbnail || !p)
      throw attachmentFailure('ATTACHMENT_NOT_FOUND', 'This attachment has no thumbnail.')
    const bytes = await storedWhole(p, entry.thumbnail.sha256, entry.thumbnail.bytes, signal)
    return {
      mimeType: thumbnailMime(bytes),
      totalBytes: bytes.byteLength,
      bytes: slice(bytes, bytes.byteLength),
    }
  }
  const total = entry.bytes
  if (window.offset > total)
    throw attachmentFailure('ATTACHMENT_RANGE', 'The offset is past the end of the attachment.')
  const stored =
    entry.form === 'reference'
      ? entry.sha256 === undefined
        ? undefined
        : { sha256: entry.sha256, bytes: total }
      : await cachedCopy(s, entry)
  if (entry.form === 'reference' && (!p || !stored))
    throw attachmentFailure('ATTACHMENT_MISSING', 'The attachment store is unavailable in this runtime.')
  if (p && stored && !(window.offset === 0 && total <= length)) {
    try {
      const bytes = await p.read(
        stored.sha256,
        { offset: window.offset, length: Math.min(length, total - window.offset) },
        signal,
      )
      return { mimeType: entry.mimeType, totalBytes: total, bytes }
    } catch (error) {
      // A cached copy that went away is read from the row again below; a reference has no other source.
      if (entry.form === 'reference') throw fromStore(error, signal)
    }
  }
  const bytes = await attachmentBytes(s, entry, signal)
  return { mimeType: entry.mimeType, totalBytes: total, bytes: slice(bytes, total) }
}
