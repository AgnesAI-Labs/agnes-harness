import { decodeSafeImages } from './safe-image.js'

type ImageModel = {
  input?: readonly string[]
  inputLimits?: {
    images?: {
      maxPerMessage?: number
      maxPerRequest?: number
      resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; jpegQuality?: number }
    }
  }
}
type ImageBlock = { type: string; data?: string; mimeType?: string }

/** Product limits remain independent of the provider's optional catalogue limits. */
export function userImagePolicy(model: ImageModel | undefined) {
  const limits = model?.inputLimits?.images
  return {
    supported: model?.input?.includes('image') === true,
    maxCount: Math.min(limits?.maxPerMessage ?? Infinity, limits?.maxPerRequest ?? Infinity),
    maxWidth: Math.min(1456, limits?.resize?.maxWidth ?? Infinity),
    maxHeight: Math.min(1456, limits?.resize?.maxHeight ?? Infinity),
    maxBase64Bytes: limits?.resize?.maxBytes,
    jpegQuality: limits?.resize?.jpegQuality,
  }
}

/** Check every provider-visible message, including historical and tool-result images. No mutation. */
export function modelImageInputError(
  model: ImageModel | undefined,
  messages: readonly { content: readonly ImageBlock[] }[],
): string | undefined {
  const groups = messages.map((message) => message.content.filter((block) => block.type === 'image'))
  const count = groups.reduce((sum, images) => sum + images.length, 0)
  if (!count) return undefined
  if (!model) return 'Image input is unavailable until the model capabilities are loaded.'
  if (!model.input?.includes('image')) return 'The selected model does not support image input.'
  const limits = model.inputLimits?.images
  const perMessage = limits?.maxPerMessage
  if (perMessage !== undefined && groups.some((images) => images.length > perMessage))
    return `The model accepts at most ${perMessage} images per message.`
  if (limits?.maxPerRequest !== undefined && count > limits.maxPerRequest)
    return `The model accepts at most ${limits.maxPerRequest} images per request, including history and tool results.`
  const resize = limits?.resize
  for (const images of groups) {
    for (const image of images) {
      if (typeof image.data !== 'string' || typeof image.mimeType !== 'string') return 'Invalid image input.'
      if (resize?.maxBytes !== undefined && image.data.length > resize.maxBytes)
        return `An image exceeds the model's ${resize.maxBytes}-byte Base64 limit.`
      if (resize?.maxWidth !== undefined || resize?.maxHeight !== undefined) {
        try {
          const [decoded] = decodeSafeImages([{ data: image.data, mimeType: image.mimeType }], {
            maxBytesPerImage: image.data.length,
            maxAggregateBytes: image.data.length,
            maxPixelsPerImage: Number.MAX_SAFE_INTEGER,
            maxAggregatePixels: Number.MAX_SAFE_INTEGER,
          })
          if (
            !decoded ||
            decoded.width > (resize.maxWidth ?? Infinity) ||
            decoded.height > (resize.maxHeight ?? Infinity)
          )
            return 'An image exceeds the model image dimensions. Resize it before sending.'
        } catch {
          return 'The image format or dimensions could not be validated for this model.'
        }
      }
    }
  }
  return undefined
}
