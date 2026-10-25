import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { type Session, uploadAttachment } from '@agnes/sdk'

/**
 * Extension to MIME type, as a browser reports it for the same file in the Web composer. The daemon
 * takes any well-formed type (and refuses one outside its configured allow-list, which reaches the
 * user verbatim), so an extension not listed travels as `application/octet-stream`, as on the Web.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
}

export function attachmentMime(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** A local user-selected original, sliced through one stable file descriptor. */
export async function uploadLocalAttachment(
  session: Session,
  cwd: string,
  path: string,
  signal?: AbortSignal,
) {
  // Non-blocking, so a FIFO named like a file fails the regular-file check below instead of
  // hanging the open in a thread nothing can abort.
  const file = await open(resolve(cwd, path), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const original = await file.stat()
    if (!original.isFile() || original.size > 100 * 1024 * 1024)
      throw Object.assign(new Error('ATTACHMENT_BYTES'), { code: 'ATTACHMENT_BYTES' })
    const mime = attachmentMime(path)
    return await uploadAttachment(
      session.client,
      { sessionId: session.id, laneId: 'main' },
      {
        name: basename(path),
        type: mime,
        size: original.size,
        read: async (start, end) => {
          const info = await file.stat()
          if (info.size !== original.size || info.mtimeMs !== original.mtimeMs)
            throw Object.assign(new Error('ATTACHMENT_DATA'), { code: 'ATTACHMENT_DATA' })
          const bytes = new Uint8Array(end - start)
          let at = 0
          while (at < bytes.length) {
            const { bytesRead } = await file.read(bytes, at, bytes.length - at, start + at)
            if (!bytesRead) throw Object.assign(new Error('ATTACHMENT_DATA'), { code: 'ATTACHMENT_DATA' })
            at += bytesRead
          }
          return bytes
        },
      },
      signal ? { signal } : {},
    )
  } finally {
    await file.close()
  }
}
