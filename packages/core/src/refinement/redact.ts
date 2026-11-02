import { sanitize } from '../request/derive.js'

// The narrow credential shapes, after `@agnes/error-sanitization`'s secret rules (copied: Core does
// not depend on that package). Long base64 or hex runs are deliberately not masked, so commit SHAs,
// ULIDs and content hashes stay readable evidence.
//
// Every pattern runs in linear time. A bounded run (the name prefix) is the only repetition in front
// of another that could match the same characters, and every quoted-value alternative always
// succeeds once it has started (it ends at its closing quote or at the end of the text), so an
// attempt never backtracks through what it read. That is also what makes redaction fail closed: a
// quoted value that never closes, however long, is masked to the end of the text.

// A `secret://` reference names a secret and stays; the value bound to it is masked. These run
// first, as in the original (which binds with `=`; `:` is accepted too).
const JSON_SECRET_DOUBLE = /("secret:\/\/[^"\s]+"\s*:\s*")([^"]+)(")/g
const JSON_SECRET_SINGLE = /('secret:\/\/[^'\s]+'\s*:\s*')([^']+)(')/g
const ASSIGNED_SECRET = /(secret:\/\/[^\s"'=:]+\s*[=:]\s*)("[^"]+"|'[^']+'|[^\s,;}]+)/g

const TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws]'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, '[REDACTED:github]'],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED:jwt]'],
  [/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED:sk]'],
]
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi
/** `Basic` only after an authorization name: the word alone is ordinary prose. */
const BASIC = /(\bauthorization["']?\s*[:=]\s*["']?basic\s+)[A-Za-z0-9+/=._~-]{4,}/gi
/**
 * A credential-named key, as a whole word or as the last of at most six `_`/`-` joined parts.
 * `secret://` is a reference, not an assignment to a `secret` name; every other name followed by
 * `//` (`password=//x`, `token://x`) is still an assignment.
 */
const NAME = String.raw`\b(?:[A-Za-z0-9]{1,64}[_-]){0,6}(?:api[_-]?key|apikey|key|token|secret(?!:\/\/)|password|passwd|authorization)\b`
/**
 * A value assigned to such a name: `API_KEY=…`, `token: …`, `"password": "…"`, `'password' => '…'`
 * (Ruby, PHP, Perl), `password := "…"` (Go), and the same inside a
 * JSON string where the quotes are escaped once or more (`\"password\":\"…\"`). A quoted value runs to its
 * closing quote across lines, or to the end of the text. A bare value stops at a separator, and at
 * `{` or `[`, which start a structure whose values the argument walk masks on its own.
 */
const ESCAPED = String.raw`\\+"(?:[^"\\]|\\[^"])*(?:\\*"|\\*$)`
const DOUBLE = String.raw`"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)`
const SINGLE = String.raw`'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)`
const ASSIGNED = new RegExp(
  String.raw`(${NAME}(?:\\?["'])?\s*(?::=|=>|[:=])\s*)(${ESCAPED}|${DOUBLE}|${SINGLE}|[^\s,;}&"'\\{\[]+)`,
  'gi',
)
const MASK = '[REDACTED]'
/** A bare JSON value: masked as a quoted string, so a JSON document stays JSON. */
const JSON_LITERAL = /^(?:-?\d[\d.eE+-]*|true|false|null)$/
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
  let out = sanitize(text)
    .replace(JSON_SECRET_DOUBLE, '$1[REDACTED:secret]$3')
    .replace(JSON_SECRET_SINGLE, '$1[REDACTED:secret]$3')
    .replace(ASSIGNED_SECRET, (_whole, before: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
      return `${before}${quote}[REDACTED:secret]${quote}`
    })
  for (const [pattern, mark] of TOKENS) out = out.replace(pattern, mark)
  return out
    .replace(BASIC, '$1[REDACTED]')
    .replace(BEARER, '$1[REDACTED]')
    .replace(ASSIGNED, (_whole, before: string, value: string) => {
      // The value's own quotes are kept, so a JSON document stays JSON.
      const quote = value.startsWith('\\"')
        ? '\\"'
        : value[0] === '"' || value[0] === "'"
          ? value[0]
          : JSON_LITERAL.test(value)
            ? '"'
            : ''
      return `${before}${quote}${MASK}${quote}`
    })
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
