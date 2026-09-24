import { types as utilTypes } from 'node:util'
import { type RequestMediaHeader, validateRequestMedia } from '@agnes/protocol'
import { decodeSafeImageBytes, SafeImageError } from '@agnes/protocol-validation'
import type { SurfaceNode } from '../project/surface.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { Event } from '../types.js'
import {
  forgetVerifiedRequestMediaImage,
  isPreparedRequestMedia,
  type PreparedRequestMedia,
  prepareRequestMedia,
  REQUEST_MEDIA_NODE_WINDOW,
  type RequestMediaCandidate,
  type RequestMediaLimits,
  recordVerifiedRequestMediaImage,
  restoreRequestMedia,
} from './request-media.js'

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
/**
 * What a reader returns for an artifact that retention reclaimed on purpose. The image is left out
 * of the request instead of failing it; a plain `undefined` still means the bytes are missing.
 */
export const REQUEST_MEDIA_ARTIFACT_RECLAIMED: unique symbol = Symbol('request media artifact reclaimed')
type ReaderResult = Uint8Array | typeof REQUEST_MEDIA_ARTIFACT_RECLAIMED | undefined
export type RequestMediaArtifactReader = (
  input: RequestMediaArtifactRead,
) => Promise<ReaderResult> | ReaderResult
/** Extra image nodes tried, beyond the window, when reclaimed images leave window nodes empty. */
const RECLAIMED_EXTENSION_NODES = 2 * REQUEST_MEDIA_NODE_WINDOW

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
      | 'RESTORE_SOURCE_DRIFT'
      | 'ARTIFACT_RECLAIMED',
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

export function isLedgerPreparedRequestMedia(value: unknown): value is LedgerPreparedRequestMedia {
  return !!value && typeof value === 'object' && ledgerPreparedMedia.has(value)
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
): Promise<ReturnType<typeof decodeSafeImageBytes> | typeof REQUEST_MEDIA_ARTIFACT_RECLAIMED> {
  const bytesLeft = surface.maxCandidateBytes - used.bytes
  const pixelsLeft = surface.maxCandidatePixels - used.pixels
  if (bytesLeft < 1 || pixelsLeft < 1) fail('CANDIDATE_BUDGET', 'candidate inspection budget exhausted')
  let bytes: Uint8Array | undefined
  let value: ReaderResult
  try {
    if (authority.signal.aborted) fail('ARTIFACT_BYTES_MISSING', `artifact ${ref.sha256} could not be read`)
    const request = Object.freeze({ ...authority, nodeSeq: ref.nodeSeq, sha256: ref.sha256 })
    value = await readArtifact(request)
    if (authority.signal.aborted) fail('ARTIFACT_BYTES_MISSING', `artifact ${ref.sha256} could not be read`)
  } catch {
    fail('ARTIFACT_BYTES_MISSING', `artifact ${ref.sha256} could not be read`)
  }
  // Checked before the byte-shape test, which would otherwise report it as missing bytes.
  if (value === REQUEST_MEDIA_ARTIFACT_RECLAIMED) return REQUEST_MEDIA_ARTIFACT_RECLAIMED
  try {
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
    recordVerifiedRequestMediaImage(image, ref.sha256)
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

export type RequestMediaToolCallLookup = (seqs: readonly number[]) => Promise<readonly Event[]>
export type RequestMediaScanTruncation = Readonly<{
  reason: 'surface-nodes' | 'content-blocks'
  scannedNodes: number
  imageNodes: number
}>
type ImageSite = Readonly<{ blockIndex: number; artifactUri: `artifact://${string}`; sha256: string }>
type ImageNode = Readonly<{ node: SurfaceNode; images: readonly ImageSite[] }>

/**
 * Walks the surface from its newest node back, stopping at a node boundary before either ceiling
 * would be exceeded. Every node inside the scanned segment gets the full structural check; older
 * nodes are neither checked nor sent. No ledger or artifact I/O happens here.
 */
function scanNewestSegment(
  surface: readonly SurfaceNode[],
  limits: RequestMediaSurfaceLimits,
  onTruncated: ((info: RequestMediaScanTruncation) => void) | undefined,
): readonly ImageNode[] {
  const found: ImageNode[] = []
  const positions = new Set<string>()
  const identities = new Set<string>()
  const resultSeqs = new Set<number>()
  let nodes = 0
  let blocks = 0
  let truncated: RequestMediaScanTruncation['reason'] | undefined
  for (let index = surface.length - 1; index >= 0; index -= 1) {
    const node = surface[index] as SurfaceNode
    if (nodes >= limits.maxSurfaceNodes) {
      // Only tool results can carry request media; dropping plain messages loses nothing to report.
      if (surface.slice(0, index + 1).some((older) => older.kind === 'tool_result'))
        truncated = 'surface-nodes'
      break
    }
    if (node.kind !== 'tool_result') {
      nodes += 1
      continue
    }
    if (!Number.isSafeInteger(node.seq) || node.seq < 1 || node.event?.type !== 'tool/result')
      fail('SURFACE_INVALID', 'tool-result surface node is invalid')
    if (resultSeqs.has(node.seq)) fail('SURFACE_INVALID', `tool-result ${node.seq} is duplicated`)
    const data = node.event.data
    const content =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).content
        : undefined
    if (!Array.isArray(content)) fail('SURFACE_INVALID', `tool-result ${node.seq} content is invalid`)
    if (blocks + content.length > limits.maxContentBlocks) {
      // The newest tool result is never silently dropped: it alone exceeding the ceiling fails.
      if (resultSeqs.size === 0) fail('SURFACE_LIMIT', 'surface exceeds maxContentBlocks')
      truncated = 'content-blocks'
      break
    }
    nodes += 1
    blocks += content.length
    resultSeqs.add(node.seq)
    const images: ImageSite[] = []
    for (const [blockIndex, value] of content.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('SURFACE_INVALID', `tool-result ${node.seq} block ${blockIndex} is invalid`)
      const block = value as Record<string, unknown>
      if (block.type === 'image') fail('INLINE_IMAGE_UNSUPPORTED', 'inline image has no artifact identity')
      if (block.type !== 'resource_link' || !isImageResource(block)) continue
      const match = typeof block.uri === 'string' ? ARTIFACT_URI.exec(block.uri) : null
      if (!match) fail('INVALID_ARTIFACT_URI', 'image resource URI must contain a lowercase sha256')
      const key = `${node.seq}:${blockIndex}`
      if (positions.has(key)) fail('DUPLICATE_POSITION', `duplicate image position ${key}`)
      positions.add(key)
      const identity = `${node.seq}:${block.uri}`
      if (identities.has(identity))
        fail('DUPLICATE_POSITION', `duplicate image artifact identity ${identity}`)
      identities.add(identity)
      images.push(
        Object.freeze({
          blockIndex,
          artifactUri: block.uri as `artifact://${string}`,
          sha256: match[1] as string,
        }),
      )
    }
    if (images.length > 0) found.push(Object.freeze({ node, images: Object.freeze(images) }))
  }
  if (truncated)
    onTruncated?.(Object.freeze({ reason: truncated, scannedNodes: nodes, imageNodes: found.length }))
  return found
}

/** Resolves provenance only for the window nodes, by point lookups of their source tool/call rows. */
async function windowReferences(
  window: readonly ImageNode[],
  lookupToolCalls: RequestMediaToolCallLookup,
  limits: RequestMediaSurfaceLimits,
): Promise<readonly ImageReference[]> {
  // Snapshot the result rows before the lookup await so a later drift is detected, not trusted.
  const results = window.map(({ node }) => structuredClone(node.event))
  const seqs = [...new Set(results.flatMap((event) => event.sourceEventSeqs ?? []))].sort((a, b) => a - b)
  const requested = new Set(seqs)
  if (seqs.length + results.length > limits.maxLedgerEvents)
    fail('SURFACE_LIMIT', 'window ledger rows exceed maxLedgerEvents')
  const rows = seqs.length === 0 ? [] : await lookupToolCalls(Object.freeze(seqs))
  if (!Array.isArray(rows)) fail('SURFACE_INVALID', 'tool/call lookup returned an invalid result')
  const calls = rows.filter(
    (row: Event) => !!row && typeof row === 'object' && row.type === 'tool/call' && requested.has(row.seq),
  )
  const ledger = snapshotLedger([...calls, ...results], limits)
  const out: ImageReference[] = []
  for (const { node, images } of window) {
    const ledgerEvent = ledger.bySeq.get(node.seq)
    if (ledgerEvent?.type !== 'tool/result' || canonicalJson(ledgerEvent) !== canonicalJson(node.event))
      fail('SURFACE_INVALID', `surface tool-result ${node.seq} is not the immutable ledger row`)
    const sourceTool = toolFromLedger(ledgerEvent, ledger)
    const sourceEventDigest = sha256Hex(canonicalJson(ledgerEvent))
    for (const image of images)
      out.push(Object.freeze({ nodeSeq: node.seq, ...image, sourceTool, sourceEventDigest }))
  }
  out.sort((a, b) => a.nodeSeq - b.nodeSeq || a.blockIndex - b.blockIndex)
  return Object.freeze(out)
}

type WindowCandidateInput = Readonly<{
  surface: readonly SurfaceNode[]
  lookupToolCalls: RequestMediaToolCallLookup
  onScanTruncated?: (info: RequestMediaScanTruncation) => void
  readArtifact: RequestMediaArtifactReader
  surfaceLimits: RequestMediaSurfaceLimits
  mediaLimits: RequestMediaLimits
  sessionKey: string
  lane: string
  signal: AbortSignal
}>

/**
 * First-send candidates: only the images of the newest image-bearing tool-result nodes (the node
 * window) are looked up, read, verified and returned. Older candidates are neither read nor listed.
 */
async function windowCandidates(input: WindowCandidateInput): Promise<readonly RequestMediaCandidate[]> {
  const readArtifact = input.readArtifact
  if (typeof readArtifact !== 'function') fail('ARTIFACT_BYTES_MISSING', 'artifact reader is unavailable')
  const lookupToolCalls = input.lookupToolCalls
  if (typeof lookupToolCalls !== 'function') throw new TypeError('tool/call lookup is unavailable')
  const scan = surfaceLimits(input.surfaceLimits)
  const media = mediaLimits(input.mediaLimits)
  const authority = snapshotReadAuthority(input.sessionKey, input.lane, input.signal)
  const found = scanNewestSegment([...input.surface], scan, input.onScanTruncated)
  const newestFirst = [...found].sort((a, b) => b.node.seq - a.node.seq)
  const maxEntries = Math.min(scan.maxManifestEntries, media.maxManifestEntries)
  const used = { bytes: 0, pixels: 0 }
  const out: RequestMediaCandidate[] = []
  const imagesIn = (nodes: typeof newestFirst) =>
    nodes.reduce((total, { images }) => total + images.length, 0)
  let batch = newestFirst.slice(0, REQUEST_MEDIA_NODE_WINDOW)
  // A manifest limit below the window's image count keeps the newest whole nodes that fit.
  while (batch.length > 1 && imagesIn(batch) > maxEntries) batch = batch.slice(0, -1)
  let next = batch.length
  let extensions = 0
  // A window node whose images were all reclaimed is replaced by the next older image node, for a
  // bounded number of nodes; K counts the surviving images plus the ones about to be read. An
  // extension that would not fit ends the extension: reclamation only ever shrinks the request.
  while (batch.length > 0) {
    if (out.length + imagesIn(batch) > maxEntries) {
      if (extensions > 0) break
      fail('MANIFEST_LIMIT', 'window image candidates exceed maxManifestEntries')
    }
    const references = await windowReferences(batch, lookupToolCalls, scan)
    for (const ref of references) {
      const image = await readDecoded(ref, readArtifact, authority, media, scan, used)
      if (image === REQUEST_MEDIA_ARTIFACT_RECLAIMED) continue
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
    const emptied = batch.filter(
      ({ node }) => !out.some((candidate) => candidate.nodeSeq === node.seq),
    ).length
    const take = Math.min(emptied, RECLAIMED_EXTENSION_NODES - extensions)
    batch = newestFirst.slice(next, next + take)
    next += batch.length
    extensions += batch.length
  }
  return Object.freeze(out)
}

/** Window candidates handed out of Core carry no single-decode reuse: callers may mutate bytes. */
export async function requestMediaCandidatesFromSurface(
  input: WindowCandidateInput,
): Promise<readonly RequestMediaCandidate[]> {
  const candidates = await windowCandidates(input)
  for (const candidate of candidates) forgetVerifiedRequestMediaImage(candidate.bytes)
  return candidates
}

/** First-send composition: selection and wire authority share one immutable ledger snapshot. */
export async function prepareRequestMediaFromSurface(
  input: WindowCandidateInput &
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
  const candidates = await windowCandidates({
    surface: input.surface,
    lookupToolCalls: input.lookupToolCalls,
    ...(input.onScanTruncated ? { onScanTruncated: input.onScanTruncated } : {}),
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

function snapshotHeader(header: RequestMediaHeader, maxEntries: number): RequestMediaHeader {
  if (!Array.isArray(header.manifest) || header.manifest.length > maxEntries)
    fail('MANIFEST_LIMIT', 'persisted manifest exceeds maxManifestEntries')
  const checked = validateRequestMedia(header)
  if (!checked.ok) fail('RESTORE_SOURCE_DRIFT', 'persisted media header is invalid')
  const media = checked.value.media
  const snapshot: RequestMediaHeader = {
    version: 1,
    route: media.route,
    selectionOrder: [...media.selectionOrder],
    manifest: media.manifest.map((entry) => ({ ...entry })),
  }
  for (const entry of snapshot.manifest) Object.freeze(entry)
  Object.freeze(snapshot.selectionOrder)
  Object.freeze(snapshot.manifest)
  return Object.freeze(snapshot)
}

/** Restore only from immutable ledger events; current model surface is deliberately not accepted. */
export async function restoreRequestMediaFromLedger(
  input: Readonly<{
    header: RequestMediaHeader
    ledgerEvents: readonly Event[]
    readArtifact: RequestMediaArtifactReader
    surfaceLimits: RequestMediaSurfaceLimits
    mediaLimits: RequestMediaLimits
    sessionKey: string
    lane: string
    signal: AbortSignal
  }>,
): Promise<LedgerPreparedRequestMedia> {
  const sessionKey = input.sessionKey
  if (typeof sessionKey !== 'string' || sessionKey.length < 1)
    throw new TypeError('ledger media session key is invalid')
  const readArtifact = input.readArtifact
  if (typeof readArtifact !== 'function') fail('ARTIFACT_BYTES_MISSING', 'artifact reader is unavailable')
  const scan = surfaceLimits(input.surfaceLimits)
  const media = mediaLimits(input.mediaLimits)
  const authority = snapshotReadAuthority(sessionKey, input.lane, input.signal)
  const ledger = snapshotLedger([...input.ledgerEvents], scan)
  const maxManifestEntries = Math.min(scan.maxManifestEntries, media.maxManifestEntries)
  const header = snapshotHeader(input.header, maxManifestEntries)
  const selectedNodeSeqs = new Set(
    header.selectionOrder.flatMap((index) => {
      const entry = header.manifest[index]
      return entry ? [entry.nodeSeq] : []
    }),
  )
  const ledgerNodes = [...selectedNodeSeqs].flatMap((seq): SurfaceNode[] => {
    const event = ledger.bySeq.get(seq)
    return event?.type === 'tool/result'
      ? [{ seq: event.seq, kind: 'tool_result', event, pinned: false }]
      : []
  })
  const references = snapshotReferences(ledgerNodes, { ...scan, maxManifestEntries }, ledger)
  const used = { bytes: 0, pixels: 0 }
  const sources = []
  for (const manifestIndex of header.selectionOrder) {
    const entry = header.manifest[manifestIndex]
    if (!entry) fail('RESTORE_SOURCE_DRIFT', `persisted selection ${manifestIndex} is missing`)
    if (entry.elementMapDigest !== undefined)
      fail('RESTORE_SOURCE_DRIFT', 'element-map provenance is unavailable on immutable ledger rows')
    const matches = references.filter(
      (ref) => ref.nodeSeq === entry.nodeSeq && ref.artifactUri === entry.artifactUri,
    )
    if (matches.length !== 1)
      fail('RESTORE_SOURCE_DRIFT', `persisted selection ${manifestIndex} has no unique ledger image`)
    const ref = matches[0] as ImageReference
    const image = await readDecoded(ref, readArtifact, authority, media, scan, used)
    if (image === REQUEST_MEDIA_ARTIFACT_RECLAIMED)
      fail('ARTIFACT_RECLAIMED', `persisted selection ${manifestIndex} was reclaimed by retention`)
    if (image.mime !== entry.mime || image.width !== entry.width || image.height !== entry.height)
      fail('RESTORE_SOURCE_DRIFT', `artifact ${manifestIndex} metadata differs from manifest`)
    sources.push({
      manifestIndex,
      blockIndex: ref.blockIndex,
      bytes: image.bytes,
      sourceTool: ref.sourceTool,
      sourceEventDigest: ref.sourceEventDigest,
    })
  }
  return attestLedgerPreparedRequestMedia(restoreRequestMedia({ header, sources, limits: media }), sessionKey)
}
