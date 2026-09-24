export const CHANNEL_ERRORS = Object.freeze([
  'E_MANIFEST_INVALID',
  'E_CONFIG_INVALID',
  'E_SECRETS_UNREADABLE',
  'E_CONNECT_FAILED',
  'E_DAEMON_UNAVAILABLE',
  'E_CAPABILITY_MISSING',
  'E_NOT_IMPLEMENTED',
] as const)

export type ChannelErrorCode = (typeof CHANNEL_ERRORS)[number]

export class ChannelError extends Error {
  readonly code: ChannelErrorCode
  readonly detail: Record<string, unknown> | undefined

  constructor(code: ChannelErrorCode, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`)
    this.name = 'ChannelError'
    this.code = code
    this.detail = detail
  }
}

export function isChannelError(error: unknown): error is ChannelError {
  return error instanceof ChannelError
}
