import { createRequire } from 'node:module'
import type { ToolContext, ToolResult } from '@agnes/extension-api'

// Native codecs remain beside the shipped runtime rather than being inlined into a JS bundle.
const sharp: typeof import('sharp') = createRequire(import.meta.url)('sharp')

export function localImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return undefined
}

/** Bytes have already crossed the workspace-confined fs port; never open a second file by name. */
export async function readLocalImage(bytes: Uint8Array, name: string, ctx: ToolContext): Promise<ToolResult> {
  const text = (message: string, isError = false): ToolResult => ({
    content: [{ type: 'text', text: message }],
    ...(isError ? { isError } : {}),
  })
  const policy = await ctx.session.imageInputPolicy?.()
  if (!policy?.supported || !ctx.session.imageInput)
    return text(
      'The selected model does not support image input. Image pixels were not inspected; select a vision-capable model to read them.',
    )
  try {
    ctx.signal.throwIfAborted()
    if (bytes.length > 4 * 1024 * 1024) return text('Workspace images are limited to 4 MiB.', true)
    const mimeType = localImageMime(bytes)
    if (!mimeType) return text('Only PNG and JPEG images are supported.', true)
    const decoder = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' })
    const metadata = await decoder.metadata()
    if (
      metadata.format !== (mimeType === 'image/png' ? 'png' : 'jpeg') ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1
    )
      return text('The image is invalid or animated; only single-frame PNG and JPEG are supported.', true)
    const scale = Math.min(
      1,
      policy.maxWidth / metadata.width,
      policy.maxHeight / metadata.height,
      Math.sqrt(policy.maxPixels / (metadata.width * metadata.height)),
    )
    let width = Math.floor(metadata.width * scale)
    let height = Math.floor(metadata.height * scale)
    // Bounded retries also shrink incompressible PNGs to the active byte limit.
    for (let attempt = 0; attempt < 8 && width >= 8 && height >= 8; attempt++) {
      ctx.signal.throwIfAborted()
      const resized = decoder
        .clone()
        .rotate()
        .resize({ width, height, fit: 'inside', withoutEnlargement: true })
      const output = await (mimeType === 'image/png'
        ? resized.png()
        : resized.jpeg({ quality: 85 })
      ).toBuffer()
      ctx.signal.throwIfAborted()
      if (output.length <= policy.maxBytes) return ctx.session.imageInput({ bytes: output, mimeType, name })
      width = Math.floor(width * 0.7)
      height = Math.floor(height * 0.7)
    }
    return text('The image cannot fit the active model image limits.', true)
  } catch (error) {
    ctx.signal.throwIfAborted()
    return text(`Image read failed: ${error instanceof Error ? error.message : 'invalid image'}`, true)
  }
}
