import { deflateSync } from 'node:zlib'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { RequestMediaLimits } from '../../src/orchestrator/request-media.js'
import { sha256Hex } from '../../src/request/hash.js'
import type { LegacyImage } from '../../src/runtime/media/legacy-bridge.js'

const u32 = (value: number) => [value >>> 24, value >>> 16, value >>> 8, value].map((byte) => byte & 0xff)
const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}
function chunk(type: string, data: readonly number[]): number[] {
  const typed = [...Buffer.from(type, 'ascii'), ...data]
  let crc = 0xffffffff
  for (const byte of typed) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return [...u32(data.length), ...typed, ...u32((crc ^ 0xffffffff) >>> 0)]
}
/** A valid 1-bit PNG; `marker` makes distinct bytes (and digests) of the same size. */
export function png(width = 8, height = 8, marker = 0): Uint8Array {
  const raw = new Uint8Array(height * (Math.ceil(width / 8) + 1))
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', [...u32(width), ...u32(height), 1, 0, 0, 0, 0]),
    ...chunk('tEXt', [...Buffer.from(`marker\0${marker}`, 'ascii')]),
    ...chunk('IDAT', [...deflateSync(raw)]),
    ...chunk('IEND', []),
  ])
}

export const LIMITS: RequestMediaLimits = {
  maxManifestEntries: 8,
  maxSelectedImages: 8,
  maxSelectedBlocks: 16,
  maxBytesPerImage: 4096,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 10_000_000,
  maxSelectedBytes: 16384,
  maxSelectedPixels: 10_000_000,
}

export function blobOf(bytes: Uint8Array, mediaType = 'image/png'): W.BlobRef {
  const digest = sha256Hex(bytes)
  return {
    authorityId: 'blob-authority',
    blobId: `blob-${digest.slice(0, 12)}`,
    digest,
    bytes: bytes.length,
    mediaType,
    pinId: `pin-${digest.slice(0, 12)}`,
  }
}
export const publicBlob = (bytes: Uint8Array, mediaType?: string): W.PublicRef => ({
  kind: 'blob',
  value: blobOf(bytes, mediaType),
})

export function legacyImage(node: number, block: number, marker: number): LegacyImage {
  const bytes = png(8, 8, marker)
  return { node, block, blob: blobOf(bytes), bytes, sourceTool: 'computer_use' }
}

export const featuresText: W.ModelFeatures = {
  input: ['text'],
  output: ['text'],
  tools: false,
  structuredOutput: false,
  streaming: true,
}
export const featuresImage: W.ModelFeatures = { ...featuresText, input: ['text', 'image'] }

export const mediaBinding: W.BindingRef = {
  bindingId: 'media-binding',
  providerId: 'agh.default/media',
  contract: 'agh.media',
  logicalName: 'default',
}
export const stateBinding: W.BindingRef = {
  bindingId: 'state-binding',
  providerId: 'agh.default/state',
  contract: 'agh.state',
  logicalName: 'default',
}
export const modelBinding: W.BindingRef = {
  bindingId: 'model-binding',
  providerId: 'agh.default/model',
  contract: 'agh.model',
  logicalName: 'default',
}

export const digestOf = (value: unknown) => canonicalJsonDigest(value as W.JsonValue)
