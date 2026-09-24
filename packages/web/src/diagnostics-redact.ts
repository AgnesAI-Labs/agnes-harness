import { redact } from '@agnes/base/privacy'

export const REDACTED = '***REDACTED***'

// Anchored branches require an exact key match, `token$` / `credentials?$` a key suffix
// (`NPM_TOKEN`, `githubToken`, `awsCredentials`); the rest match anywhere in the key name. Kept
// narrow (vs. a bare `token`/`key` substring) so `maxTokens`, `tokenizer`, `sessionKey`,
// `credentialRef` and similar counts/refs survive structural redaction untouched; a non-string
// under a matching key (e.g. an integer `firstToken`) is kept by redactSecretField.
const SECRET_KEY =
  /^(authorization|proxy-authorization|bearer|cookie|set-cookie)$|token$|credentials?$|api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret/i
const URL_KEY = /^(baseUrl|url|endpoint)$/i

// Mirrors host/src/adapters/secrets.ts:10's REF shape exactly (case-insensitive, since Web-side
// values are not guaranteed to be lower-cased already). Only a bare, whole-string reference is
// exempt from redaction — a reference embedded in a longer sentence, or followed by trailing
// content, is not a pointer anymore and must go through the normal text/field redaction below.
const BARE_REF = /^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/i

// Shared alternation for the two "name: value" / "name": "value" lookbehind rules below.
const NAMES =
  'api[_-]?key|token|secret|password|passwd|pwd|passphrase|credentials?|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?(?:access[_-]?)?key'
// Up to 40 identifier characters may precede a name (`DB_PASSWORD`, `STRIPE_SECRET_KEY`,
// `githubToken`). The name must still sit right before the `:`/`=`, so `passwordless=` or
// `tokenizer:` never match. `\b` alone cannot do this: `_` is a word character, so there is no
// boundary inside `DB_PASSWORD`.
const PREFIX = '[A-Za-z0-9_-]{0,40}'

// Built via concatenation so the literal PEM header/footer text never appears contiguously in this
// file, which would otherwise trip the repository's secrets guard.
const PEM_BEGIN = '-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----'
const PEM_END = '-----END ' + '[A-Z ]*PRIVATE KEY-----'

// `@agnes/base/privacy`'s custom rules replace with a literal string (no `$1` backreferences), so
// every pattern here is a lookbehind that matches only the value, never the surrounding key/prefix.
//
// Every quantifier inside a lookbehind is bounded (`\s{0,16}` / `\s{1,16}`, never `\s*` /
// `\s+`; likewise the name prefix and URL scheme/user classes): V8 evaluates a lookbehind by
// scanning backward from every candidate position, and an unbounded quantifier there means it
// retries every possible run length at every position — O(n) backtracking work per position,
// O(n^2) total. A long whitespace run with no match ever measured ~5.4s at 40k chars and ~21.5s at
// 80k before this bound; 16 chars is far more than any real header/assignment/JSON pair ever has
// between the name and its value.
const EXTRA = [
  {
    pattern: String.raw`(?<=\bAuthorization\s{0,16}:\s{0,16}(?:Bearer|Basic)\s{1,16})[^\s"'<>]+`,
    flags: 'i',
  },
  { pattern: String.raw`\bxox[baprs]-[A-Za-z0-9-]{12,}` },
  { pattern: String.raw`\bAIza[0-9A-Za-z_-]{20,}` },
  { pattern: `${PEM_BEGIN}[\\s\\S]*?${PEM_END}` },
  { pattern: String.raw`(?<=\b${PREFIX}(?:${NAMES})\s{0,16}[:=]\s{0,16}["']?)[^"'\s,;}]+`, flags: 'i' },
  { pattern: String.raw`(?<="${PREFIX}(?:${NAMES})"\s{0,16}:\s{0,16}")(?:\\.|[^"\\])+`, flags: 'i' },
  // The password of any `scheme://user:password@` URL in free text (`postgres://admin:pw@db`,
  // `redis://:pw@cache`), keeping scheme, user and host. Structured baseUrl/url/endpoint values
  // additionally lose their whole userinfo and query in stripUrl below.
  {
    pattern: String.raw`(?<=\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s\/:@"'<>]{0,128}:)[^\s\/@"'<>]{1,256}(?=@)`,
    flags: 'i',
  },
].map((rule) => ({ ...rule, replace: REDACTED }))

const RULES = { secrets: true, paths: false as const, pii: false, custom: EXTRA }

// A bare token in a URL fragment (the Web WS credential lives only in `location.hash`) is not
// caught by any secret-shaped regex above, so it is stripped separately: find the URL run, then
// locate `#` with a plain (linear) String.indexOf instead of putting it in the regex.
//
// An earlier version matched `(https?:\/\/[^\s"'<>#]+)#[^\s"'<>]*` directly: excluding `#` from the
// greedy class means that when a run has no `#` at all (e.g. several comma-joined URLs — a comma is
// not excluded), the engine must still try, and fail, to find one starting from every position in
// the run before giving up — O(n^2) (measured: 5000 comma-joined URLs, ~219 KB, took ~1.7s). This
// version's greedy class has nothing required after it, so a match can never fail once started —
// linear, no backtracking. The tradeoff (accepted): a comma/semicolon-joined run that does contain a
// `#` is treated as one run, so everything up to that first `#` is kept and the rest replaced,
// rather than only the specific URL that owned the fragment — over-redaction, not under-redaction.
const URL_RUN = /https?:\/\/[^\s"'<>]+/g

function stripUrlFragment(match: string): string {
  const hashIndex = match.indexOf('#')
  return hashIndex < 0 ? match : `${match.slice(0, hashIndex)}#${REDACTED}`
}

/**
 * Runs the shared secrets waterfall, the diagnostics-specific EXTRA lookbehind rules, and URL
 * fragment stripping. Never throws: any internal failure (e.g. a pathological input triggering an
 * engine-level error) redacts the whole string rather than letting the error escape to the caller.
 */
export function redactDiagnosticText(text: string): string {
  try {
    return redact(text, RULES).replace(URL_RUN, stripUrlFragment)
  } catch {
    return REDACTED
  }
}

function stripUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return raw
  }
}

function redactSecretField(value: unknown): unknown {
  if (typeof value === 'string') return BARE_REF.test(value) ? value : REDACTED
  if (value !== null && typeof value === 'object') return REDACTED
  return value
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  // A bare secret:// reference (the whole string, nothing else) is a pointer rather than a
  // credential; the same exemption is applied structurally in host/src/adapters/secrets.ts. Only a
  // BARE_REF match skips the generic EXTRA text rules below — a reference embedded in a longer
  // string (extra prose, or another secret concatenated after it) still goes through full
  // redaction, otherwise the "secret://" prefix alone would launder anything appended after it.
  if (typeof value === 'string') return BARE_REF.test(value) ? value : redactDiagnosticText(value)
  if (value === null || typeof value !== 'object') return value

  // Cycles resolve to REDACTED at the point of recurrence; siblings that legitimately share a
  // reference (a DAG, not a cycle) are still processed independently thanks to the backtracking
  // `delete` below.
  if (seen.has(value)) return REDACTED
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, seen))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) out[key] = redactSecretField(item)
      else if (URL_KEY.test(key) && typeof item === 'string') out[key] = redactDiagnosticText(stripUrl(item))
      else out[key] = redactValue(item, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/** Recursively redacts secrets from an arbitrary JSON-shaped diagnostics value. Never throws. */
export function redactDiagnostic<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T
}
