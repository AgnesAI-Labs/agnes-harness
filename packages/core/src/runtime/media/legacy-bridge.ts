import type { Outcome } from '@agnes/extension-api/runtime'
import { type RequestMediaHeader, validateRequestMedia } from '@agnes/protocol'
import type { RuntimeError } from '@agnes/protocol/runtime'
import { decodeSafeImageBytes, SafeImageError } from '@agnes/protocol-validation'
import {
  hashPreparedRequestMedia,
  type PreparedRequestMedia,
  prepareRequestMedia,
  type RequestMediaCandidate,
  type RequestMediaLimits,
  RequestMediaPreflightError,
  restoreRequestMedia,
} from '../../orchestrator/request-media.js'
import { sha256Hex } from '../../request/hash.js'

const refuse = (code: RuntimeError['code'], detailCode: string): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Media operation refused',
    diagnosticId: 'media-prepare',
    retryAdvice: { kind: 'never' },
  },
})

export type LegacyImage = Readonly<{
  /** 1-based view node ordinal; sources in one node share it. */
  node: number
  /** Position of the source inside its node. */
  block: number
  blob: Readonly<{ digest: string; bytes: number; mediaType: string }>
  bytes: Uint8Array
  sourceTool: string
}>
export type LegacyMode = 'native' | 'convert'
export type RestoreSource = Readonly<{
  manifestIndex: number
  blockIndex: number
  bytes: Uint8Array
  sourceTool: string
}>

function mapLegacy(error: unknown): { ok: false; error: RuntimeError } {
  if (error instanceof RequestMediaPreflightError) {
    switch (error.code) {
      case 'DIGEST_MISMATCH':
      case 'METADATA_MISMATCH':
        return refuse('conflict', 'media_source_drift')
      case 'IMAGE_INVALID':
        return refuse('invalid_input', 'media_image_invalid')
      case 'MANIFEST_LIMIT':
      case 'IMAGE_COUNT_LIMIT':
      case 'BLOCK_LIMIT':
      case 'BYTE_LIMIT':
      case 'DIMENSION_LIMIT':
      case 'PIXEL_LIMIT':
        return refuse('quota', 'media_image_limit')
      case 'PERSISTED_HEADER_INVALID':
      case 'RESTORE_SOURCE_INVALID':
      case 'SELECTED_BYTES_MISSING':
        return refuse('conflict', 'media_continuation_conflict')
      default:
        return refuse('invalid_input', 'media_input_schema')
    }
  }
  if (error instanceof SafeImageError) {
    const limit = error.code === 'BYTE_LIMIT' || error.code === 'PIXEL_LIMIT'
    return refuse(limit ? 'quota' : 'invalid_input', limit ? 'media_image_limit' : 'media_image_invalid')
  }
  throw error
}

/** Decodes each image with the shared safe decoder and recomputes its digest before it becomes a candidate. */
export function candidatesFrom(
  images: readonly LegacyImage[],
  limits: RequestMediaLimits,
): Outcome<RequestMediaCandidate[]> {
  try {
    const out: RequestMediaCandidate[] = []
    for (const image of images) {
      const decoded = decodeSafeImageBytes(
        { bytes: image.bytes, mimeType: image.blob.mediaType },
        {
          maxBytesPerImage: limits.maxBytesPerImage,
          maxPixelsPerImage: limits.maxPixelsPerImage,
          maxAggregateBytes: limits.maxSelectedBytes,
          maxAggregatePixels: limits.maxSelectedPixels,
        },
      )
      const sha256 = sha256Hex(decoded.bytes)
      if (sha256 !== image.blob.digest) return refuse('conflict', 'media_source_drift')
      out.push({
        nodeSeq: image.node,
        blockIndex: image.block,
        artifactUri: `artifact://${sha256}`,
        sha256,
        mime: decoded.mime,
        width: decoded.width,
        height: decoded.height,
        bytes: decoded.bytes,
        sourceTool: image.sourceTool,
      })
    }
    return { ok: true, value: out }
  } catch (error) {
    return mapLegacy(error)
  }
}

/** Native keeps the image route; convert asks the legacy router for the auxiliary-vision route. */
export function preflight(
  candidates: readonly RequestMediaCandidate[],
  mode: LegacyMode,
  limits: RequestMediaLimits,
): Outcome<PreparedRequestMedia> {
  try {
    return {
      ok: true,
      value: prepareRequestMedia({
        candidates,
        mainModelInput: mode === 'native' ? ['text', 'image'] : ['text'],
        auxiliaryVisionAvailable: mode === 'convert',
        limits,
      }),
    }
  } catch (error) {
    return mapLegacy(error)
  }
}

/** Rebuilds exactly the persisted selection from re-read bytes; it never re-runs selection. */
export function restore(
  header: RequestMediaHeader,
  sources: readonly RestoreSource[],
  limits: RequestMediaLimits,
): Outcome<PreparedRequestMedia> {
  try {
    return { ok: true, value: restoreRequestMedia({ header, sources, limits }) }
  } catch (error) {
    return mapLegacy(error)
  }
}

export function parseHeader(value: unknown): Outcome<RequestMediaHeader> {
  const checked = validateRequestMedia(value)
  return checked.ok
    ? { ok: true, value: checked.value.media }
    : refuse('conflict', 'media_continuation_conflict')
}

export const mediaHash = (prepared: PreparedRequestMedia): string => hashPreparedRequestMedia(prepared)

/** No resize implementation exists: an image beyond the edge limit is refused, never silently kept. */
export function checkEdge(prepared: PreparedRequestMedia, maxEdge: number): Outcome<void> {
  return prepared.selected.some((image) => Math.max(image.width, image.height) > maxEdge)
    ? refuse('incompatible', 'media_image_resize_required')
    : { ok: true, value: undefined }
}
