import { sanitize } from './sanitize.js'

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
/** Masks credentials and neutralises request framing in untrusted text. */
export function redactSecrets(text: string): string {
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
