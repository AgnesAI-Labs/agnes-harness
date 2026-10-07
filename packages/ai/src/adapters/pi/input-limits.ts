import type { ModelInputLimits } from '@agnes/protocol'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Count only provider content parts, never arbitrary tool arguments or structured JSON results. */
function images(parts: unknown): number {
  if (!Array.isArray(parts)) return 0
  return parts.reduce((sum: number, part: unknown) => {
    const block = object(part)
    if (!block) return sum
    if (['image', 'image_url', 'input_image'].includes(String(block.type)) || object(block.image))
      return sum + 1
    const inline = object(block.inlineData)
    if (typeof inline?.mimeType === 'string' && inline.mimeType.startsWith('image/')) return sum + 1
    if (block.type === 'tool_result') return sum + images(block.content)
    return sum + images(object(block.toolResult)?.content)
  }, 0)
}

/** pi can merge consecutive tool results into one provider message (notably Bedrock). */
export function providerPayloadImageError(
  payload: unknown,
  limits: ModelInputLimits | undefined,
): string | undefined {
  const body = object(payload)
  const messages = body?.messages ?? body?.contents ?? body?.input
  if (!Array.isArray(messages)) return undefined
  const counts = messages.map((message) => {
    const row = object(message)
    return images(row?.content ?? row?.parts)
  })
  const perMessage = limits?.images?.maxPerMessage
  if (perMessage !== undefined && counts.some((count) => count > perMessage))
    return `The serialized provider message exceeds ${perMessage} images. Reduce images or start a new conversation.`
  const perRequest = limits?.images?.maxPerRequest
  if (perRequest !== undefined && counts.reduce((sum, count) => sum + count, 0) > perRequest)
    return `The serialized provider request exceeds ${perRequest} images. Reduce images or start a new conversation.`
  return undefined
}
