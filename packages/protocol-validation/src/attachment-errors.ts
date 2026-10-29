/** Safe, stable reasons shared by admission, storage, RPC and client localization. */
export const ATTACHMENT_ERROR_CODES = [
  'ATTACHMENT_COUNT',
  'ATTACHMENT_BYTES',
  'ATTACHMENT_PIXELS',
  'ATTACHMENT_DATA',
  'ATTACHMENT_MIME',
  'ATTACHMENT_HASH_MISMATCH',
  'ATTACHMENT_NOT_AUTHORIZED',
  'ATTACHMENT_MISSING',
  'ATTACHMENT_QUOTA',
  'ATTACHMENT_CANCELLED',
  'ATTACHMENT_TIMEOUT',
  'ATTACHMENT_UNAVAILABLE',
  'ATTACHMENT_TOO_LARGE',
] as const
export type AttachmentErrorCode = (typeof ATTACHMENT_ERROR_CODES)[number]
export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'AttachmentError'
  }
}
