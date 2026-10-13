import {
  ATTACHMENT_REFUSAL_CODES,
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  type AttachmentRefusalCode,
  type ContentBlock,
} from '@agnes/protocol'

/** A thumbnail upload's answer: what an image reference's `thumbnail` carries. */
export type UploadedThumbnail = { sha256: string; bytes: number; width: number; height: number }
export type AttachmentUploadInput = {
  bytes: Blob | Uint8Array
  name: string
  mimeType: string
  purpose?: 'attachment' | 'thumbnail'
}
export type AttachmentUploadOptions = {
  /** Told after every chunk the server accepted: bytes it holds so far, and the whole size. */
  onProgress?(sent: number, total: number): void
  /** Abandons the upload: the server is told to drop it, and the call rejects. */
  signal?: AbortSignal
  /** Resumes the upload a failed call named (its error carries `uploadId`) from the server's offset. */
  uploadId?: string
}

type Call = <T>(
  method: string,
  params: unknown,
  o?: { timeoutMs?: number | null; signal?: AbortSignal },
) => Promise<T>
const METHOD = '_agnes/v1/attachment.upload'
const REFUSALS: ReadonlySet<string> = new Set(ATTACHMENT_REFUSAL_CODES)

/**
 * The code of an attachment refusal (an upload step, or a prompt, steer or follow-up whose attachment
 * the daemon refused), or undefined for any other error.
 */
export function attachmentRefusal(error: unknown): AttachmentRefusalCode | undefined {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' && REFUSALS.has(code) ? (code as AttachmentRefusalCode) : undefined
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}
function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * Uploads in 1 MiB chunks over the client connection, each with its SHA-256. A failed call rejects with
 * an error carrying `uploadId`; calling again with that id resumes from the offset the server reports.
 */
export async function uploadAttachment(
  call: Call,
  sessionId: string,
  input: AttachmentUploadInput,
  o: AttachmentUploadOptions = {},
): Promise<ContentBlock | UploadedThumbnail> {
  const blob = input.bytes instanceof Blob ? input.bytes : new Blob([input.bytes as Uint8Array<ArrayBuffer>])
  const uploadId = o.uploadId ?? crypto.randomUUID()
  const base = { sessionId, uploadId }
  const signal = o.signal ? { signal: o.signal } : {}
  try {
    o.signal?.throwIfAborted()
    let { offset } = await call<{ offset: number }>(
      METHOD,
      {
        operation: 'start',
        ...base,
        name: input.name,
        mimeType: input.mimeType,
        size: blob.size,
        ...(input.purpose ? { purpose: input.purpose } : {}),
      },
      signal,
    )
    if (o.uploadId)
      offset = (await call<{ offset: number }>(METHOD, { operation: 'status', ...base }, signal)).offset
    if (offset > 0) o.onProgress?.(offset, blob.size)
    while (offset < blob.size) {
      o.signal?.throwIfAborted()
      const bytes = new Uint8Array(
        await blob.slice(offset, offset + ATTACHMENT_UPLOAD_CHUNK_BYTES).arrayBuffer(),
      )
      offset = (
        await call<{ offset: number }>(
          METHOD,
          { operation: 'chunk', ...base, offset, data: base64(bytes), sha256: await sha256Hex(bytes) },
          signal,
        )
      ).offset
      o.onProgress?.(offset, blob.size)
    }
    o.signal?.throwIfAborted()
    // No deadline: committing a large object syncs it to disk, which can take longer than a request may.
    const done = await call<{ attachment: ContentBlock | UploadedThumbnail }>(
      METHOD,
      { operation: 'finish', ...base },
      { timeoutMs: null, ...signal },
    )
    return done.attachment
  } catch (error) {
    if (o.signal?.aborted) await call(METHOD, { operation: 'cancel', ...base }).catch(() => undefined)
    throw error !== null && typeof error === 'object'
      ? Object.assign(error, { uploadId })
      : Object.assign(new Error(String(error)), { uploadId })
  }
}
