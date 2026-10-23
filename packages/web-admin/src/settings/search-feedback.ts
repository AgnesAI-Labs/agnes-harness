import { appServerErrorMessage } from '@agnes/web-ui'

const KEYS: Readonly<Record<string, string>> = {
  SEARCH_AUTH_FAILED: 'errorAuth',
  SEARCH_ACCESS_DENIED: 'errorAccess',
  SEARCH_PAYMENT_REQUIRED: 'errorPayment',
  SEARCH_RATE_LIMITED: 'errorRate',
  SEARCH_TIMEOUT: 'errorTimeout',
  SEARCH_NETWORK_FAILED: 'errorNetwork',
  SEARCH_NOT_CONFIGURED: 'errorIncomplete',
  SEARCH_INVALID: 'errorInvalid',
  SEARCH_FAILED: 'testFailed',
}

/** Render fixed localized categories, never arbitrary provider error text. */
export function searchFailureMessage(value: unknown, t: (key: string) => string): string | undefined {
  const publicMessage = appServerErrorMessage(value, document.documentElement.lang)
  if (publicMessage) return publicMessage
  if (!value || typeof value !== 'object') return undefined
  const code = (value as { code?: unknown }).code
  const key = typeof code === 'string' && Object.hasOwn(KEYS, code) ? KEYS[code] : undefined
  return key ? t(key) : undefined
}
