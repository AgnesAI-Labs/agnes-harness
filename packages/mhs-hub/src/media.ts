import { type Json, MhsError, object } from '@agnes/mhs-device'

export interface MediaSample {
  device: string
  source: string
  at: number
  data: Json
  mime?: string
  bytes?: Uint8Array
}
/** One gateway frame owns its complete JSON metadata and bytes; no cross-socket pairing. */
export function encodeMedia(sample: MediaSample): Uint8Array {
  const { bytes, ...metadata } = sample
  const header = new TextEncoder().encode(JSON.stringify(metadata))
  if (header.length > 65536 || header.length + (bytes?.length ?? 0) + 4 > 1 << 20)
    throw new MhsError('stream-frame-too-large')
  const out = new Uint8Array(4 + header.length + (bytes?.length ?? 0))
  new DataView(out.buffer).setUint32(0, header.length)
  out.set(header, 4)
  if (bytes) out.set(bytes, header.length + 4)
  return out
}
export function decodeMedia(frame: Uint8Array): MediaSample {
  if (frame.length < 4 || frame.length > 1 << 20) throw new MhsError('invalid-media-frame')
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0)
  if (length > 65536 || length + 4 > frame.length) throw new MhsError('invalid-media-frame')
  const header = object(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4, length + 4))),
  )
  if (
    typeof header.device !== 'string' ||
    typeof header.source !== 'string' ||
    typeof header.at !== 'number' ||
    !Number.isFinite(header.at)
  )
    throw new MhsError('invalid-media-frame')
  return {
    device: header.device,
    source: header.source,
    at: header.at,
    data: (header.data ?? null) as Json,
    ...(typeof header.mime === 'string' ? { mime: header.mime } : {}),
    ...(frame.length > length + 4 ? { bytes: frame.slice(length + 4) } : {}),
  }
}
