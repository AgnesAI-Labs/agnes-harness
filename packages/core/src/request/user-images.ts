import {
  attachmentForm,
  type ModelRecord,
  modelImageInputError,
  USER_MESSAGE_IMAGE_LIMITS,
} from '@agnes/protocol'
import { base64DecodedBytes } from '../log/lean.js'
import type { SurfaceNode } from '../project/surface.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'
import { attachmentBytes, attachmentFailure, attachmentFailureCode } from './attachment-bytes.js'
import type { AttachmentEntry } from './attachment-index.js'
import { sanitize } from './derive.js'
import { type RequestImageTransform, requestImageTransform } from './request-version.js'

export type UserImageCandidate = Readonly<{
  /** `${seq}/${index}`: the image's place, as `session-image://<seq>/<index>` names it. */
  key: string
  seq: number
  index: number
  fresh: boolean
  bytes: number
  pixels: number
}>
export type UserImageBudget = Readonly<{ count: number; bytes: number; pixels: number; perMessage: number }>
export const USER_IMAGE_STEPS = Object.freeze({ bytes: 4 * 1024 * 1024, pixels: 2_000_000 })
export const USER_IMAGE_BUDGET = Object.freeze({
  bytes: 16 * 1024 * 1024,
  pixels: 8_000_000,
  defaultCount: 8,
})
const UNKNOWN_IMAGE_TOKENS = 1_600

const tooMany = () =>
  new CoreError(
    'E_ENVELOPE',
    'The current images exceed the selected model request limit. Use fewer or smaller images, or a model with a higher limit.',
  )
const roundUp = (excess: number, step: number) => (excess <= 0 ? 0 : Math.ceil(excess / step) * step)

/**
 * History images are dropped oldest first in whole steps, so the dropped prefix only changes when the
 * history grows by another step and the bytes already sent stay the same from one request to the next.
 * Images of the turn being answered are never dropped.
 */
export function selectUserImages(
  candidates: readonly UserImageCandidate[],
  budget: UserImageBudget,
): { included: ReadonlySet<string>; omitted: readonly string[] } {
  const omitted: string[] = []
  const bySeq = new Map<number, UserImageCandidate[]>()
  for (const c of candidates) {
    const group = bySeq.get(c.seq)
    if (group) group.push(c)
    else bySeq.set(c.seq, [c])
  }
  const capped = new Set<string>()
  for (const group of bySeq.values()) {
    const over = group.length - budget.perMessage
    for (const c of group.slice(0, Math.max(0, over))) {
      if (c.fresh) throw tooMany()
      capped.add(c.key)
      omitted.push(c.key)
    }
  }
  const pool = candidates.filter((c) => !capped.has(c.key))
  const total = pool.reduce(
    (t, c) => ({ count: t.count + 1, bytes: t.bytes + c.bytes, pixels: t.pixels + c.pixels }),
    { count: 0, bytes: 0, pixels: 0 },
  )
  const excess = {
    count: total.count - budget.count,
    bytes: total.bytes - budget.bytes,
    pixels: total.pixels - budget.pixels,
  }
  const stepCount = Math.max(1, Math.ceil(budget.count / 2))
  const target = {
    count: roundUp(excess.count, stepCount),
    bytes: roundUp(excess.bytes, USER_IMAGE_STEPS.bytes),
    pixels: roundUp(excess.pixels, USER_IMAGE_STEPS.pixels),
  }
  const removed = { count: 0, bytes: 0, pixels: 0 }
  const met = (goal: typeof target) =>
    removed.count >= goal.count && removed.bytes >= goal.bytes && removed.pixels >= goal.pixels
  for (const c of pool) {
    if (met(target)) break
    if (c.fresh) break
    omitted.push(c.key)
    removed.count++
    removed.bytes += c.bytes
    removed.pixels += c.pixels
  }
  if (
    !met({
      count: Math.max(0, excess.count),
      bytes: Math.max(0, excess.bytes),
      pixels: Math.max(0, excess.pixels),
    })
  )
    throw tooMany()
  const gone = new Set(omitted)
  return { included: new Set(pool.filter((c) => !gone.has(c.key)).map((c) => c.key)), omitted }
}

/** An image's share of the token estimate: its area over 750, or a flat 1,600 when its size is not recorded. */
export function estimateImageTokens(block: { width?: number; height?: number }): number {
  return block.width && block.height ? Math.ceil((block.width * block.height) / 750) : UNKNOWN_IMAGE_TOKENS
}

export type PreparedUserImages = Readonly<{
  mode: 'select' | 'none'
  canRead: boolean
  /** The bytes of each selected image, by key, as base64. */
  blocks: ReadonlyMap<string, { data: string; mimeType: string }>
  header: { included: string[]; omitted: number; missing: string[] }
  fresh: ReadonlySet<string>
  /** The route's request byte limit, which the request is held to once the bytes are in. */
  maxRequestBytes?: number
}>

export const NO_USER_IMAGES: PreparedUserImages = Object.freeze({
  mode: 'none',
  canRead: false,
  blocks: new Map(),
  header: { included: [], omitted: 0, missing: [] },
  fresh: new Set<string>(),
})

type ImageSession = Pick<SessionImpl, 'key' | 'd' | 'lane' | 'attachmentIndex'>
type Located = UserImageCandidate & { block: Record<string, unknown>; sized: boolean }
type Image = { data: string; mimeType: string }

/**
 * Width and height from an image's header: PNG's IHDR, or a JPEG's first frame header. Only the
 * header is read, nothing is decoded. Undefined when the bytes do not say.
 */
function imageHeaderSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const at = (i: number) => bytes[i] ?? 0
  const u16 = (i: number) => (at(i) << 8) | at(i + 1)
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined)
  if (bytes.length >= 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return size(u16(16) * 65536 + u16(18), u16(20) * 65536 + u16(22))
  if (at(0) !== 0xff || at(1) !== 0xd8) return undefined
  let i = 2
  while (i + 9 < bytes.length) {
    if (at(i) !== 0xff) return undefined
    const marker = at(i + 1)
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += marker === 0xff ? 1 : 2
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return size(u16(i + 7), u16(i + 5))
    i += 2 + u16(i + 2)
  }
  return undefined
}

/**
 * An image block's share of the token estimate: by its recorded size, else by the size in the header
 * of the bytes it holds, else (a large old inline image, whose bytes are not on the surface) 1,600.
 */
export function imageBlockTokens(block: { width?: unknown; height?: unknown; data?: unknown }): number {
  if (typeof block.width === 'number' && typeof block.height === 'number')
    return estimateImageTokens({ width: block.width, height: block.height })
  const size = typeof block.data === 'string' ? inlineSize(block as Record<string, unknown>) : undefined
  return estimateImageTokens(size ?? {})
}

/** Base64 characters read for a header: 64 KiB of bytes, room for a JPEG's metadata before its frame header. */
const HEADER_CHARS = 87_384

/** The header size of an inline block's bytes, read once per block (rows never change). */
const inlineSizes = new WeakMap<object, { width: number; height: number } | null>()
function inlineSize(block: Record<string, unknown>): { width: number; height: number } | undefined {
  let known = inlineSizes.get(block)
  if (known === undefined) {
    known = imageHeaderSize(Buffer.from(String(block.data).slice(0, HEADER_CHARS), 'base64')) ?? null
    inlineSizes.set(block, known)
  }
  return known ?? undefined
}

/**
 * Every user image on the surface, oldest first, numbered within its message the way the request
 * numbers them. An image in a user message after the last assistant or summary node belongs to the
 * turn being answered (only a turn has one). Its pixels are the recorded size, or the size in the
 * header of an inline image's bytes; an image whose size is not known counts as the largest allowed.
 */
function locate(surface: readonly SurfaceNode[], kind: 'turn' | 'summary'): Located[] {
  const answered =
    kind === 'turn' ? surface.findLastIndex((n) => n.kind === 'assistant' || n.kind === 'summary') : Infinity
  const out: Located[] = []
  surface.forEach((node, at) => {
    if (node.kind !== 'user') return
    const content = (node.event.data as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) return
    let index = 0
    for (const raw of content) {
      if (!raw || typeof raw !== 'object' || (raw as { type?: unknown }).type !== 'image') continue
      index++
      const block = raw as Record<string, unknown>
      const form = attachmentForm(block)
      if (!form) continue
      const bytes =
        form === 'reference'
          ? (block.attachment as { bytes?: unknown }).bytes
          : form === 'omitted'
            ? (block.dataOmitted as { bytes?: unknown }).bytes
            : base64DecodedBytes(block.data as string)
      // A block whose size is not a byte count is malformed: it keeps its number and its note.
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) continue
      const recorded =
        typeof block.width === 'number' && typeof block.height === 'number'
          ? { width: block.width, height: block.height }
          : form === 'inline'
            ? inlineSize(block)
            : undefined
      out.push({
        key: `${node.seq}/${index}`,
        seq: node.seq,
        index,
        fresh: at > answered,
        bytes,
        pixels: recorded ? recorded.width * recorded.height : USER_MESSAGE_IMAGE_LIMITS.maxPixelsPerImage,
        sized: recorded !== undefined,
        block,
      })
    }
  })
  return out
}

/**
 * The request version a stored image needs for this model, if any: only a route that declares
 * `resize` asks for one, and only for an image larger than it allows.
 */
function versionTarget(model: ModelRecord, entry: AttachmentEntry): RequestImageTransform | undefined {
  const resize = model.inputLimits?.images?.resize
  if (!resize) return undefined
  const maxWidth = Math.min(1456, resize.maxWidth ?? 1456)
  const maxHeight = Math.min(1456, resize.maxHeight ?? 1456)
  const tooWide = (entry.width ?? 0) > maxWidth || (entry.height ?? 0) > maxHeight
  const tooBig = resize.maxBytes !== undefined && Math.ceil(entry.bytes / 3) * 4 > resize.maxBytes
  if (!tooWide && !tooBig) return undefined
  return requestImageTransform({
    maxWidth,
    maxHeight,
    maxPixels: USER_MESSAGE_IMAGE_LIMITS.maxPixelsPerImage,
    maxBytes:
      resize.maxBytes === undefined
        ? USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage
        : Math.floor(resize.maxBytes / 4) * 3,
  })
}

const resizeRequired = () =>
  Object.assign(new Error('This image needs a smaller request version.'), { code: 'IMAGE_RESIZE_REQUIRED' })
const toBase64 = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')

/** The bytes one selected image is sent with, by the form its row holds. */
async function imageData(
  s: ImageSession,
  c: Located,
  model: ModelRecord,
  signal: AbortSignal,
): Promise<{ data: string; mimeType: string }> {
  // A small inline block still holds its bytes on the surface. They are scrubbed like every other
  // string a request carries; base64 holds none of the characters the scrub takes.
  if (typeof c.block.data === 'string')
    return { data: sanitize(c.block.data), mimeType: sanitize(String(c.block.mimeType)) }
  const entry = s.attachmentIndex.get(c.seq, 'image', c.index)
  if (!entry || entry.lane !== s.lane)
    throw attachmentFailure('ATTACHMENT_MISSING', 'The image is not in this session.')
  const target = entry.form === 'reference' ? versionTarget(model, entry) : undefined
  if (target && entry.sha256 !== undefined) {
    const versions = s.d.requestVersions
    if (!versions) throw resizeRequired()
    // The version is made from the stored object directly, so the object must be one this runtime
    // serves as a user attachment, exactly as a read of it would require.
    const port = s.d.attachments
    if (!port || !(await port.isUserAttachment(entry.sha256)))
      throw attachmentFailure('ATTACHMENT_MISSING', 'The stored image is missing from the attachment store.')
    const version = await versions(
      { sha256: entry.sha256, bytes: entry.bytes, mimeType: entry.mimeType },
      target,
      signal,
    )
    return { data: toBase64(version.bytes), mimeType: version.mimeType }
  }
  return { data: toBase64(await attachmentBytes(s, entry, signal)), mimeType: entry.mimeType }
}

const codeOf = (error: unknown): unknown =>
  attachmentFailureCode(error) ?? (error as { code?: unknown } | null)?.code

/**
 * Chooses which user images this request carries and reads their bytes. The choice is made on
 * recorded metadata (see `selectUserImages`), and only the chosen images are read, each by the form
 * its row holds. The one exception is an image of this turn whose size nothing records (a large old
 * inline image): it is read first, since it is sent anyway, so its real size counts.
 *
 * A history image whose bytes are gone, or that this model cannot take, becomes the omitted-image
 * note; an image of the turn being answered never does, and fails the request instead. Damaged
 * bytes fail the request whatever image they belong to.
 */
export async function prepareUserImages(
  s: ImageSession,
  input: {
    surface: readonly SurfaceNode[]
    kind: 'turn' | 'summary'
    model: ModelRecord | undefined
    mediaCount: number
    textBytes: number
    canRead: boolean
    signal: AbortSignal
  },
): Promise<PreparedUserImages> {
  // A summary is written from the conversation's text; the images stay notes it can name.
  if (input.kind === 'summary') return NO_USER_IMAGES
  const located = locate(input.surface, input.kind)
  const fresh = new Set(located.filter((c) => c.fresh).map((c) => c.key))
  const model = input.model
  const header: PreparedUserImages['header'] = { included: [], omitted: 0, missing: [] }
  const blocks = new Map<string, Image>()
  const maxRequestBytes = model?.inputLimits?.maxRequestBytes
  const prepared = {
    mode: 'select' as const,
    canRead: input.canRead,
    blocks,
    header,
    fresh,
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
  }
  if (!model?.input.includes('image')) {
    if (fresh.size)
      throw new CoreError(
        'E_ENVELOPE',
        'The current images exceed the selected model request limit. Use fewer images or a model with a higher limit.',
      )
    header.omitted = located.length
    return prepared
  }
  /** The bytes one image is sent with, or undefined when it is left out (the header says why). */
  const fetch = async (c: Located): Promise<Image | undefined> => {
    const unfit = (message: string) => {
      if (c.fresh) throw new CoreError('E_ENVELOPE', message)
      header.omitted++
      return undefined
    }
    let image: Image
    try {
      image = await imageData(s, c, model, input.signal)
    } catch (error) {
      if (input.signal.aborted) throw error
      const code = codeOf(error)
      if (code === 'ATTACHMENT_MISSING') {
        if (c.fresh)
          throw new CoreError(
            'E_ENVELOPE',
            'An image of this message is missing from the attachment store; the request was not sent.',
            { code: 'ATTACHMENT_MISSING', image: c.key },
          )
        header.missing.push(c.key)
        return undefined
      }
      if (code === 'IMAGE_RESIZE_REQUIRED' || code === 'ATTACHMENT_TOO_LARGE')
        return unfit('An image of this message exceeds the selected model image limits. Use a smaller image.')
      if (
        code === 'ATTACHMENT_CORRUPT' ||
        code === 'ATTACHMENT_HASH_MISMATCH' ||
        code === 'IMAGE_DECODE_FAILED'
      )
        throw new CoreError('E_ENVELOPE', 'A stored attachment is corrupt; the request was not sent.', {
          code: 'ATTACHMENT_CORRUPT',
          image: c.key,
        })
      throw new CoreError('E_ENVELOPE', 'A stored image could not be read; the request was not sent.', {
        code: 'ATTACHMENT_UNREADABLE',
        image: c.key,
      })
    }
    const error = modelImageInputError(model, [{ content: [{ type: 'image', ...image }] }])
    return error ? unfit(error) : image
  }
  const read = new Map<string, Image | undefined>()
  const candidates: UserImageCandidate[] = []
  for (const c of located) {
    if (c.fresh && !c.sized) {
      const image = await fetch(c)
      read.set(c.key, image)
      const size = image && imageHeaderSize(Buffer.from(image.data, 'base64'))
      if (size) {
        candidates.push({ ...c, pixels: size.width * size.height })
        continue
      }
    }
    candidates.push(c)
  }
  const limits = model.inputLimits
  const { included, omitted } = selectUserImages(candidates, {
    count: (limits?.images?.maxPerRequest ?? USER_IMAGE_BUDGET.defaultCount) - input.mediaCount,
    bytes: Math.min(USER_IMAGE_BUDGET.bytes, (limits?.maxRequestBytes ?? Infinity) - input.textBytes),
    pixels: USER_IMAGE_BUDGET.pixels,
    perMessage: limits?.images?.maxPerMessage ?? Infinity,
  })
  header.omitted += omitted.length
  for (const c of located) {
    if (!included.has(c.key)) continue
    const image = read.has(c.key) ? read.get(c.key) : await fetch(c)
    if (!image) continue
    blocks.set(c.key, image)
    header.included.push(c.key)
  }
  return prepared
}
