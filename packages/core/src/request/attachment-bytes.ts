import { ARTIFACT_READ_RPC_MAX_BYTES } from '@agnes/protocol'
import { decodeAttachmentData, USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol-validation'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'
import type { AttachmentEntry, AttachmentKind } from './attachment-index.js'

/**
 * What a session reads user attachments through. `read` is the attachment store: a whole read checks
 * the digest, a range read does not. `isUserAttachment` says whether the store holds the object as a
 * user attachment (or thumbnail); nothing else is ever served here, whatever digest a row names. The
 * two optional calls keep a copy of an old inline attachment in that store, bound to its place in the
 * session and to the id of its row, so it is decoded from its row only once.
 */
export type AttachmentReadPort = Readonly<{
  isUserAttachment(sha256: string): Promise<boolean>
  read(sha256: string, range?: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
  cacheInline?(input: {
    sessionKey: string
    seq: number
    kind: string
    index: number
    rowId: string
    bytes: Uint8Array
    mimeType: string
  }): Promise<{ sha256: string; bytes: number }>
  cachedInline?(
    sessionKey: string,
    seq: number,
    kind: string,
    index: number,
    rowId: string,
  ): Promise<{ sha256: string; bytes: number } | undefined>
}>

/** What an ordinary read (a page of text, an image for the model) loads whole: the old inline limit. */
export const ATTACHMENT_READ_MAX_BYTES = USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes
/** The most a caller that copies an original out (`read` with `saveTo`) may load whole. */
export const SESSION_ATTACHMENT_READ_MAX_BYTES = 256 * 1024 * 1024
/** The most bytes one range read hands back; the same bound as the artifact read RPC. */
export const ATTACHMENT_RANGE_MAX_BYTES = ARTIFACT_READ_RPC_MAX_BYTES

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
const missing = () =>
  attachmentFailure('ATTACHMENT_MISSING', 'The stored attachment is missing from the attachment store.')

/** A store failure as the reader reports it; a cancelled read stays a cancellation. */
function fromStore(error: unknown, signal: AbortSignal | undefined): Error {
  if (signal?.aborted)
    return signal.reason instanceof Error ? signal.reason : new Error('Attachment read cancelled.')
  if (error instanceof CoreError) return error
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
  if (code === 'ATTACHMENT_MISSING') return missing()
  if (code === 'ATTACHMENT_TOO_LARGE')
    return attachmentFailure('ATTACHMENT_TOO_LARGE', 'The stored attachment is too large to read whole.')
  return attachmentFailure('ATTACHMENT_UNREADABLE', 'The stored attachment could not be read.')
}

function port(s: Reader): AttachmentReadPort | undefined {
  return s.d.attachments
}

/**
 * Reads a stored object only when the store holds it as a user attachment or thumbnail. Any other
 * object (spilled tool output, a request version) is refused exactly as a missing one is, so a digest
 * written into a row can neither fetch it nor learn that it exists.
 */
async function servedRead(
  p: AttachmentReadPort,
  sha256: string,
  range: { offset: number; length: number } | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    if (!(await p.isUserAttachment(sha256))) throw missing()
    return await p.read(sha256, range, signal)
  } catch (error) {
    throw fromStore(error, signal)
  }
}

/** A whole, digest-checked read of a stored object that must be `bytes` long. */
async function storedWhole(
  p: AttachmentReadPort,
  sha256: string,
  bytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const out = await servedRead(p, sha256, undefined, signal)
  if (out.byteLength !== bytes)
    throw attachmentFailure(
      'ATTACHMENT_CORRUPT',
      'The stored attachment does not have the size its message records.',
    )
  return out
}

/** The block's bytes decoded from its own ledger row, which is read in full (not the lean view). */
async function fromRow(
  s: Reader,
  entry: AttachmentEntry,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const [row] = await s.d.log.scan({
    fromSeq: entry.seq,
    toSeq: entry.seq,
    type: 'user/message',
    lane: entry.lane,
    limit: 1,
  })
  signal?.throwIfAborted()
  const content =
    row?.id === entry.rowId ? (row?.data as { content?: unknown } | undefined)?.content : undefined
  const block = (Array.isArray(content) ? content : []).filter(
    (b): b is Record<string, unknown> =>
      !!b && typeof b === 'object' && (b as { type?: unknown }).type === entry.kind,
  )[entry.index - 1]
  if (!block || typeof block.data !== 'string')
    throw attachmentFailure('ATTACHMENT_MISSING', 'The attachment data is not in its message.')
  try {
    return decodeAttachmentData(block.data, maxBytes)
  } catch {
    throw attachmentFailure('ATTACHMENT_CORRUPT', 'The attachment data in its message cannot be decoded.')
  }
}

/** The store copy an old inline block was given, if one was kept for this very row and size. */
async function cachedCopy(
  s: Reader,
  entry: AttachmentEntry,
): Promise<{ sha256: string; bytes: number } | undefined> {
  const p = port(s)
  const cached = await p
    ?.cachedInline?.(s.key, entry.seq, entry.kind, entry.index, entry.rowId)
    .catch(() => undefined)
  return cached && cached.bytes === entry.bytes ? cached : undefined
}

/** Whole reads above this size wait for a permit, so a burst of them cannot hold unbounded memory. */
export const LARGE_ATTACHMENT_READ_BYTES = 8 * 1024 * 1024
const LARGE_READS_PER_SESSION = 2
const LARGE_READS_PER_PROCESS = 4

class Permits {
  #active = 0
  readonly #waiting: Array<() => void> = []
  constructor(readonly limit: number) {}
  async take(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active++
      return
    }
    // The releasing holder hands its permit straight over, so the count never dips in between.
    await new Promise<void>((resolve) => this.#waiting.push(resolve))
  }
  release(): void {
    const next = this.#waiting.shift()
    if (next) next()
    else this.#active--
  }
}

const processPermits = new Permits(LARGE_READS_PER_PROCESS)
const sessionPermits = new WeakMap<object, Permits>()

/** Runs `read` holding a session permit and a process permit when it loads more than 8 MiB. */
async function bounded<T>(s: Reader, bytes: number, read: () => Promise<T>): Promise<T> {
  if (bytes <= LARGE_ATTACHMENT_READ_BYTES) return read()
  let session = sessionPermits.get(s.d)
  if (!session) {
    session = new Permits(LARGE_READS_PER_SESSION)
    sessionPermits.set(s.d, session)
  }
  // Always session first, then process: one order, so two readers can never wait on each other.
  await session.take()
  try {
    await processPermits.take()
    try {
      return await read()
    } finally {
      processPermits.release()
    }
  } finally {
    session.release()
  }
}

/**
 * The bytes of one user attachment, whatever form its row holds. A reference is read from the
 * attachment store with its digest checked; an inline or lean block is decoded from its row once and
 * then kept in the store, so later reads do not rescan the ledger. The ledger itself is never written.
 * Missing or damaged bytes fail with a coded `E_ENVELOPE`, never with a crash or with other bytes.
 *
 * `maxBytes` is the most this call loads whole: the old 100 MiB inline limit unless the caller asks
 * for more (only a copy out of the session does), and never more than 256 MiB.
 */
export async function attachmentBytes(
  s: Reader,
  entry: AttachmentEntry,
  signal?: AbortSignal,
  maxBytes: number = ATTACHMENT_READ_MAX_BYTES,
): Promise<Uint8Array> {
  const limit = Math.min(maxBytes, SESSION_ATTACHMENT_READ_MAX_BYTES)
  if (entry.bytes > limit)
    throw attachmentFailure(
      'ATTACHMENT_TOO_LARGE',
      `The attachment is larger than the ${limit >> 20} MiB a read loads whole.`,
      { bytes: entry.bytes, limit },
    )
  return bounded(s, entry.bytes, async () => {
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
    const bytes = await fromRow(s, entry, limit, signal)
    await p
      ?.cacheInline?.({
        sessionKey: s.key,
        seq: entry.seq,
        kind: entry.kind,
        index: entry.index,
        rowId: entry.rowId,
        bytes,
        mimeType: entry.mimeType,
      })
      .catch(() => undefined)
    return bytes
  })
}

/** Thumbnails are JPEG unless their bytes say PNG; the reference block does not name their type. */
const thumbnailMime = (bytes: Uint8Array) =>
  bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ? 'image/png'
    : 'image/jpeg'

/**
 * The last old inline attachment decoded for windows, per session, for when no store copy can be
 * kept (no store, the cache off or failing): a download in windows then decodes its row once, not
 * once per window. It is dropped after its last window, when another attachment is read, or after
 * a minute without a window.
 */
const MEMO_IDLE_MS = 60_000
type Memo = { key: string; bytes: Uint8Array; timer: ReturnType<typeof setTimeout> }
const memos = new WeakMap<object, Memo>()

function forget(owner: object): void {
  const memo = memos.get(owner)
  if (!memo) return
  clearTimeout(memo.timer)
  memos.delete(owner)
}

function remember(owner: object, key: string, bytes: Uint8Array): void {
  forget(owner)
  const timer = setTimeout(() => {
    if (memos.get(owner)?.key === key) memos.delete(owner)
  }, MEMO_IDLE_MS)
  ;(timer as { unref?: () => void }).unref?.()
  memos.set(owner, { key, bytes, timer })
}

export type AttachmentWindow = { mimeType: string; totalBytes: number; bytes: Uint8Array; sha256?: string }

/**
 * One window of an attachment, or of its thumbnail, for a client that downloads it in pieces. An
 * object that fits one window is read whole, so its digest is checked; a larger stored object is read
 * by range, which the store does not check, and the window names the object's digest so the client
 * can check what it put together. An old inline block is copied into the store on its first window
 * and later windows come from there (the copy's digest is named the same way).
 */
export async function attachmentRange(
  s: Reader,
  locate: { seq: number; kind: AttachmentKind; index: number },
  window: { offset: number; length: number; thumbnail?: boolean },
  entry: AttachmentEntry | undefined,
  signal?: AbortSignal,
): Promise<AttachmentWindow> {
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
    if (!entry.thumbnail) throw attachmentFailure('ATTACHMENT_NOT_FOUND', 'This attachment has no thumbnail.')
    if (!p)
      throw attachmentFailure('ATTACHMENT_MISSING', 'The attachment store is unavailable in this runtime.')
    const bytes = await storedWhole(p, entry.thumbnail.sha256, entry.thumbnail.bytes, signal)
    return {
      mimeType: thumbnailMime(bytes),
      totalBytes: bytes.byteLength,
      bytes: slice(bytes, bytes.byteLength),
      sha256: entry.thumbnail.sha256,
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
  const end = Math.min(total, window.offset + length)
  if (p && stored && !(window.offset === 0 && end === total)) {
    try {
      const bytes = await servedRead(
        p,
        stored.sha256,
        { offset: window.offset, length: end - window.offset },
        signal,
      )
      return { mimeType: entry.mimeType, totalBytes: total, bytes, sha256: stored.sha256 }
    } catch (error) {
      // A cached copy that went away is read from the row again below; a reference has no other source.
      if (entry.form === 'reference') throw error
    }
  }
  if (p && stored && entry.form === 'reference') {
    const bytes = await attachmentBytes(s, entry, signal, ATTACHMENT_RANGE_MAX_BYTES)
    return { mimeType: entry.mimeType, totalBytes: total, bytes: slice(bytes, total), sha256: stored.sha256 }
  }
  const key = `${entry.rowId}/${entry.kind}/${entry.index}`
  let bytes = memos.get(s.d)?.key === key ? memos.get(s.d)?.bytes : undefined
  if (!bytes) {
    bytes = await attachmentBytes(s, entry, signal)
    const copy = await cachedCopy(s, entry)
    if (copy) {
      forget(s.d)
      return { mimeType: entry.mimeType, totalBytes: total, bytes: slice(bytes, total), sha256: copy.sha256 }
    }
    if (end < total) remember(s.d, key, bytes)
  } else if (end === total) forget(s.d)
  return { mimeType: entry.mimeType, totalBytes: total, bytes: slice(bytes, total) }
}
