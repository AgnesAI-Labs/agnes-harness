import { redact } from '@agnes/error-sanitization'

export const REDACTED = '***REDACTED***'

// Anchored branches require an exact key match, `token$` / `credentials?$` a key suffix
// (`NPM_TOKEN`, `githubToken`, `awsCredentials`); the rest match anywhere in the key name. Kept
// narrow (vs. a bare `token`/`key` substring) so `maxTokens`, `tokenizer`, `sessionKey`,
// `credentialRef` and similar counts/refs survive structural redaction untouched; a non-string
// under a matching key (e.g. an integer `firstToken`) is kept by redactSecretField.
const SECRET_KEY =
  /^(authorization|proxy-authorization|bearer|cookie|set-cookie)$|token$|credentials?$|api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret/i
const CLOUD_KEY_NAME = 'AGH_(?:CLOUD|API)_KEY'
const CLOUD_KEY_FIELD = new RegExp(`^${CLOUD_KEY_NAME}$`, 'i')
const URL_KEY = /^(baseUrl|url|endpoint)$/i

// Mirrors host/src/adapters/secrets.ts:10's REF shape exactly (case-insensitive, since Web-side
// values are not guaranteed to be lower-cased already). Only a bare, whole-string reference is
// exempt from redaction — a reference embedded in a longer sentence, or followed by trailing
// content, is not a pointer anymore and must go through the normal text/field redaction below.
const BARE_REF = /^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/i

// Shared alternation for the two "name: value" / "name": "value" lookbehind rules below.
const NAMES =
  'api[_-]?key|token|secret|password|passwd|pwd|passphrase|credentials?|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?(?:access[_-]?)?key|cookie|[_-]key'
// Up to 40 identifier characters may precede a name (`DB_PASSWORD`, `STRIPE_SECRET_KEY`,
// `githubToken`, `AGNES_KEY`). The name must still sit right before the `:`/`=`, so
// `passwordless=`, `tokenizer:`, `cookieConsent:` or `hotkey:` never match. `\b` alone cannot do
// this: `_` is a word character, so there is no boundary inside `DB_PASSWORD`.
const PREFIX = '[A-Za-z0-9_-]{0,40}'
const JSON_TEXT_SECRET_KEY = new RegExp(`^${PREFIX}(?:${NAMES})$`, 'i')

// Built via concatenation so the literal PEM header/footer text never appears contiguously in this
// file, which would otherwise trip the repository's secrets guard.
const PEM_BEGIN = '-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----'
const PEM_END = '-----END ' + '[A-Z ]*PRIVATE KEY-----'

// `@agnes/error-sanitization`'s custom rules replace with a literal string (no `$1` backreferences), so
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
  // A (Set-)Cookie header's whole `;`-joined value, not just the first pair the next rule stops at.
  { pattern: String.raw`(?<=\bcookie\s{0,16}:\s{0,16})[^\s"'<>][^\r\n"'<>]*`, flags: 'i' },
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

// Runtime logs can contain JSON-escaped whitespace just before a credential.
const CLOUD_KEY = /(?:\b|(?<=\\[bfnrt]))agh_sk_[\w-]+/g
// The protocol reserves /_agnes/remote-access/<ticket> for temporary bearer capabilities.
// Recognize the separators that HTTP URLs and JSON can represent as slashes or backslashes.
// Capture the source spelling so the replacement keeps the original path and escaping.
const ESCAPED_SEPARATOR = String.raw`u00(?:2[fF]|5[cC])`
const PATH_SEPARATOR = String.raw`(?:/|\\+(?:/|${ESCAPED_SEPARATOR})?)`
// Try only at the start of a separator, which also avoids treating the authority as a route.
const CLOUD_TICKET_PATH = new RegExp(
  String.raw`((?:(?<![\\/]|\\${ESCAPED_SEPARATOR})${PATH_SEPARATOR}|(?<![\w./\\-])|(?<=\\[bfnrt]))_agnes${PATH_SEPARATOR}remote-access${PATH_SEPARATOR})([\w%-]+(?:\.[\w%-]+)*)`,
  'g',
)
// Mirrors remoteFrontendSessionPath in protocol/src/remote-frontend.ts.
const CLOUD_TICKET = /^[a-z0-9]+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u
// A quoted field name can come from an embedded JSON fragment, console dictionary or YAML.
const QUOTED_CLOUD_KEY_FIELD = new RegExp(
  String.raw`((?:"${CLOUD_KEY_NAME}"|'${CLOUD_KEY_NAME}')\s*:\s*)('(?:\\.|''|[^'\\])*'|"(?:\\.|[^"\\])*"|[^"'\\\s,;{}\[\]]+)`,
  'gi',
)
// A JSON log can wrap a rendered dictionary. Its double quotes and backslashes are escaped again.
const ESCAPED_CLOUD_KEY_FIELD = new RegExp(
  String.raw`((?:'${CLOUD_KEY_NAME}'|\\"${CLOUD_KEY_NAME}\\")[ \t]*:[ \t]*\\")(?:\\\\(?:\\\\|\\"|[^"\\])|[^"\\])*(\\")`,
  'gi',
)

function redactCloudCredentials(text: string): string {
  // Match complete cloud credentials before the generic rules can mask fragments within them.
  return text
    .replace(CLOUD_TICKET_PATH, (path, prefix: string, segment: string, offset: number, source: string) => {
      // A run of raw backslashes immediately after a scheme can introduce the authority.
      if (/(?:https?|wss?):$/i.test(source.slice(Math.max(0, offset - 6), offset))) return path
      let ticket = segment
      if (segment.includes('%')) {
        try {
          ticket = decodeURIComponent(segment)
        } catch {
          return path
        }
      }
      return CLOUD_TICKET.test(ticket) ? `${prefix}${REDACTED}` : path
    })
    .replace(CLOUD_KEY, REDACTED)
}

// Neither a bare token in a URL fragment (the Web WS credential lives only in `location.hash`) nor
// a query value (`?ticket=`, `?code=`, `X-Amz-Signature=`) carries a name or shape the rules above
// can rely on, so every http(s)/ws(s) URL run loses both: each query value (a segment without `=`
// whole) and the fragment are replaced, keeping scheme, host, path and parameter names. Find the
// URL run, then locate `?`/`#` with plain (linear) String.indexOf/split instead of in the regex.
//
// An earlier version matched `(https?:\/\/[^\s"'<>#]+)#[^\s"'<>]*` directly: excluding `#` from the
// greedy class means that when a run has no `#` at all (e.g. several comma-joined URLs — a comma is
// not excluded), the engine must still try, and fail, to find one starting from every position in
// the run before giving up — O(n^2) (measured: 5000 comma-joined URLs, ~219 KB, took ~1.7s). This
// version's greedy class has nothing required after it, so a match can never fail once started —
// linear, no backtracking. The tradeoff (accepted): a comma/semicolon-joined run that does contain a
// `?` or `#` is treated as one run, so everything after that first `?`/`#` is replaced, rather than
// only the part of the specific URL that owned it — over-redaction, not under-redaction.
const URL_RUN = /(?:https?|wss?):\/\/[^\s"'<>]+/gi
const JSON_LINE = /^[ \t]*[[{"][^\r\n\u2028\u2029]*[\]}"][ \t]*(?=\r?$)/gm
const JSON_STRING = /"(?:\\.|[^"\\])*"/g
const JSON_ATOM = new RegExp(
  String.raw`${JSON_STRING.source}|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?`,
  'g',
)
const MAX_ENCODED_JSON_DEPTH = 16
const TEXT_LABEL_CONTEXT = 256

const redactQueryPair = (pair: string): string =>
  pair.includes('=') ? `${pair.slice(0, pair.indexOf('=') + 1)}${REDACTED}` : pair && REDACTED

function stripUrlSecrets(match: string, offset: number, text: string): string {
  // In mixed console text, an escaped quote terminating a serialized URL can border the match.
  // Keep its escape sequence outside the query and fragment rewrite.
  let end = match.length
  if (text[offset + end] === '"' || text[offset + end] === "'") while (match[end - 1] === '\\') end--
  const escapedQuote = match.slice(end)
  const hashIndex = match.indexOf('#')
  const url = match.slice(0, hashIndex < 0 ? end : hashIndex)
  const queryIndex = url.indexOf('?')
  const [path, query] = queryIndex < 0 ? [url] : [url.slice(0, queryIndex), url.slice(queryIndex + 1)]
  const kept = query === undefined ? path : `${path}?${query.split('&').map(redactQueryPair).join('&')}`
  return (hashIndex < 0 ? kept : `${kept}#${REDACTED}`) + escapedQuote
}

function redactPlainText(text: string): string {
  const cloudRedacted = redactCloudCredentials(text)
    .replace(ESCAPED_CLOUD_KEY_FIELD, `$1${REDACTED}$2`)
    .replace(QUOTED_CLOUD_KEY_FIELD, (_pair, prefix: string, value: string) => {
      let quote = prefix.startsWith('"') ? '"' : ''
      if (value[0] === "'" || value[0] === '"') quote = value[0]
      return `${prefix}${quote}${REDACTED}${quote}`
    })
  return redact(cloudRedacted, RULES).replace(URL_RUN, stripUrlSecrets)
}

function redactJsonBody(source: string, value: unknown, depth: number): string {
  // Scan only validated JSON. A quoted token skips its whole contents, including digits and escapes.
  const numbers: { raw: string; offset: number }[] = []
  const usedTags = new Set<number>()
  for (const match of source.matchAll(JSON_ATOM)) {
    const raw = match[0]
    if (raw[0] === '"') {
      if (raw.startsWith('"\\u0000')) {
        const tag = /^\d+(?=:)/.exec((JSON.parse(raw) as string).slice(1))
        if (tag) usedTags.add(Number(tag[0]))
      }
    } else if (JSON.stringify(Number(raw)) !== raw) {
      numbers.push({ raw, offset: match.index })
    }
  }
  if (numbers.length === 0) return JSON.stringify(redactValue(value, new WeakSet(), depth))

  // Carry non-round-tripping numbers as BigInt indices during redaction. A JSON string can only
  // start with NUL through an escape, so the scan above reserves all tags present in the input.
  let tagId = 0
  while (usedTags.has(tagId)) tagId++
  const tag = `\0${tagId}:`
  const parts: string[] = []
  let cursor = 0
  for (const [index, { raw, offset }] of numbers.entries()) {
    parts.push(source.slice(cursor, offset), JSON.stringify(tag + index))
    cursor = offset + raw.length
  }
  parts.push(source.slice(cursor))
  const exact: unknown = JSON.parse(parts.join(''), (_key, item: unknown) =>
    typeof item === 'string' && item.startsWith(tag) ? BigInt(item.slice(tag.length)) : item,
  )
  const serialized = JSON.stringify(redactValue(exact, new WeakSet(), depth), (_key, item: unknown) => {
    if (typeof item === 'bigint') return tag + item
    // Escape a tag if redaction created one in a string value.
    return typeof item === 'string' && item.startsWith(tag) ? tag + item : item
  })
  const encodedTag = JSON.stringify(tag).slice(0, -1)
  return serialized.replace(JSON_STRING, (quoted, offset: number) => {
    if (!quoted.startsWith(encodedTag) || serialized[offset + quoted.length] === ':') return quoted
    const payload = (JSON.parse(quoted) as string).slice(tag.length)
    if (payload.startsWith(tag)) return JSON.stringify(payload)
    return numbers[Number(payload)]?.raw ?? JSON.stringify(REDACTED)
  })
}

function redactJsonRecord(text: string, depth: number, precedingText = ''): string | undefined {
  const start = text.search(/\S/)
  const first = text[start]
  if (first !== '{' && first !== '[' && first !== '"') return undefined
  if (first === '"' && /[:=]\s*$/.test(precedingText)) {
    // Reuse the text rules to recognize a label split across lines or console arguments.
    // Test only the bounded context and the opening quote's indentation.
    const probe = '"diagnostic-value"'
    if (!redactPlainText(precedingText + text.slice(0, start) + probe).endsWith(probe)) return undefined
  }
  const end = text.trimEnd().length
  const source = text.slice(start, end)
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return undefined
  }
  let body = JSON.stringify(REDACTED)
  try {
    if (depth < MAX_ENCODED_JSON_DEPTH) body = redactJsonBody(source, value, depth + 1)
  } catch {
    // Keep a valid JSON value even if processing a pathological record fails.
  }
  return text.slice(0, start) + body + text.slice(end)
}

function redactTextValue(text: string, depth: number): string {
  try {
    const record = redactJsonRecord(text, depth)
    if (record !== undefined) return record

    // Decode complete records separately. Keep quoted values with preceding plaintext labels.
    if (text.includes('\n')) {
      const chunks: string[] = []
      let offset = 0
      for (const line of text.matchAll(JSON_LINE)) {
        const context = text.slice(Math.max(offset, line.index - TEXT_LABEL_CONTEXT), line.index)
        const redacted = redactJsonRecord(line[0], depth, context)
        if (redacted === undefined) continue
        chunks.push(redactPlainText(text.slice(offset, line.index)), redacted)
        offset = line.index + line[0].length
      }
      if (chunks.length > 0) return chunks.join('') + redactPlainText(text.slice(offset))
    }
    return redactPlainText(text)
  } catch {
    return REDACTED
  }
}

/** Redacts complete JSON records structurally and scans surrounding text. Fails closed. */
export function redactDiagnosticText(text: string): string {
  return redactTextValue(text, 0)
}

/** Keeps structured console arguments intact and redacts split headers across adjacent text arguments. */
export function redactDiagnosticArguments(values: readonly string[]): string {
  const chunks: string[] = []
  let prose: string[] = []
  let context = ''
  for (const value of values) {
    const record = redactJsonRecord(value, 0, context)
    if (record === undefined) {
      prose.push(value)
      context = (context + value.slice(-TEXT_LABEL_CONTEXT) + ' ').slice(-TEXT_LABEL_CONTEXT)
      continue
    }
    if (prose.length > 0) chunks.push(redactDiagnosticText(prose.join(' ')))
    chunks.push(record)
    prose = []
    context = ''
  }
  if (prose.length > 0) chunks.push(redactDiagnosticText(prose.join(' ')))
  // The ZIP redacts buffered text again. Keep each JSON argument on its own line for that pass.
  return chunks.join('\n')
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

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  // A bare secret:// reference (the whole string, nothing else) is a pointer rather than a
  // credential; the same exemption is applied structurally in host/src/adapters/secrets.ts. Only a
  // BARE_REF match skips the generic EXTRA text rules below — a reference embedded in a longer
  // string (extra prose, or another secret concatenated after it) still goes through full
  // redaction, otherwise the "secret://" prefix alone would launder anything appended after it.
  if (typeof value === 'string') return BARE_REF.test(value) ? value : redactTextValue(value, depth)
  if (value === null || typeof value !== 'object') return value

  // Cycles resolve to REDACTED at the point of recurrence; siblings that legitimately share a
  // reference (a DAG, not a cycle) are still processed independently thanks to the backtracking
  // `delete` below.
  if (seen.has(value)) return REDACTED
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, depth))
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = Object.create(null)
    let nextSuffix = 2
    for (const [key, item] of Object.entries(record)) {
      const reference = BARE_REF.test(key)
      // Serialized log JSON also used the plaintext rules before it was decoded.
      const redactedKey = reference ? key : depth > 0 ? redactPlainText(key) : redactCloudCredentials(key)
      let outputKey = redactedKey
      if (redactedKey !== key) {
        // Keep original property names reserved. Distinct credential URLs may have the same mask.
        while (Object.hasOwn(record, outputKey) || Object.hasOwn(out, outputKey))
          outputKey = `${redactedKey} (${nextSuffix++})`
      }
      // An exact cloud Key field can carry a credential that a tool parsed as a JSON scalar.
      if (CLOUD_KEY_FIELD.test(key))
        out[outputKey] = typeof item === 'string' && BARE_REF.test(item) ? item : REDACTED
      else if (SECRET_KEY.test(key) || (depth > 0 && (reference || JSON_TEXT_SECRET_KEY.test(key))))
        out[outputKey] = redactSecretField(item)
      else if (depth === 0 && URL_KEY.test(key) && typeof item === 'string')
        out[outputKey] = redactTextValue(stripUrl(item), depth)
      else out[outputKey] = redactValue(item, seen, depth)
    }
    return { ...out }
  } finally {
    seen.delete(value)
  }
}

/** Recursively redacts secrets from an arbitrary JSON-shaped diagnostics value. Never throws. */
export function redactDiagnostic<T>(value: T): T {
  return redactValue(value, new WeakSet(), 0) as T
}
