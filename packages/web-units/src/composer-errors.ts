type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/** Closed codes only: never echo server detail or parse an English validator message. */
export function attachmentErrorMessage(error: unknown, t: Translate): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as {
    code?: unknown
    detail?: { code?: unknown }
    data?: { code?: unknown; reason?: unknown; detail?: { code?: unknown } }
  }
  const code = [
    value.code,
    value.detail?.code,
    value.data?.detail?.code,
    value.data?.reason,
    value.data?.code,
  ].find((code) => typeof code === 'string' && Object.hasOwn(messages, code))
  if (typeof code !== 'string') return undefined
  const key = messages[code]
  if (!key) return undefined
  const message = t(key, code === 'ATTACHMENT_COUNT' ? { count: 50 } : undefined)
  return message === key ? undefined : message
}
const messages: Readonly<Record<string, string>> = Object.freeze({
  ATTACHMENT_COUNT: 'composer.attachment.tooMany',
  ATTACHMENT_DATA: 'composer.attachment.dataInvalid',
  ATTACHMENT_NAME: 'composer.attachment.nameInvalid',
  ATTACHMENT_BYTES: 'composer.attachment.tooLarge',
  ATTACHMENT_TOO_LARGE: 'composer.attachment.tooLarge',
  ATTACHMENT_PIXELS: 'composer.image.tooLargePixels',
  ATTACHMENT_MIME: 'composer.attachment.nameInvalid',
  ATTACHMENT_HASH_MISMATCH: 'composer.attachment.hashMismatch',
  ATTACHMENT_NOT_AUTHORIZED: 'composer.attachment.notAuthorized',
  ATTACHMENT_MISSING: 'composer.attachment.missing',
  ATTACHMENT_QUOTA: 'composer.attachment.quota',
  ATTACHMENT_CANCELLED: 'composer.attachment.cancelled',
  ATTACHMENT_TIMEOUT: 'composer.attachment.timeout',
  ATTACHMENT_UNAVAILABLE: 'composer.attachment.unavailable',
  BASE64_INVALID: 'composer.image.invalid',
  FORMAT_INVALID: 'composer.image.invalid',
  DIMENSIONS_INVALID: 'composer.image.invalid',
  MIME_MISMATCH: 'composer.image.mimeMismatch',
  PIXEL_LIMIT: 'composer.image.tooLargePixels',
  BYTE_LIMIT: 'composer.image.tooLarge',
})
