import {
  FILE_UPLOAD_PATH,
  type FileUploadResult,
  IncrementalSha256,
  type UploadedAttachment,
  type UploadLimits,
} from '@agnes/protocol'

export type UploadProgress = { loaded: number; total: number; phase: 'uploading' | 'verifying' }
export class FileUploadFailure extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, string | number> = {},
  ) {
    super(code)
  }
}
async function result(response: Response): Promise<FileUploadResult> {
  const value = (await response.json()) as FileUploadResult & { error?: string }
  if (!response.ok || value.error) throw new FileUploadFailure(value.error ?? 'UPLOAD_UNAVAILABLE')
  return value
}
export async function fileUploadLimits(sessionId: string, signal: AbortSignal): Promise<UploadLimits> {
  const value = await result(
    await fetch(`${FILE_UPLOAD_PATH}?${new URLSearchParams({ sessionId })}`, { signal }),
  )
  if (
    !value.limits ||
    !Number.isSafeInteger(value.limits.chunkBytes) ||
    value.limits.chunkBytes < 1 ||
    value.limits.chunkBytes > 1024 * 1024 ||
    !Number.isSafeInteger(value.limits.maxBytes) ||
    value.limits.maxBytes < 1 ||
    !Array.isArray(value.limits.allowedMimeTypes)
  )
    throw new FileUploadFailure('UPLOAD_UNAVAILABLE')
  return value.limits
}
export async function cancelFileUpload(sessionId: string, uploadId: string): Promise<void> {
  await result(
    await fetch(FILE_UPLOAD_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'cancel', sessionId, uploadId }),
      keepalive: true,
    }),
  )
}

/** Slices a File on demand; only a single chunk and the 64-byte hash state remain live. */
export async function uploadFile(
  file: File,
  sessionId: string,
  uploadId: string,
  limits: UploadLimits,
  signal: AbortSignal,
  progress: (value: UploadProgress) => void,
): Promise<UploadedAttachment> {
  const mimeType = file.type.split(';')[0]?.trim() || 'application/octet-stream'
  if (file.size > limits.maxBytes)
    throw new FileUploadFailure('UPLOAD_SIZE_LIMIT', { limit: limits.maxBytes })
  if (limits.allowedMimeTypes.length && !limits.allowedMimeTypes.includes(mimeType))
    throw new FileUploadFailure('UPLOAD_TYPE_LIMIT', { types: limits.allowedMimeTypes.join(', ') })
  const post = async (operation: string, values = {}) =>
    result(
      await fetch(FILE_UPLOAD_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ operation, sessionId, uploadId, ...values }),
      }),
    )
  signal.throwIfAborted()
  const started = await post('start', { name: file.name, mimeType, size: file.size })
  if (started.attachment) return started.attachment
  const resumeOffset = started.offset ?? 0
  if (
    !Number.isSafeInteger(resumeOffset) ||
    resumeOffset < 0 ||
    resumeOffset > file.size ||
    (resumeOffset !== file.size && resumeOffset % limits.chunkBytes !== 0)
  )
    throw new FileUploadFailure('UPLOAD_OFFSET_MISMATCH')
  const sha = new IncrementalSha256()
  progress({ loaded: 0, total: file.size, phase: 'uploading' })
  for (let offset = 0; offset < file.size; offset += limits.chunkBytes) {
    signal.throwIfAborted()
    const slice = file.slice(offset, offset + limits.chunkBytes)
    const bytes = new Uint8Array(await slice.arrayBuffer())
    signal.throwIfAborted()
    sha.update(bytes)
    const chunkHash = new IncrementalSha256().update(bytes).digest()
    const query = new URLSearchParams({
      operation: 'chunk',
      sessionId,
      uploadId,
      offset: String(offset),
      sha256: chunkHash,
    })
    if (offset + bytes.length <= resumeOffset) {
      progress({ loaded: offset + bytes.length, total: file.size, phase: 'uploading' })
      continue
    }
    let acknowledged = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const value = await result(
          await fetch(`${FILE_UPLOAD_PATH}?${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: slice,
            signal,
          }),
        )
        if ((value.offset ?? 0) < offset + bytes.length) throw new FileUploadFailure('UPLOAD_OFFSET_MISMATCH')
        acknowledged = true
        break
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof FileUploadFailure && error.code !== 'UPLOAD_UNAVAILABLE') throw error
        if (attempt === 2) throw error
      }
    }
    if (acknowledged)
      progress({
        loaded: Math.min(offset + limits.chunkBytes, file.size),
        total: file.size,
        phase: 'uploading',
      })
  }
  progress({ loaded: file.size, total: file.size, phase: 'verifying' })
  const final = await post('finish', { sha256: sha.digest() })
  signal.throwIfAborted()
  if (!final.attachment) throw new FileUploadFailure('UPLOAD_UNAVAILABLE')
  return final.attachment
}
