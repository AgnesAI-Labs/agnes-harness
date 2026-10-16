import { open } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { type Session, uploadAttachment } from '@agnes/sdk'

/** A local user-selected original, sliced through one stable file descriptor. */
export async function uploadLocalAttachment(
  session: Session,
  cwd: string,
  path: string,
  signal?: AbortSignal,
) {
  const file = await open(resolve(cwd, path), 'r')
  try {
    const original = await file.stat()
    if (!original.isFile() || original.size > 100 * 1024 * 1024)
      throw Object.assign(new Error('ATTACHMENT_BYTES'), { code: 'ATTACHMENT_BYTES' })
    const mime =
      (
        {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.pdf': 'application/pdf',
          '.txt': 'text/plain',
        } as Record<string, string>
      )[extname(path).toLowerCase()] ?? 'application/octet-stream'
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
