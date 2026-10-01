import type { JsonValue } from '@agnes/protocol/runtime'

const sensitive = /credential|authorization|cookie|password|secret|token|signature|private.?key|oauth|claims/i
const secretText =
  /(?:bearer\s+\S+|secret:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|[?&](?:access_token|code|password)=)/i
/** Mandatory baseline. It also runs again at export; deployment redactors may only tighten it. */
export function redactAuditPayload(value: JsonValue): JsonValue {
  if (typeof value === 'string') return secretText.test(value) ? '<redacted>' : value
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactAuditPayload)
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitive.test(key) ? '<redacted>' : redactAuditPayload(child),
    ]),
  )
}
