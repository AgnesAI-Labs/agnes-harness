import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

type Codec = typeof import('sharp')
const MAX_PIXELS = 1024 * 1024
const checked = new Map<string, Promise<void>>()
let loaded: Codec | undefined

// Loaded on first use, never by a static import. sharp is a native package that ships beside the
// bundles in node_modules rather than inside them: bundled statically, a single-executable build
// fails as soon as this module is evaluated, because the injected script's require only knows Node
// builtins, and that took daemon start down with it. A require created from this module resolves
// node_modules beside the executable in that build, beside dist/local in a local build and in the
// workspace in development. Only an application with image assets needs the codec at all.
function codec(): Codec {
  if (loaded) return loaded
  try {
    loaded = createRequire(import.meta.url)('sharp') as Codec
    return loaded
  } catch {
    // Fails closed with its own code: an asset that could not be decoded is not the same report as
    // a runtime that cannot decode any image.
    throw new Error('application-asset-codec-unavailable')
  }
}

/** Decode all frames, with bounded input, pixels, output and codec time. Never just trust magic bytes. */
export async function validateApplicationImage(bytes: Buffer, mime: string): Promise<void> {
  const key = createHash('sha256').update(mime).update(bytes).digest('hex')
  const cached = checked.get(key)
  if (cached) return cached
  const sharp = codec()
  const decode = async (data: Buffer) => {
    const image = sharp(data, { failOn: 'warning', limitInputPixels: MAX_PIXELS, animated: true }).timeout({
      seconds: 2,
    })
    const metadata = await image.metadata()
    if (
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) > 32 ||
      metadata.width * (metadata.pageHeight ?? metadata.height) * (metadata.pages ?? 1) > MAX_PIXELS
    )
      throw new Error('application-asset-pixels')
    await image.ensureAlpha().raw().toBuffer()
  }
  const validation = (async () => {
    if (mime !== 'image/x-icon') return decode(bytes)
    // ICO is a container. Validate every PNG frame; unsupported legacy DIB frames fail closed.
    if (bytes.length < 6) throw new Error('application-asset-icon')
    const count = bytes.readUInt16LE(4)
    if (!count || count > 32 || bytes.length < 6 + count * 16) throw new Error('application-asset-icon')
    let pixels = 0
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16
      const width = bytes[entry] || 256,
        height = bytes[entry + 1] || 256
      pixels += width * height
      const size = bytes.readUInt32LE(entry + 8),
        offset = bytes.readUInt32LE(entry + 12)
      if (pixels > MAX_PIXELS || offset < 6 + count * 16 || !size || offset + size > bytes.length)
        throw new Error('application-asset-icon')
      const frame = bytes.subarray(offset, offset + size)
      if (!frame.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error('application-asset-icon-encoding')
      const metadata = await sharp(frame).metadata()
      if (metadata.width !== width || metadata.height !== height) throw new Error('application-asset-icon')
      await decode(frame)
    }
  })()
  if (checked.size >= 64) checked.delete(checked.keys().next().value ?? '')
  checked.set(key, validation)
  try {
    await validation
  } catch {
    checked.delete(key)
    throw new Error('application-asset-decode')
  }
}
