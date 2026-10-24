import { createRequire } from 'node:module'
import type { ToolContext, ToolResult } from '@agnes/extension-api'

type Codec = typeof import('sharp')
let loaded: Codec | undefined
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_INPUT_PIXELS = 64_000_000
export const MAX_IMAGE_DECODED_BYTES = 256 * 1024 * 1024
export const MAX_PROGRESSIVE_PIXELS = 16_000_000
export const MAX_PROGRESSIVE_DECODED_BYTES = 64 * 1024 * 1024
export const MAX_CONCURRENT_DECODES = 2
export const IMAGE_PREPARE_TIMEOUT_MS = 30_000
const fail = (text: string, code = 'FS_IMAGE_INVALID'): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
  details: { code },
})

function codec(): Codec | undefined {
  if (loaded) return loaded
  try {
    const value: Codec = createRequire(import.meta.url)('sharp')
    value.cache(false)
    loaded = value
    return value
  } catch {
    return undefined
  }
}

export function localImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return undefined
}

function animatedPng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += view.getUint32(offset) + 12
  }
  return false
}

let active = 0
const queue: (() => void)[] = []
class Deadline extends Error {}
const check = (signal: AbortSignal, deadline: number) => {
  signal.throwIfAborted()
  if (performance.now() >= deadline) throw new Deadline()
}

async function slot(signal: AbortSignal, deadline: number): Promise<void> {
  check(signal, deadline)
  if (queue.length >= 4) throw new Error('Image decoder is busy')
  if (active < MAX_CONCURRENT_DECODES) {
    active++
    return
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const ready = () => {
      cleanup()
      resolve()
    }
    const leave = (reason: unknown) => {
      const index = queue.indexOf(ready)
      if (index < 0) return
      queue.splice(index, 1)
      cleanup()
      reject(reason)
    }
    const abort = () => leave(signal.reason)
    const timer = setTimeout(() => leave(new Deadline()), Math.max(0, deadline - performance.now()))
    queue.push(ready)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
function release() {
  const next = queue.shift()
  if (next) next()
  else active--
}

/** Cancellation ends the caller's wait, but the slot stays occupied until native work stops. */
function bounded<T>(work: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    const timer = setTimeout(() => reject(new Deadline()), Math.max(0, deadline - performance.now()))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    })
    if (signal.aborted) abort()
  })
}

/** Only bytes from the workspace port reach the codec; there is no path-based second open. */
export async function readLocalImage(
  bytes: Uint8Array,
  name: string,
  ctx: ToolContext,
  maxEdge?: number,
): Promise<ToolResult> {
  const policy = await ctx.session.imageInputPolicy?.()
  if (!policy?.supported || !ctx.session.imageInput)
    return {
      content: [
        {
          type: 'text',
          text: 'The selected model does not support image input. Image pixels were not inspected; select a vision-capable model to read them.',
        },
      ],
    }
  if (bytes.length > MAX_IMAGE_FILE_BYTES)
    return fail(
      `Workspace image is ${bytes.length} bytes (limit ${MAX_IMAGE_FILE_BYTES}); resize/compress it before reading.`,
      'FS_IMAGE_SIZE_LIMIT',
    )
  const mimeType = localImageMime(bytes)
  if (!mimeType)
    return fail(
      'Only PNG and JPEG images are supported; convert a copy to single-frame PNG/JPEG.',
      'FS_IMAGE_FORMAT',
    )
  if (mimeType === 'image/png' && animatedPng(bytes))
    return fail('Animated images are unsupported; export one frame as PNG/JPEG.', 'FS_IMAGE_FORMAT')
  const sharp = codec()
  if (!sharp)
    return fail(
      'The image codec is unavailable; ask the user to install/repair the image codec or use another available image tool.',
      'FS_IMAGE_CODEC_UNAVAILABLE',
    )
  const deadline = performance.now() + IMAGE_PREPARE_TIMEOUT_MS
  try {
    await slot(ctx.signal, deadline)
    const prepare = async (): Promise<ToolResult> => {
      check(ctx.signal, deadline)
      const decoder = sharp(bytes, {
        limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
        failOn: 'warning',
        sequentialRead: true,
      })
      const metadata = await decoder.metadata()
      check(ctx.signal, deadline)
      const width = metadata.width ?? 0,
        height = metadata.height ?? 0
      if (
        metadata.format !== (mimeType === 'image/png' ? 'png' : 'jpeg') ||
        width < 1 ||
        height < 1 ||
        (metadata.pages ?? 1) !== 1
      )
        return fail('The image is invalid or animated; export a valid single-frame PNG/JPEG and retry.')
      const sample = { uchar: 1, char: 1, ushort: 2, short: 2 }[
        metadata.depth as 'uchar' | 'char' | 'ushort' | 'short'
      ]
      if (!sample)
        return fail('The image sample depth is unsupported; export an 8-bit PNG/JPEG.', 'FS_IMAGE_FORMAT')
      const pixels = width * height
      const decodedBytes = pixels * Math.max(4, metadata.channels ?? 4) * sample
      if (
        pixels > MAX_IMAGE_INPUT_PIXELS ||
        decodedBytes > MAX_IMAGE_DECODED_BYTES ||
        (metadata.isProgressive &&
          (pixels > MAX_PROGRESSIVE_PIXELS || decodedBytes > MAX_PROGRESSIVE_DECODED_BYTES))
      )
        return fail(
          `The image is ${width}x${height} (${pixels} pixels, estimated ${decodedBytes} decoded bytes); exceeds safe decoder limits. Resize/export a smaller non-progressive PNG/JPEG.`,
          'FS_IMAGE_DECODE_LIMIT',
        )
      const edge = maxEdge ?? 1456
      if (!Number.isSafeInteger(edge) || edge < 8 || edge > 1456)
        return fail(`max_edge=${edge} is invalid; use an integer between 8 and 1456.`, 'FS_IMAGE_EDGE')
      const scale = Math.min(
        1,
        Math.min(edge, policy.maxWidth) / width,
        Math.min(edge, policy.maxHeight) / height,
        Math.sqrt(policy.maxPixels / pixels),
      )
      let targetWidth = Math.floor(width * scale),
        targetHeight = Math.floor(height * scale)
      for (let attempt = 0; attempt < 8 && targetWidth >= 8 && targetHeight >= 8; attempt++) {
        check(ctx.signal, deadline)
        const resized = decoder
          .clone()
          .rotate()
          .resize({ width: targetWidth, height: targetHeight, fit: 'inside', withoutEnlargement: true })
          .timeout({ seconds: Math.max(1, Math.ceil((deadline - performance.now()) / 1000)) })
        const output = await (mimeType === 'image/png'
          ? resized.png()
          : resized.jpeg({ quality: 85 })
        ).toBuffer()
        check(ctx.signal, deadline)
        if (output.length <= policy.maxBytes)
          return ctx.session.imageInput!({ bytes: output, mimeType, name })
        targetWidth = Math.floor(targetWidth * 0.7)
        targetHeight = Math.floor(targetHeight * 0.7)
      }
      return fail(
        'The image cannot fit the active model image limits; use a smaller crop or select a model with larger image limits.',
        'FS_IMAGE_MODEL_LIMIT',
      )
    }
    const work = prepare()
    work.then(release, release)
    return await bounded(work, ctx.signal, deadline)
  } catch (error) {
    ctx.signal.throwIfAborted()
    return fail(
      error instanceof Deadline
        ? 'Image preparation exceeded its total time limit; resize the source image before retrying.'
        : 'The image is invalid, the decoder is busy, or decoder limits were exceeded; wait for active reads or export a smaller valid PNG/JPEG.',
    )
  }
}
