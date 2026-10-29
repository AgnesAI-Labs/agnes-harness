import { userImagePolicy } from '@agnes/protocol'
import { USER_MESSAGE_ATTACHMENT_LIMITS, USER_MESSAGE_IMAGE_LIMITS } from '@agnes/protocol-validation'
import { createRegionHost } from '@agnes/web-ui'
import type { ComposerAttachmentBlock } from './contracts.js'

export type ComposerAttachment = ComposerAttachmentBlock & {
  id: string
  previewUrl?: string
  size: number
  pixels: number
}

export const MAX_IMAGE_BYTES = USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage

export const MAX_TOTAL_IMAGE_BYTES = USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes

export const IMAGE_PREVIEW_LIMITS = USER_MESSAGE_IMAGE_LIMITS

/**
 * Coarse source-file cap to avoid reading enormous files into memory before canvas. Actual per-image
 * and total limits apply after resizing: a multi-MB screenshot often shrinks to a few hundred KB,
 * so checking the original against them would reject it before it could shrink.
 */
export const MAX_SOURCE_IMAGE_BYTES = USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes

/** Product preprocessing limit; a model may declare stricter dimensions. */
export const IMAGE_MAX_EDGE = 1456

/**
 * Shrink images whose long edge exceeds IMAGE_MAX_EDGE to that length, preserving format and filename.
 * Only oversized images change; normal small images (including JPEGs with trailing bytes after EOI) stay intact.
 * If canvas is unavailable or encoding fails, return the original for server-side validation.
 */
export async function downscaleImageFile(file: File, policy = userImagePolicy(undefined)): Promise<File> {
  // Some DOM implementations, including tests, lack bitmap decoding; send the original for server-side validation.
  if (typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // If decoding fails, keep the original: server-side format validation decides whether to reject it.
    return file
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const ratio = Math.min(
      1,
      IMAGE_MAX_EDGE / longest,
      policy.maxWidth / bitmap.width,
      policy.maxHeight / bitmap.height,
    )
    const encodedSize = 4 * Math.ceil(file.size / 3)
    if (ratio === 1 && encodedSize <= (policy.maxBase64Bytes ?? Infinity)) {
      return file
    }
    const canvas = createRegionHost(document.body, 'canvas') as HTMLCanvasElement
    canvas.remove()
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // PNG ignores quality while JPEG uses it. Preserve format so lossy encoding does not blur small screenshot text.
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, file.type, (policy.jpegQuality ?? 92) / 100),
    )
    if (!blob) return file
    return new File([blob], file.name, { type: file.type })
  } finally {
    bitmap.close()
  }
}

export async function readImage(file: File): Promise<{ data: string; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return { data: btoa(binary), bytes }
}

export function blobBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export const nativeImageFile = (file: File): boolean =>
  file.type === 'image/png' ||
  file.type === 'image/jpeg' ||
  (!file.type && /\.(png|jpe?g)$/iu.test(file.name))
