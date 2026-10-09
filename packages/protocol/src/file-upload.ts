import type { ContentBlock } from '../gen/ts/session-v1.js'
import type { FileUploadParams, FileUploadResultSchema } from '../gen/ts/agnes-v1.js'

export const FILE_UPLOAD_PATH = '/api/attachments/upload'
export const FILE_UPLOAD_CHUNK_BYTES = 1024 * 1024
export type UploadLimits = { maxBytes: number; chunkBytes: number; allowedMimeTypes: string[] }
export type UploadedAttachment = Extract<ContentBlock, { type: 'resource_link' }>
export type FileUploadRequest = FileUploadParams
export type FileUploadResult = FileUploadResultSchema

/** Upload URIs carry identity and size, never an arbitrary disk path. */
export function uploadedAttachment(
  uri: string,
): { session: string; sha256: string; size: number; path: string } | undefined {
  const match = /^agnes-upload:\/\/([a-f0-9]{64})\/([a-f0-9]{64})\/([0-9]+)\/([a-f0-9-]{36})$/u.exec(uri)
  if (!match) return undefined
  const size = Number(match[3])
  if (!Number.isSafeInteger(size) || size < 0) return undefined
  return {
    session: String(match[1]),
    sha256: String(match[2]),
    size,
    path: `.agnes-attachments/${match[1]}/${match[4]}/${match[2]}`,
  }
}
