import { ATTACHMENT_ERROR_CODES, type AttachmentErrorCode } from './validate.js'

/** Only enumerated reason identifiers cross transport boundaries; never forward arbitrary detail. */
export function attachmentErrorCode(value: unknown): AttachmentErrorCode | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined
    const error = value as {
      code?: unknown
      detail?: { code?: unknown }
      data?: { code?: unknown; reason?: unknown }
    }
    for (const candidate of [error.detail?.code, error.data?.code, error.data?.reason, error.code]) {
      const code = ATTACHMENT_ERROR_CODES.find((known) => candidate === known)
      if (code) return code
    }
  } catch {
    return undefined
  }
  return undefined
}
