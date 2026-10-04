import { decodeSafeImageBytes } from '@agnes/protocol-validation'

/** Identify local raster formats from bytes, never from a model-supplied URL or file suffix. */
export function readImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
    return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes.length >= 13 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/** Bounded structural validation; unsupported formats never reach the artifact store. */
export function validateReadImage(bytes: Uint8Array, mime: string, maxBytes: number): void {
  decodeSafeImageBytes(
    { bytes, mimeType: mime },
    {
      maxBytesPerImage: maxBytes,
      maxAggregateBytes: maxBytes,
      maxPixelsPerImage: 16 * 1024 * 1024,
      maxAggregatePixels: 16 * 1024 * 1024,
    },
  )
}
