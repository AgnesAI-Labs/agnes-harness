// Adapted from dsh-superagent (MIT)
/** Downloads only keys from a scoped source message into a disposable private directory. */
import { mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { z } from 'zod'
import { fetchMessages } from './feishu-client.js'
import type { FeishuIo } from './feishu-io.js'
import type { FeishuRef } from './feishu-read.js'
import type { ImageMediaType, ImageSink } from './kind.js'

export function admissionImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])]
}
export interface AdmissionImage {
  source_message_id: string
  image_key: string
  image: unknown
}
const types: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
export async function readAdmissionImage(
  sink: ImageSink,
  io: FeishuIo,
  ref: FeishuRef,
  text: string,
  imageKey: string,
): Promise<AdmissionImage> {
  io.assertCurrent()
  if (!admissionImageKeys(text).includes(imageKey))
    throw new Error('Choose an image key from this source message')
  const signal = io.signal ?? new AbortController().signal
  const { maxBytes } = await sink.check(signal)
  const [source] = await fetchMessages(io, ref.chatId, [ref.messageId])
  if (!source || !admissionImageKeys(source.text).includes(imageKey))
    throw new Error('The source Feishu message does not contain this image')
  const directory = await mkdtemp(join(io.stateDir, 'admission-image-'))
  try {
    const result = z
      .object({ saved_path: z.string() })
      .parse(
        await io.commands.lark(
          [
            'im',
            '+messages-resources-download',
            '--message-id',
            ref.messageId,
            '--file-key',
            imageKey,
            '--type',
            'image',
            '--output',
            './image',
          ],
          directory,
        ),
      )
    const path = await realpath(resolve(directory, result.saved_path))
    if (dirname(path) !== (await realpath(directory)))
      throw new Error('Image download returned a path outside its temporary directory')
    const mediaType = types[extname(path).toLowerCase()]
    if (!mediaType) throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error('The image exceeds the byte limit or is not a regular file')
      // Read at most maxBytes+1 even if a wrapper grows the file after stat.
      const data = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
      const { bytesRead } = await file.read(data, 0, data.length, 0)
      if (bytesRead > maxBytes || bytesRead > stat.size)
        throw new Error('The downloaded image changed or exceeds the byte limit')
      io.assertCurrent()
      const image = await sink.save({
        data: data.subarray(0, bytesRead),
        mediaType,
        name: `${imageKey}${extname(path)}`,
      })
      return { source_message_id: ref.messageId, image_key: imageKey, image }
    } finally {
      await file.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
