import { redactSecrets } from '@agnes/extension-api'

const MASK = '[REDACTED]'
/**
 * Whether an object key (or the name in a `[name, value]` pair) names a credential. A key may also
 * join its parts with spaces (`"my token"`), as the text rule reads `my token: …` as one.
 */
const CREDENTIAL_KEY =
  /^(?:[A-Za-z0-9]{1,64}[_\s-]){0,6}(?:api[_-]?key|apikey|key|token|secret|password|passwd|authorization)$/i

/**
 * How far past its visible length a text is read before it is redacted. A credential shorter than
 * this cannot be cut by the read window and still reach what is shown.
 */
export const REDACT_MARGIN = 256

/** At most `n` UTF-16 units, never ending on the first half of a surrogate pair. */
export function cut(text: string, n: number): string {
  if (text.length <= n) return text
  const last = text.charCodeAt(n - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n)
}

/**
 * Text as planning may read it: harness framing a payload could impersonate (envelope tags, special
 * tokens, zero-width characters) neutralised, then credentials replaced by a marker. Deterministic,
 * so a hash taken over the result is stable.
 */
export function redactEvidence(text: string): string {
  return redactSecrets(text)
}

/**
 * At most `max` characters of `text`, redacted, ending in `…` when anything was left out. Only
 * `max + REDACT_MARGIN` characters are ever read, so the work is bounded whatever the input.
 *
 * When the input is longer than that window, a credential may be cut by the window's edge and so
 * escape the rules. What is shown is therefore at most what came from the first `max` input
 * characters (`prefix`: the same text cut at `max`, redacted on its own), and never the last
 * `REDACT_MARGIN` characters of the redacted window, which is where a cut credential would be even
 * after an earlier one shrank to a short marker.
 */
export function redactClipped(text: string, max: number): string {
  if (text.length <= max + REDACT_MARGIN) {
    const whole = redactEvidence(text)
    return whole.length <= max ? whole : `${cut(whole, max - 1)}…`
  }
  const window = redactEvidence(cut(text, max + REDACT_MARGIN))
  const prefix = redactEvidence(cut(text, max))
  const keep = Math.max(0, Math.min(max - 1, prefix.length, window.length - REDACT_MARGIN))
  return `${cut(window, keep)}…`
}

const MEMBERS = 64
const KEY_CHARS = 128

/**
 * A tool's arguments as planning may read them. Each string is redacted on its own, cut to `keep`,
 * before the value is serialised (inside JSON its quotes are escaped, which hides the value from the
 * rules). Every value under a credential-named key (or after the name in a `[name, value]` pair) is
 * masked, whatever its shape: nested leaves become the marker and the structure stays valid JSON.
 * Keys are redacted before they are cut. Lists and objects keep 64 members and 8 levels.
 */
export function redactArgs(value: unknown, keep: number, depth = 0, masked = false): unknown {
  if (typeof value === 'string') return masked ? MASK : redactClipped(value, keep)
  // Every scalar under a credential name becomes the marker, `null` included: left as it is, the
  // serialised `"token":null` would be masked again as a bare value.
  if (value === null || typeof value !== 'object') return masked ? MASK : value
  if (depth >= 8) return '[…]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MEMBERS)
    const pair =
      !masked && items.length === 2 && typeof items[0] === 'string' && CREDENTIAL_KEY.test(items[0])
    return items.map((item, at) => redactArgs(item, keep, depth + 1, masked || (pair && at === 1)))
  }
  const out: Record<string, unknown> = {}
  // Defined, not assigned: a `__proto__` key is an ordinary member here, not the prototype.
  for (const [key, item] of Object.entries(value).slice(0, MEMBERS))
    Object.defineProperty(out, redactClipped(key, KEY_CHARS), {
      value: redactArgs(item, keep, depth + 1, masked || CREDENTIAL_KEY.test(key)),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  return out
}
