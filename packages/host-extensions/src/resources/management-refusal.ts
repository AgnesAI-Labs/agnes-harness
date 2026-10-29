import type { RejectedBeforeEffectError } from '@agnes/core'

/**
 * The daemon's management handlers refuse malformed requests with `INVALID_PARAMS` while validating
 * them, before they read or change anything, and the supervisor forwards that code as the reply's
 * `code`. Only that exact code is read as "nothing happened"; every other failure stays uncertain.
 */
export function refusedForParameters(
  operation: string,
): (error: unknown) => RejectedBeforeEffectError | undefined {
  return (error) =>
    error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'INVALID_PARAMS'
      ? {
          code: 'INVALID_PARAMS',
          message: `${operation} refused the request before changing anything: its parameters are invalid for this action. Check the action's required fields and retry.`,
        }
      : undefined
}
