import { jcs } from '@agnes/protocol'
import { sha256Hex } from './hash.js'

export type ImageEncoderSpec = Readonly<{
  formats: readonly ('png' | 'jpeg')[]
  jpegQualities: readonly number[]
}>
export type RequestImageTransform = Readonly<{
  transform: 'agh-request-image-v1' | 'agh-thumb-v1'
  maxWidth: number
  maxHeight: number
  maxPixels: number
  maxBytes: number
  encoder: ImageEncoderSpec
}>

/** PNG first, then JPEG at falling quality: the order an encoder tries until the output fits. */
export const REQUEST_IMAGE_ENCODER: ImageEncoderSpec = Object.freeze({
  formats: Object.freeze(['png', 'jpeg'] as const),
  jpegQualities: Object.freeze([85, 80, 75]),
})

export function requestImageTransform(limits: {
  maxWidth: number
  maxHeight: number
  maxPixels: number
  maxBytes: number
}): RequestImageTransform {
  return Object.freeze({ transform: 'agh-request-image-v1', ...limits, encoder: REQUEST_IMAGE_ENCODER })
}

/**
 * The identity of one derived image: every field that changes the output is in the hash, so a cache
 * keyed by it can never hand back a version made for different limits or by a different encoder.
 * Shared with the batch item engine, whose cache lives in its job directory instead.
 */
export function requestVersionId(source: string, t: RequestImageTransform): string {
  return sha256Hex(
    jcs({
      source,
      transform: t.transform,
      maxWidth: t.maxWidth,
      maxHeight: t.maxHeight,
      maxPixels: t.maxPixels,
      maxBytes: t.maxBytes,
      encoder: { formats: [...t.encoder.formats], jpegQualities: [...t.encoder.jpegQualities] },
    }),
  )
}
