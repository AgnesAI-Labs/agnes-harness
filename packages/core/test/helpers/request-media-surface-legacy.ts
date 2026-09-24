// Verbatim copy of the first-send request-media path as it was before windowing: every surface
// candidate is read, decoded and listed in the manifest, and ceilings fail the whole preflight.
// Tests use it only as a reference for equivalence and benchmarks; it is never selectable at
// runtime.
import { types as utilTypes } from 'node:util'
import { decodeSafeImageBytes, SafeImageError } from '@agnes/protocol-validation'
import {
  isPreparedRequestMedia,
  type PreparedRequestMedia,
  prepareRequestMedia,
  type RequestMediaCandidate,
  type RequestMediaLimits,
} from '../../src/orchestrator/request-media.js'
import type { SurfaceNode } from '../../src/project/surface.js'
import { canonicalJson, sha256Hex } from '../../src/request/hash.js'
import type { Event } from '../../src/types.js'

const ARTIFACT_URI = /^artifact:\/\/([0-9a-f]{64})$/
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export type RequestMediaSurfaceLimits = Readonly<{
  maxLedgerEvents: number
  maxSurfaceNodes: number
  maxContentBlocks: number
  maxManifestEntries: number
  maxCandidateBytes: number
  maxCandidatePixels: number
}>
export type RequestMediaArtifactRead = Readonly<{
  sessionKey: string
  lane: string
  nodeSeq: number
  sha256: string
  signal: AbortSignal
}>
export type RequestMediaArtifactReader = (
  input: RequestMediaArtifactRead,
) => Promise<Uint8Array | undefined> | Uint8Array | undefined

export class RequestMediaSurfaceError extends Error {
  constructor(
    readonly code:
      | 'SURFACE_INVALID'
      | 'SURFACE_LIMIT'
      | 'MANIFEST_LIMIT'
      | 'INVALID_ARTIFACT_URI'
      | 'INLINE_IMAGE_UNSUPPORTED'
      | 'DUPLICATE_POSITION'
      | 'ARTIFACT_BYTES_MISSING'
      | 'ARTIFACT_DIGEST_MISMATCH'
      | 'IMAGE_INVALID'
      | 'CANDIDATE_BUDGET'
      | 'RESTORE_SOURCE_DRIFT',
    message: string,
  ) {
    super(message)
    this.name = 'RequestMediaSurfaceError'
  }
}

type ImageReference = Readonly<{
  nodeSeq: number
  blockIndex: number
  artifactUri: `artifact://${string}`
  sha256: string
  sourceTool: string
  sourceEventDigest: string
}>
type CandidateBudget = { bytes: number; pixels: number }

export type LedgerPreparedRequestMedia = PreparedRequestMedia & Readonly<{ sessionKey: string }>
const ledgerPreparedMedia = new WeakSet<object>()

/** Runtime authority minted only by this immutable ledger/surface bridge. */
function attestLedgerPreparedRequestMedia(
  value: PreparedRequestMedia,
  sessionKey: string,
): LedgerPreparedRequestMedia {
  if (!isPreparedRequestMedia(value)) throw new TypeError('media was not prepared by Core')
  if (typeof sessionKey !== 'string' || sessionKey.length < 1)
    throw new TypeError('ledger media session key is invalid')
  if (value.selected.some((image) => !image.sourceEventDigest))
    throw new TypeError('selected media lacks immutable ledger provenance')
  const attested = Object.freeze({ ...value, sessionKey }) as LedgerPreparedRequestMedia
  ledgerPreparedMedia.add(attested)
  return attested
}

function fail(code: RequestMediaSurfaceError['code'], message: string): never {
  throw new RequestMediaSurfaceError(code, message)
}
function boundedIdentity(value: unknown, maximum: number, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.normalize('NFC') ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
    throw new TypeError(`${name} is invalid`)
  return value
}
function snapshotReadAuthority(
  sessionKey: unknown,
  lane: unknown,
  signal: unknown,
): Readonly<{ sessionKey: string; lane: string; signal: AbortSignal }> {
  if (
    !signal ||
    typeof signal !== 'object' ||
    utilTypes.isProxy(signal) ||
    Object.getPrototypeOf(signal) !== AbortSignal.prototype
  )
    throw new TypeError('artifact read signal is invalid')
  return Object.freeze({
    sessionKey: boundedIdentity(sessionKey, 512, 'ledger media session key'),
    lane: boundedIdentity(lane, 64, 'ledger media lane'),
    signal: signal as AbortSignal,
  })
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`)
  return value
}
function mediaLimits(input: RequestMediaLimits): RequestMediaLimits {
  return Object.freeze({
    maxManifestEntries: positive(input.maxManifestEntries, 'maxManifestEntries'),
    maxSelectedImages: positive(input.maxSelectedImages, 'maxSelectedImages'),
    maxSelectedBlocks: positive(input.maxSelectedBlocks, 'maxSelectedBlocks'),
    maxBytesPerImage: positive(input.maxBytesPerImage, 'maxBytesPerImage'),
    maxDimensionPerImage: positive(input.maxDimensionPerImage, 'maxDimensionPerImage'),
    maxPixelsPerImage: positive(input.maxPixelsPerImage, 'maxPixelsPerImage'),
    maxSelectedBytes: positive(input.maxSelectedBytes, 'maxSelectedBytes'),
    maxSelectedPixels: positive(input.maxSelectedPixels, 'maxSelectedPixels'),
  })
}
function surfaceLimits(input: RequestMediaSurfaceLimits): RequestMediaSurfaceLimits {
  return Object.freeze({
    maxLedgerEvents: positive(input.maxLedgerEvents, 'maxLedgerEvents'),
    maxSurfaceNodes: positive(input.maxSurfaceNodes, 'maxSurfaceNodes'),
    maxContentBlocks: positive(input.maxContentBlocks, 'maxContentBlocks'),
    maxManifestEntries: positive(input.maxManifestEntries, 'maxManifestEntries'),
    maxCandidateBytes: positive(input.maxCandidateBytes, 'maxCandidateBytes'),
    maxCandidatePixels: positive(input.maxCandidatePixels, 'maxCandidatePixels'),
  })
}
function isImageResource(block: Record<string, unknown>): boolean {
  return (
    block.name === 'image' ||
    (typeof block.mimeType === 'string' && block.mimeType.toLowerCase().startsWith('image/'))
  )
}
type LedgerIndex = Readonly<{ bySeq: ReadonlyMap<number, Event> }>

function snapshotLedger(events: readonly Event[], limits: RequestMediaSurfaceLimits): LedgerIndex {
  if (events.length > limits.maxLedgerEvents) fail('SURFACE_LIMIT', 'ledger exceeds maxLedgerEvents')
  const bySeq = new Map<number, Event>()
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1 || bySeq.has(event.seq))
      fail('SURFACE_INVALID', 'ledger event sequence is invalid or duplicated')
    bySeq.set(event.seq, structuredClone(event))
  }
  return Object.freeze({ bySeq })
}

function toolFromLedger(result: Event, ledger: LedgerIndex): string {
  const data = result.data
  const toolUseId =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).toolUseId
      : undefined
  const calls = (result.sourceEventSeqs ?? []).flatMap((seq) => {
    const event = ledger.bySeq.get(seq)
    if (event?.type !== 'tool/call' || event.seq >= result.seq) return []
    const call = event.data as Record<string, unknown> | null
    return call?.toolUseId === toolUseId ? [call] : []
  })
  if (typeof toolUseId !== 'string' || calls.length !== 1)
    fail('SURFACE_INVALID', `tool-result ${result.seq} lacks one immutable source tool/call`)
  const name = calls[0]?.name
  if (typeof name !== 'string' || !TOOL_NAME.test(name))
    fail('SURFACE_INVALID', `tool-result ${result.seq} source tool name is invalid`)
  if (result.origin.startsWith('tool:') && result.origin.slice(5) !== name)
    fail('SURFACE_INVALID', `tool-result ${result.seq} origin disagrees with its tool/call`)
  if (result.origin !== 'system' && !result.origin.startsWith('tool:'))
    fail('SURFACE_INVALID', `tool-result ${result.seq} has invalid image provenance`)
  return name
}

/** Freeze every identity and enforce scan ceilings before the first asynchronous artifact read. */
function snapshotReferences(
  surface: readonly SurfaceNode[],
  limits: RequestMediaSurfaceLimits,
  ledger: LedgerIndex,
): readonly ImageReference[] {
  if (surface.length > limits.maxSurfaceNodes) fail('SURFACE_LIMIT', 'surface exceeds maxSurfaceNodes')
  const out: ImageReference[] = []
  const positions = new Set<string>()
  const identities = new Set<string>()
  let blocks = 0
  for (const node of surface) {
    if (node.kind !== 'tool_result') continue
    if (!Number.isSafeInteger(node.seq) || node.seq < 1 || node.event?.type !== 'tool/result')
      fail('SURFACE_INVALID', 'tool-result surface node is invalid')
    const data = node.event.data
    const content =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).content
        : undefined
    if (!Array.isArray(content)) fail('SURFACE_INVALID', `tool-result ${node.seq} content is invalid`)
    blocks += content.length
    if (blocks > limits.maxContentBlocks) fail('SURFACE_LIMIT', 'surface exceeds maxContentBlocks')
    const ledgerEvent = ledger.bySeq.get(node.seq)
    if (ledgerEvent?.type !== 'tool/result' || canonicalJson(ledgerEvent) !== canonicalJson(node.event))
      fail('SURFACE_INVALID', `surface tool-result ${node.seq} is not the immutable ledger row`)
    let sourceTool: string | undefined
    for (const [blockIndex, value] of content.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('SURFACE_INVALID', `tool-result ${node.seq} block ${blockIndex} is invalid`)
      const block = value as Record<string, unknown>
      if (block.type === 'image') fail('INLINE_IMAGE_UNSUPPORTED', 'inline image has no artifact identity')
      if (block.type !== 'resource_link' || !isImageResource(block)) continue
      sourceTool ??= toolFromLedger(ledgerEvent, ledger)
      const match = typeof block.uri === 'string' ? ARTIFACT_URI.exec(block.uri) : null
      if (!match) fail('INVALID_ARTIFACT_URI', 'image resource URI must contain a lowercase sha256')
      const key = `${node.seq}:${blockIndex}`
      if (positions.has(key)) fail('DUPLICATE_POSITION', `duplicate image position ${key}`)
      positions.add(key)
      const identity = `${node.seq}:${block.uri}`
      if (identities.has(identity))
        fail('DUPLICATE_POSITION', `duplicate image artifact identity ${identity}`)
      identities.add(identity)
      out.push(
        Object.freeze({
          nodeSeq: node.seq,
          blockIndex,
          artifactUri: block.uri as `artifact://${string}`,
          sha256: match[1] as string,
          sourceTool,
          sourceEventDigest: sha256Hex(canonicalJson(ledgerEvent)),
        }),
      )
      if (out.length > limits.maxManifestEntries)
        fail('MANIFEST_LIMIT', 'surface image candidates exceed maxManifestEntries')
    }
  }
  out.sort((a, b) => a.nodeSeq - b.nodeSeq || a.blockIndex - b.blockIndex)
  return Object.freeze(out)
}

function sniffMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  fail('IMAGE_INVALID', 'artifact is not a PNG or JPEG')
}
async function readDecoded(
  ref: Readonly<{ nodeSeq: number; sha256: string }>,
  readArtifact: RequestMediaArtifactReader,
  authority: Readonly<{ sessionKey: string; lane: string; signal: AbortSignal }>,
  media: RequestMediaLimits,
  surface: RequestMediaSurfaceLimits,
  used: CandidateBudget,
): Promise<ReturnType<typeof decodeSafeImageBytes>> {
  const bytesLeft = surface.maxCandidateBytes - used.bytes
  const pixelsLeft = surface.maxCandidatePixels - used.pixels
  if (bytesLeft < 1 || pixelsLeft < 1) fail('CANDIDATE_BUDGET', 'candidate inspection budget exhausted')
  let bytes: Uint8Array | undefined
  try {
    if (authority.signal.aborted) fail('ARTIFACT_BYTES_MISSING', `artifact ${ref.sha256} could not be read`)
    const request = Object.freeze({ ...authority, nodeSeq: ref.nodeSeq, sha256: ref.sha256 })
    const value = await readArtifact(request)
    if (authority.signal.aborted) fail('ARTIFACT_BYTES_MISSING', `artifact ${ref.sha256} could not be read`)
    if (
      !(value instanceof Uint8Array) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype ||
      !(value.buffer instanceof ArrayBuffer)
    )
      fail('ARTIFACT_BYTES_MISSING', `artifact ${ref.sha256} is unavailable`)
    bytes = new Uint8Array(value)
  } catch {
    fail('ARTIFACT_BYTES_MISSING', `artifact ${ref.sha256} could not be read`)
  }
  try {
    const image = decodeSafeImageBytes(
      { bytes, mimeType: sniffMime(bytes) },
      {
        maxBytesPerImage: Math.min(media.maxBytesPerImage, bytesLeft),
        maxPixelsPerImage: Math.min(media.maxPixelsPerImage, pixelsLeft),
        maxAggregateBytes: bytesLeft,
        maxAggregatePixels: pixelsLeft,
      },
    )
    if (sha256Hex(image.bytes) !== ref.sha256)
      fail('ARTIFACT_DIGEST_MISMATCH', `artifact ${ref.sha256} bytes differ from its URI`)
    used.bytes += image.bytes.length
    used.pixels += image.pixels
    return image
  } catch (error) {
    if (error instanceof RequestMediaSurfaceError) throw error
    if (error instanceof SafeImageError) {
      if (error.code === 'BYTE_LIMIT' || error.code === 'PIXEL_LIMIT')
        fail('CANDIDATE_BUDGET', `image candidate ${ref.sha256} exceeds inspection budget`)
      fail('IMAGE_INVALID', `unsafe image ${ref.sha256}: ${error.message}`)
    }
    throw error
  }
}

export async function legacyRequestMediaCandidatesFromSurface(
  input: Readonly<{
    surface: readonly SurfaceNode[]
    ledgerEvents: readonly Event[]
    readArtifact: RequestMediaArtifactReader
    surfaceLimits: RequestMediaSurfaceLimits
    mediaLimits: RequestMediaLimits
    sessionKey: string
    lane: string
    signal: AbortSignal
  }>,
): Promise<readonly RequestMediaCandidate[]> {
  const readArtifact = input.readArtifact
  if (typeof readArtifact !== 'function') fail('ARTIFACT_BYTES_MISSING', 'artifact reader is unavailable')
  const scan = surfaceLimits(input.surfaceLimits)
  const media = mediaLimits(input.mediaLimits)
  const authority = snapshotReadAuthority(input.sessionKey, input.lane, input.signal)
  const ledger = snapshotLedger([...input.ledgerEvents], scan)
  const references = snapshotReferences(
    [...input.surface],
    { ...scan, maxManifestEntries: Math.min(scan.maxManifestEntries, media.maxManifestEntries) },
    ledger,
  )
  const used = { bytes: 0, pixels: 0 }
  const out: RequestMediaCandidate[] = []
  for (const ref of references) {
    const image = await readDecoded(ref, readArtifact, authority, media, scan, used)
    out.push(
      Object.freeze({
        ...ref,
        mime: image.mime,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
      }),
    )
  }
  return Object.freeze(out)
}

/** First-send composition: selection and wire authority share one immutable ledger snapshot. */
export async function legacyPrepareRequestMediaFromSurface(
  input: Parameters<typeof legacyRequestMediaCandidatesFromSurface>[0] &
    Readonly<{
      sessionKey: string
      mainModelInput: readonly ('text' | 'image')[]
      auxiliaryVisionAvailable: boolean
    }>,
): Promise<LedgerPreparedRequestMedia> {
  const sessionKey = input.sessionKey
  if (typeof sessionKey !== 'string' || sessionKey.length < 1)
    throw new TypeError('ledger media session key is invalid')
  if (!Array.isArray(input.mainModelInput)) throw new TypeError('mainModelInput must be an array')
  const mainModelInput = Object.freeze([...input.mainModelInput])
  if (mainModelInput.some((value) => value !== 'text' && value !== 'image'))
    throw new TypeError('mainModelInput contains an unsupported capability')
  const auxiliaryVisionAvailable = input.auxiliaryVisionAvailable
  if (typeof auxiliaryVisionAvailable !== 'boolean')
    throw new TypeError('auxiliaryVisionAvailable must be boolean')
  const limits = mediaLimits(input.mediaLimits)
  const candidates = await legacyRequestMediaCandidatesFromSurface({
    surface: input.surface,
    ledgerEvents: input.ledgerEvents,
    readArtifact: input.readArtifact,
    surfaceLimits: input.surfaceLimits,
    mediaLimits: limits,
    sessionKey,
    lane: input.lane,
    signal: input.signal,
  })
  return attestLedgerPreparedRequestMedia(
    prepareRequestMedia({
      candidates,
      mainModelInput,
      auxiliaryVisionAvailable,
      limits,
    }),
    sessionKey,
  )
}
