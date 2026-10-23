import { SdkError } from './errors.js'

/** Refuses a daemon that would silently drop `additionalDirectories` on `session/new`. */
export function requireAdditionalDirectories(capabilities: Record<string, unknown>): void {
  const session = capabilities.sessionCapabilities as { additionalDirectories?: unknown } | undefined
  if (!session?.additionalDirectories)
    throw new SdkError(
      'unsupported',
      'this daemon does not support adding directories to a session; restart it from a newer build',
    )
}
