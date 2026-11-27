import { appServerErrorMessage } from '@agnes/web-ui'
import type { AdminError } from './types.js'

type ErrorResponse = {
  error?: {
    code?: unknown
    message?: unknown
    blockers?: unknown
    data?: { code?: unknown; messageKey?: unknown }
  }
}

export class AdminApiError extends Error {
  readonly details: AdminError

  constructor(details: AdminError) {
    super(details.message)
    this.name = 'AdminApiError'
    this.details = details
  }
}

export function safeError(
  value: unknown,
  fallback = 'The admin backend is temporarily unavailable. Try again later.',
): AdminError {
  if (!value || typeof value !== 'object') return { code: 'ADMIN_UNAVAILABLE', message: fallback }
  const error = value as ErrorResponse
  const code =
    typeof error.error?.data?.code === 'string'
      ? error.error.data.code
      : typeof error.error?.code === 'string'
        ? error.error.code
        : 'ADMIN_UNAVAILABLE'
  const message =
    appServerErrorMessage(
      error.error,
      typeof document === 'undefined' ? 'en' : document.documentElement.lang,
    ) ?? (typeof error.error?.message === 'string' ? error.error.message : fallback)
  return { code, message }
}

export async function json(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export function invalidSelection(): AdminApiError {
  return new AdminApiError({
    code: 'ADMIN_RESPONSE_INVALID',
    message: 'The backend returned data that cannot be verified.',
  })
}
