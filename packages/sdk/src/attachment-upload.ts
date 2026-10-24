import {
  FILE_UPLOAD_CHUNK_BYTES,
  type FileUploadRequest,
  type FileUploadResult,
  IncrementalSha256,
  type StoredAttachment,
  storedAttachment,
} from '@agnes/protocol'

export type AttachmentUploadSource = {
  name: string
  type: string
  size: number
  /** Read exactly this bounded window. Never materialize the whole source for RPC. */
  read(start: number, end: number): Promise<Uint8Array>
}
export type AttachmentUploadTransport = {
  call<T>(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<T>
}
export type AttachmentUploadScope = { sessionId: string; laneId: string }

/** Public original intake. Reusing uploadId resumes a disconnected intake in the same live session.
 * A lost finish response is deliberately not retried: an expired/consumed receipt never resurrects.
 */
export async function uploadAttachment(
  client: AttachmentUploadTransport,
  scope: AttachmentUploadScope,
  source: AttachmentUploadSource,
  options: { uploadId?: string; signal?: AbortSignal; progress?: (offset: number) => void } = {},
): Promise<StoredAttachment> {
  const signal = options.signal ?? AbortSignal.timeout(30 * 60_000)
  const uploadId = options.uploadId ?? crypto.randomUUID()
  const call = (input: FileUploadRequest) =>
    client.call<FileUploadResult>('_agnes/v1/session.fileUpload', input, { signal })
  const base = { ...scope, uploadId, destination: 'original' as const }
  try {
    signal.throwIfAborted()
    const started = await call({
      ...base,
      operation: 'start',
      name: source.name,
      mimeType: source.type || 'application/octet-stream',
      size: source.size,
    })
    const offset = started.offset
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > source.size)
      throw new Error('ATTACHMENT_DATA')
    const sha = new IncrementalSha256()
    for (let at = 0; at < source.size; at += FILE_UPLOAD_CHUNK_BYTES) {
      signal.throwIfAborted()
      const end = Math.min(source.size, at + FILE_UPLOAD_CHUNK_BYTES)
      const bytes = await source.read(at, end)
      signal.throwIfAborted()
      if (bytes.length !== end - at) throw new Error('ATTACHMENT_DATA')
      sha.update(bytes)
      if (end > offset) {
        if (at < offset) throw new Error('ATTACHMENT_DATA')
        const parts: string[] = []
        for (let i = 0; i < bytes.length; i += 16384)
          parts.push(String.fromCharCode(...bytes.subarray(i, i + 16384)))
        const ack = await call({
          ...base,
          operation: 'chunk',
          offset: at,
          data: btoa(parts.join('')),
          sha256: new IncrementalSha256().update(bytes).digest(),
        })
        if (ack.offset !== end) throw new Error('ATTACHMENT_DATA')
      }
      options.progress?.(end)
    }
    const digest = sha.digest()
    const result = await call({ ...base, operation: 'finish', sha256: digest })
    if (
      !result.attachment ||
      !storedAttachment(result.attachment) ||
      result.attachment.attachment.artifact.sha256 !== digest ||
      result.attachment.attachment.artifact.size !== source.size ||
      result.attachment.attachment.artifact.mime !== (source.type || 'application/octet-stream') ||
      result.attachment.uri !== `artifact://${digest}` ||
      result.attachment.name !== source.name ||
      !/^[a-f0-9-]{36}$/u.test(result.attachment.attachment.receiptId ?? '') ||
      result.attachment.mimeType !== (source.type || 'application/octet-stream')
    )
      throw new Error('ATTACHMENT_DATA')
    return result.attachment
  } catch (error) {
    // Only caller-supplied IDs can be resumed. Release SDK-owned intakes on every failure;
    // explicit cancellation also ends caller-owned intakes. Never retry a lost finish response.
    if (signal.aborted || options.uploadId === undefined)
      await cancelAttachmentUpload(client, scope, uploadId).catch(() => undefined)
    throw error
  }
}

export async function cancelAttachmentUpload(
  client: AttachmentUploadTransport,
  scope: AttachmentUploadScope,
  uploadId: string,
): Promise<void> {
  await client.call(
    '_agnes/v1/session.fileUpload',
    {
      ...scope,
      uploadId,
      destination: 'original',
      operation: 'cancel',
    },
    { signal: AbortSignal.timeout(5_000) },
  )
}
