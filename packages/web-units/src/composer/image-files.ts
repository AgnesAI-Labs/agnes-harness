import { userImagePolicy } from '@agnes/protocol'
import {
  decodeSafeImageBytes,
  USER_MESSAGE_ATTACHMENT_LIMITS,
  USER_MESSAGE_IMAGE_LIMITS,
} from '@agnes/protocol-validation'
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
 * 源文件的粗上限，只为避免把超大文件整体读进内存再交给 canvas。真正的每张与合计上限看
 * 缩放之后的结果：一张几 MB 的截图缩完往往只剩几百 KB，按原图卡会在能缩小之前就拒掉。
 */
export const MAX_SOURCE_IMAGE_BYTES = USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes

/** Product preprocessing limit; a model may declare stricter dimensions. */
export const IMAGE_MAX_EDGE = 1456

/**
 * 把长边超过 IMAGE_MAX_EDGE 的图片缩到该边长，格式和文件名保持不变。只对超限的图动手；
 * 浏览器可读但严格校验不接受的 JPEG 也会重新编码；正常小图保持原样。
 * canvas 不可用或编码失败时原样返回，交给服务端按原图判定。
 */
export async function downscaleImageFile(file: File, policy = userImagePolicy(undefined)): Promise<File> {
  // 有些 DOM 实现没有位图解码（测试环境就是），那种情况下按原图走，交给服务端判定。
  if (typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // 文件本身解不开时也按原图走：拒绝与否由服务端的格式校验决定，这里不下结论。
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
      if (file.type !== 'image/jpeg') return file
      try {
        decodeSafeImageBytes(
          { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type },
          IMAGE_PREVIEW_LIMITS,
        )
        return file
      } catch {
        // 浏览器已成功解码；通过 canvas 去掉尾部附加数据等不兼容结构。
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // PNG 会忽略质量参数，JPEG 用它。保持原格式，避免截图上的小字被有损编码糊掉。
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
