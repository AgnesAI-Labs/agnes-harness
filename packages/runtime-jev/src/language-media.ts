import type { ArtifactPort, ArtifactRef } from '@agnes/jev-runtime'
import type { Provider, RequestMessage } from '@agnes/protocol'

export const DEFAULT_IMAGE_REQUEST_BYTES = 64 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export class LanguageMediaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'LanguageMediaError'
  }
}

/** Match the exact declared route/model; no capability inference or provider-specific names. */
export function assertImageModel(provider: Provider, selection: { route: string; model: string }): void {
  const matches = provider
    .models()
    .filter((model) => model.route === selection.route && model.id === selection.model)
  if (matches.length !== 1 || !matches[0]?.input?.includes('image'))
    throw new LanguageMediaError(
      'LANGUAGE_IMAGE_MODEL_UNSUPPORTED',
      'The selected language model does not uniquely declare image input; choose an image-capable route',
    )
}

/** Only projected settled-tool references cross this boundary; no path or URL is accepted. */
export async function materializeToolImages(
  messages: RequestMessage[],
  images: readonly { messageIndex: number; contentIndex: number; artifact: ArtifactRef }[],
  artifacts: Pick<ArtifactPort, 'read'> | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Image request byte limit must be a positive integer')
  let total = 0
  for (const { artifact } of images) {
    signal.throwIfAborted()
    if (!imageTypes.has(artifact.mediaType))
      throw new LanguageMediaError('LANGUAGE_IMAGE_TYPE', 'Tool image has an unsupported media type')
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || !/^[0-9a-f]{64}$/.test(artifact.digest))
      throw new LanguageMediaError(
        'LANGUAGE_IMAGE_REFERENCE',
        'Tool image has an invalid immutable reference',
      )
    if (artifact.size > maxBytes - total)
      throw new LanguageMediaError(
        'LANGUAGE_IMAGE_LIMIT',
        'Tool image evidence exceeds the request byte limit',
      )
    total += artifact.size
  }
  if (!artifacts) {
    if (images.length)
      throw new LanguageMediaError(
        'LANGUAGE_IMAGE_UNAVAILABLE',
        'Tool image evidence has no Host artifact reader',
      )
    return
  }
  for (const { messageIndex, contentIndex, artifact } of images) {
    signal.throwIfAborted()
    let bytes: Uint8Array
    try {
      bytes = await artifacts.read(artifact)
    } catch {
      signal.throwIfAborted()
      throw new LanguageMediaError(
        'LANGUAGE_IMAGE_UNAVAILABLE',
        'Tool image evidence is unavailable or failed Host verification',
      )
    }
    signal.throwIfAborted()
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    signal.throwIfAborted()
    if (bytes.byteLength !== artifact.size || digest !== artifact.digest)
      throw new LanguageMediaError(
        'LANGUAGE_IMAGE_INTEGRITY',
        'Tool image evidence failed immutable byte verification',
      )
    const message = messages[messageIndex]
    if (
      !message ||
      (message.role !== 'user' && message.role !== 'tool_result') ||
      message.content[contentIndex]?.type !== 'text'
    )
      throw new LanguageMediaError(
        'LANGUAGE_IMAGE_POSITION',
        'Tool image evidence has an invalid projection position',
      )
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 32768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
    message.content[contentIndex] = { type: 'image', mimeType: artifact.mediaType, data: btoa(binary) }
  }
}
