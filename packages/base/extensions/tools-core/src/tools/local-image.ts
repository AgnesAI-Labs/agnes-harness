import { createRequire } from 'node:module'
import type { ToolContext, ToolResult } from '@agnes/extension-api'

type Sharp = typeof import('sharp')
let loadedCodec: Sharp | undefined

/**
 * The native codec stays beside the shipped runtime instead of being inlined into a JS bundle, and
 * is loaded on the first image read rather than with this module: on a machine where it cannot load
 * (another C library or architecture, an install without optional dependencies), only image reads
 * fail, as errors; the tools, and so every session, still start. A failed load is tried again on
 * the next read.
 */
function codec(): Sharp | undefined {
  if (loadedCodec) return loadedCodec
  try {
    const sharp: Sharp = createRequire(import.meta.url)('sharp')
    // Every read is a different file, so the codec's operation cache would only hold decoded pixels
    // of images nobody asks for again: hundreds of MiB after one large original.
    sharp.cache(false)
    loadedCodec = sharp
  } catch {
    // Not cached: a later read tries again.
  }
  return loadedCodec
}

/** Largest workspace image read whole. Camera originals are often several MiB. */
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024
/** Decoder ceiling; a larger original is refused from its header, before its pixels are allocated. */
export const MAX_IMAGE_INPUT_PIXELS = 64_000_000
/** Most memory the pixels of one original may need once decoded: 64 MP of 8-bit RGBA. */
export const MAX_DECODED_BYTES = 256 * 1024 * 1024
/** Interlaced PNG and progressive JPEG are decoded whole rather than streamed, so they get less. */
export const MAX_PROGRESSIVE_PIXELS = 16_000_000
/** ...and at most this many bytes of decoded pixels, since a whole-image decode needs about twice that. */
export const MAX_PROGRESSIVE_DECODED_BYTES = 64 * 1024 * 1024
/** Decodes that run at once in this process, whichever sessions ask for them. */
export const MAX_CONCURRENT_DECODES = 2
/** Wall-clock budget for decoding, scaling and re-encoding one image, retries included. */
export const IMAGE_PREPARE_TIMEOUT_MS = 30_000
// Each retry shrinks both edges to 70%, so the last is about 8% of the first.
const MAX_ENCODE_ATTEMPTS = 8
// The kernel's image port refuses either edge below this.
const MIN_EDGE = 8

const text = (message: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: message }],
  ...(isError ? { isError } : {}),
})

const SAMPLE_BYTES: Readonly<Record<string, number>> = { uchar: 1, char: 1, ushort: 2, short: 2 }
const IMAGE_NAME = /\.(png|jpe?g)$/i
// A windowed read through the host file system arrives decoded as UTF-8 and re-encoded, every
// invalid byte turned into U+FFFD (EF BF BD). These are how a PNG and a JPEG begin after that.
const MANGLED_PNG = [0xef, 0xbf, 0xbd, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MANGLED_JPEG = [0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd]
const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((byte, index) => bytes[index] === byte)

const tooLarge = (): ToolResult =>
  text(`Workspace images are limited to ${MAX_IMAGE_FILE_BYTES / (1024 * 1024)} MiB.`, true)

export function localImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return undefined
}

// The PNG decoder shows only the default image of an APNG and reports a single page, so the
// animation control chunk, which must precede the first IDAT, is looked for directly. Every step
// advances at least 12 bytes, so the walk is bounded by the file size.
function isAnimatedPng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
  }
  return false
}

class PrepareTimeout extends Error {}

let decoding = 0
const decodeQueue: (() => void)[] = []

/** How many decodes hold a slot and how many wait for one, for tests. */
export const decodeSlots = { active: (): number => decoding, queued: (): number => decodeQueue.length }

function releaseDecodeSlot(): void {
  const next = decodeQueue.shift()
  // The slot passes straight to the next caller in line, so the count stays as it is.
  if (next) next()
  else decoding--
}

/**
 * Settles with `work`, or rejects as soon as the call is cancelled or the deadline passes. The codec
 * may keep its thread after either; its own timeout, taken from the same budget, ends it.
 */
function bounded<T>(work: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  work.catch(() => {})
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    const timer = setTimeout(() => reject(new PrepareTimeout()), Math.max(0, deadline - Date.now()))
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    })
    if (signal.aborted) stop()
  })
}

/**
 * Starts `decode` once one of the process's decode slots is free, in arrival order, and settles
 * like `bounded`. A caller cancelled or out of time while it waits leaves the queue. The slot is
 * held until the codec work itself settles, not until the caller stops waiting for it, so a decode
 * that was abandoned still counts against the limit until its own timeout ends it.
 */
export async function withDecodeSlot<T>(
  signal: AbortSignal,
  deadline: number,
  decode: () => Promise<T>,
): Promise<T> {
  if (decoding < MAX_CONCURRENT_DECODES && decodeQueue.length === 0) decoding++
  else
    await new Promise<void>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
      }
      const grant = () => {
        settle()
        resolve()
      }
      const leave = (reason: unknown) => {
        settle()
        decodeQueue.splice(decodeQueue.indexOf(grant), 1)
        reject(reason)
      }
      const cancel = () => leave(signal.reason)
      const timer = setTimeout(() => leave(new PrepareTimeout()), Math.max(0, deadline - Date.now()))
      decodeQueue.push(grant)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
  let work: Promise<T>
  try {
    signal.throwIfAborted()
    work = decode()
  } catch (error) {
    releaseDecodeSlot()
    throw error
  }
  work.then(releaseDecodeSlot, releaseDecodeSlot)
  return bounded(work, signal, deadline)
}

/**
 * The image branch of `read`, taken only for a file the text path has already refused as binary,
 * so a file that reads as text never reaches it. `undefined` means "not a workspace image": the
 * caller keeps its binary-file answer. `first` is what that text path's read returned; a file
 * whose first bytes are no image signature, raw or as the host decodes it, and whose name is no
 * image name, is not read again.
 *
 * The text path's read is windowed, and the host file system answers a windowed read with the
 * bytes decoded as text and re-encoded, which mangles any binary format. The pixels therefore come
 * from a second, unwindowed read through the same workspace-confined port. It is made only for a
 * regular file within the size ceiling, or for a link the port resolves and confines on the read
 * itself: a FIFO or a device is never opened a second time, since it can block or never end.
 */
export async function readWorkspaceImage(
  path: string,
  first: Uint8Array,
  ctx: ToolContext,
  maxEdge?: number,
): Promise<ToolResult | undefined> {
  const named = IMAGE_NAME.test(path)
  if (!named && !localImageMime(first) && !startsWith(first, MANGLED_PNG) && !startsWith(first, MANGLED_JPEG))
    return undefined
  let stat: Awaited<ReturnType<ToolContext['fs']['stat']>>
  try {
    stat = await ctx.fs.stat(path)
  } catch {
    return undefined
  }
  if (stat.kind !== 'file' && stat.kind !== 'symlink') return undefined
  // Too large to read whole only to look at its first bytes; the name says whether it is meant as an image.
  if (stat.kind === 'file' && stat.size > MAX_IMAGE_FILE_BYTES)
    return named || localImageMime(first) ? tooLarge() : undefined
  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.read(path)
  } catch (e) {
    return { content: [{ type: 'text', text: `read failed: ${(e as Error).message}` }], isError: true }
  }
  if (!localImageMime(bytes)) return undefined
  return readLocalImage(bytes, path, ctx, maxEdge)
}

/**
 * Downscales one workspace PNG/JPEG to the active model limits, and to `maxEdge`, which can only
 * lower them, then hands it to the kernel as an artifact-backed image: one image per call. The
 * bytes have already crossed the workspace-confined fs port; nothing here opens a file by name.
 * What reaches the model carries no EXIF (location included), ICC or other metadata.
 */
export async function readLocalImage(
  bytes: Uint8Array,
  name: string,
  ctx: ToolContext,
  maxEdge?: number,
  timeoutMs: number = IMAGE_PREPARE_TIMEOUT_MS,
): Promise<ToolResult> {
  const policy = await ctx.session.imageInputPolicy?.()
  if (!policy?.supported || !ctx.session.imageInput)
    return text(
      'The selected model does not support image input. Image pixels were not inspected; select a vision-capable model to read them.',
    )
  const deadline = Date.now() + timeoutMs
  // The codec's own stop, from what is left of the budget, ends work the caller stopped waiting for.
  const stopAfter = () => ({ seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) })
  try {
    ctx.signal.throwIfAborted()
    if (bytes.length > MAX_IMAGE_FILE_BYTES) return tooLarge()
    const mimeType = localImageMime(bytes)
    if (!mimeType) return text('Only PNG and JPEG images are supported.', true)
    if (mimeType === 'image/png' && isAnimatedPng(bytes))
      return text('The image is animated; only single-frame PNG and JPEG are supported.', true)
    const sharp = codec()
    if (!sharp)
      return text(
        'Image read failed: the image library could not be loaded on this machine. Image pixels were not inspected.',
        true,
      )
    // 'error' rather than 'warning': camera JPEGs often carry harmless warnings such as a short tail.
    // The pixel ceiling is checked against the header before anything is decoded, and the default
    // sequential read streams rows through the resize rather than holding the whole original.
    const decoder = sharp(bytes, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS, failOn: 'error' })
    const metadata = await bounded(decoder.metadata(), ctx.signal, deadline)
    if (
      metadata.format !== (mimeType === 'image/png' ? 'png' : 'jpeg') ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1
    )
      return text('The image is invalid or animated; only single-frame PNG and JPEG are supported.', true)
    // Checked from the header, before any pixel is decoded: what the decoded original weighs, and
    // whether it is decoded whole (Adam7 PNG, progressive JPEG) instead of streamed row by row.
    const pixels = metadata.width * metadata.height
    const decoded = pixels * (metadata.channels ?? 4) * (SAMPLE_BYTES[metadata.depth ?? ''] ?? 8)
    const whole = metadata.isProgressive === true
    if (
      decoded > MAX_DECODED_BYTES ||
      (whole && (pixels > MAX_PROGRESSIVE_PIXELS || decoded > MAX_PROGRESSIVE_DECODED_BYTES))
    )
      return text(
        `The image needs too much memory to decode: ${Math.ceil(decoded / (1024 * 1024))} MiB of pixels${whole ? ', interlaced or progressive' : ''}. Limits: ${MAX_DECODED_BYTES / (1024 * 1024)} MiB; when interlaced or progressive, ${MAX_PROGRESSIVE_PIXELS / 1_000_000} megapixels and ${MAX_PROGRESSIVE_DECODED_BYTES / (1024 * 1024)} MiB.`,
        true,
      )
    // EXIF orientations 5-8 swap the axes once rotate() has applied them.
    const [w, h] =
      (metadata.orientation ?? 1) >= 5 ? [metadata.height, metadata.width] : [metadata.width, metadata.height]
    const edge = maxEdge ?? Number.POSITIVE_INFINITY
    const scale = Math.min(
      1,
      Math.min(policy.maxWidth, edge) / w,
      Math.min(policy.maxHeight, edge) / h,
      Math.sqrt(policy.maxPixels / (w * h)),
    )
    // The epsilon keeps 2169 * (1456 / 2169) at 1456 rather than 1455.
    let width = Math.max(1, Math.floor(w * scale + 1e-9))
    let height = Math.max(1, Math.floor(h * scale + 1e-9))
    // Decoded, oriented and scaled once, within the model's pixel limit, to the codec's default
    // output of 8-bit sRGB (CMYK and 16-bit originals included); a retry for the byte limit only
    // rescales these pixels.
    const scaled = await withDecodeSlot(ctx.signal, deadline, () =>
      decoder
        .clone()
        .timeout(stopAfter())
        .rotate()
        .resize({ width, height, fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true }),
    )
    const raw = { width: scaled.info.width, height: scaled.info.height, channels: scaled.info.channels }
    for (
      let attempt = 0;
      attempt < MAX_ENCODE_ATTEMPTS && width >= MIN_EDGE && height >= MIN_EDGE;
      attempt++
    ) {
      const resized = sharp(scaled.data, { raw }).timeout(stopAfter()).resize({ width, height, fit: 'fill' })
      const encoded = mimeType === 'image/png' ? resized.png() : resized.jpeg({ quality: 85 })
      const output = await bounded(encoded.toBuffer(), ctx.signal, deadline)
      ctx.signal.throwIfAborted()
      if (output.length <= policy.maxBytes) return ctx.session.imageInput({ bytes: output, mimeType, name })
      width = Math.floor(width * 0.7)
      height = Math.floor(height * 0.7)
    }
    return text('The image cannot fit the active model image limits.', true)
  } catch (error) {
    ctx.signal.throwIfAborted()
    // The codec words its own stop as "timeout: <n>% complete".
    if (
      error instanceof PrepareTimeout ||
      (error instanceof Error && /^timeout: \d+% complete/.test(error.message))
    )
      return text(`Image read timed out after ${Math.ceil(timeoutMs / 1000)} s.`, true)
    return text(`Image read failed: ${error instanceof Error ? error.message : 'invalid image'}`, true)
  }
}
