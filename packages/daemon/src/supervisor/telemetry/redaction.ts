import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { REFINEMENT_SERVICE } from '@agnes/distribution/refinement-model'
import { DEFAULT_RULES, looksLikeSecret, redactText } from '@agnes/error-sanitization'
import type { ConfigAccount, EventEnvelope } from '@agnes/protocol'
import { type RouteProvider, telemetryModel, telemetryRoute } from './routes.js'
import { record, telemetryHash } from './wire.js'

const KiB = 1024
const SECRET_FIELD =
  /^(?:api[-_]?keys?|access[-_]?tokens?|refresh[-_]?tokens?|token|authorization|cookie|set-cookie|password|credential(?:ref)?|secret(?:key)?|private[-_]?key|client[-_]?secret|headers)$/i
const PRIVATE_FIELD =
  /^(?:account[-_]?id|account[-_]?label|base[-_]?url|endpoint(?:[-_]?host|[-_]?url)?|provider[-_]?url)$/i
const BINARY = new Set(['image', 'audio', 'file', 'base64', 'binary', 'blob'])
const CORRELATION_FIELD =
  /^(?:effect|effect[-_]?id|parent[-_]?effect[-_]?id|request[-_]?id|tool[-_]?use[-_]?id|tool[-_]?call[-_]?id|call[-_]?id)$/i
const LEDGER_ID = /^(?:e|r|t\d+)-[a-f0-9]{32}$/i
const pseudonym = (installId: string, value: string) => `id_${telemetryHash(installId, value).slice(0, 24)}`

function modelId(
  accounts: readonly ConfigAccount[],
  credentials: readonly string[],
  route: string,
  model: string,
) {
  if (credentials.some((value) => value === model || (value.length >= 12 && model.includes(value))))
    return 'custom'
  return telemetryModel(telemetryRoute(accounts, route), model, accounts)
}

function truncate(text: string): string {
  const size = Buffer.byteLength(text)
  if (size <= 256 * KiB) return text
  const bytes = Buffer.from(text)
  // Move cut points to UTF-8 character boundaries.
  let head = 192 * KiB
  let tail = size - 64 * KiB
  while (((bytes[head] ?? 0) & 0xc0) === 0x80) head--
  while (((bytes[tail] ?? 0) & 0xc0) === 0x80) tail++
  return `${bytes.subarray(0, head).toString()}\n...[truncated ${tail - head} bytes]...\n${bytes.subarray(tail).toString()}`
}

function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function binarySummary(data: string | Uint8Array, mime: unknown) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : data
  const safeMime =
    typeof mime === 'string' && /^[a-z\d.+-]{1,40}\/[a-z\d.+-]{1,80}$/i.test(mime)
      ? mime
      : 'application/octet-stream'
  return {
    data: `[omitted-binary mime=${safeMime} bytes=${bytes.byteLength}]`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

// Credentials that carry no vendor shape are recognised by what names them. A name qualifies when
// one of its segments (split on separators and camelCase) is a credential word, when two adjacent
// segments spell a credential pair, or when an unsegmented name ends in a long credential word.
// Segments rather than substrings keep `author`, `passport`, `bypass`, `max_tokens` and `tokenizer`.
const CREDENTIAL_SEGMENT = new Set([
  'pass',
  'passwd',
  'password',
  'pwd',
  'secret',
  'token',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'apikey',
  'accesskey',
  'privatekey',
])
const CREDENTIAL_PAIR = new Set(['api key', 'access key', 'private key'])
const CREDENTIAL_SUFFIX = /(?:password|passwd|secret|token|credentials?|apikey|accesskey|privatekey)$/
const CREDENTIAL_HINT = /pass|pwd|secret|token|key|credential|auth/i
// `NAME=value`, `NAME: value`, `NAME := value` and the quoted JSON or YAML spelling. Horizontal
// whitespace only, so a YAML key that opens a block never borrows the next line as its value; a
// bounded quoted value keeps an unclosed quote from rescanning the rest of a long line.
const ASSIGNMENT =
  /(?<![\w.-])(\\?["']?)([A-Za-z_][\w.-]{0,63})\1([ \t]*:?=(?![=>])[ \t]*|[ \t]*:(?![:/])[ \t]*)(?:(\\?["'])([^\r\n]{0,4096}?)\4|([^\s"',;\\]+))/g
// A header value is every scheme and parameter after the colon, `Token abc` and `Digest a="b"`
// alike: to the quote that opened a quoted header (`curl -H "..."`), otherwise to the end of line.
// A quoted JSON name is left to ASSIGNMENT, which knows where its quoted value ends.
const QUOTED_AUTHORIZATION = /(["'])((?:proxy-)?authorization[ \t]*:[ \t]*)[^\r\n]*?(?=\1)/gi
const AUTHORIZATION = /(?<![\w"'-])((?:proxy-)?authorization[ \t]*:[ \t]*)[^\r\n]+/gi
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@/gi
const PRIVATE_KEY =
  /(?:-----BEGIN [^\r\n-]*PRIVATE KEY-----)[\s\S]*?(?:-----END [^\r\n-]*PRIVATE KEY-----|$)/g
// AWS secret access keys are exactly forty base64 characters and often contain `/` or `+`, which
// split them below the generic opaque-run threshold. A path segment never starts the match because
// the run may not follow `/`, and requiring digits and both cases leaves words and hex alone.
const AWS_SECRET = /(^|[^A-Za-z0-9/+=])([A-Za-z0-9+][A-Za-z0-9/+]{38}[A-Za-z0-9+])(?![A-Za-z0-9/+=])/g

function credentialName(name: string): boolean {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean)
  return (
    segments.some(
      (segment, index) =>
        CREDENTIAL_SEGMENT.has(segment) || CREDENTIAL_PAIR.has(`${segment} ${segments[index + 1]}`),
    ) ||
    (segments.length === 1 && CREDENTIAL_SUFFIX.test(segments[0] ?? ''))
  )
}

/** Remove credential values that have no vendor prefix, keeping the text around them readable. */
function scrubCredentials(text: string): string {
  let clean = text
    .replace(PRIVATE_KEY, '<redacted>')
    .replace(QUOTED_AUTHORIZATION, '$1$2<redacted>')
    .replace(AUTHORIZATION, '$1<redacted>')
    .replace(/\b(?:bearer|basic)\s+[^\s"',;<>]+/gi, '<redacted>')
  if (clean.includes('://')) clean = clean.replace(URL_USERINFO, '$1<redacted>@')
  if (CREDENTIAL_HINT.test(clean))
    clean = clean.replace(
      ASSIGNMENT,
      (match, open: string, name: string, separator: string, quote?: string, quoted?: string) => {
        if (!credentialName(name) || quoted === '' || match.endsWith('<redacted>')) return match
        return `${open}${name}${open}${separator}${quote ? `${quote}<redacted>${quote}` : '<redacted>'}`
      },
    )
  return clean.replace(AWS_SECRET, (match, lead: string, run: string) =>
    /[0-9]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) ? `${lead}<redacted>` : match,
  )
}

function pathSpellings(path: string): string[] {
  const spellings = [path, path.replaceAll('\\', '/'), path.replaceAll('\\', '\\\\')]
  // Darwin realpath exposes the /private targets of these system symlinks. Prompts and tool
  // arguments frequently contain the shorter, user-visible spelling.
  if (/^\/private\/(?:var|tmp|etc)(?:\/|$)/.test(path)) spellings.push(path.slice('/private'.length))
  if (/^\/(?:var|tmp|etc)(?:\/|$)/.test(path)) spellings.push(`/private${path}`)
  return spellings
}

export function traceRedaction(options: {
  installId: string
  accounts: readonly ConfigAccount[]
  privatePaths: readonly string[]
  workspacePaths: readonly string[]
  sessionKeys: readonly string[]
  credentialValues: readonly string[]
}) {
  const { installId, accounts } = options
  const aliases = new Map<string, string>()
  const sessionId = (key: string) => `agn_${telemetryHash(installId, key).slice(0, 24)}`
  for (const key of options.sessionKeys) if (key) aliases.set(key, sessionId(key))
  for (const row of accounts) {
    if (row.accountId) aliases.set(row.accountId, '<redacted>')
    if (row.label) aliases.set(row.label, '<redacted>')
    if (row.baseUrl) aliases.set(row.baseUrl.replace(/\/+$/, ''), '<redacted>')
    try {
      aliases.set(new URL(row.baseUrl).host, '<redacted>')
    } catch {
      // The raw spelling above still covers an invalid URL.
    }
  }
  for (const value of options.credentialValues) if (value) aliases.set(value, '<redacted>')
  const paths = new Map<string, string>()
  for (const [roots, replacement] of [
    [options.privatePaths, '<agh_home>'],
    [options.workspacePaths, '<workspace>'],
  ] as const)
    for (const root of roots) {
      if (!(isAbsolute(root) || win32.isAbsolute(root))) continue
      const normalized = root.replace(/[\\/]+$/, '')
      if (normalized.length < 3) continue
      for (const spelling of pathSpellings(normalized))
        if (!paths.has(spelling)) paths.set(spelling, replacement)
    }
  const ordered = (values: Iterable<string>) => [...values].sort((a, b) => b.length - a.length)
  const aliasPattern = ordered(aliases.keys())
    .filter(Boolean)
    .map((value) => {
      const pattern = literal(value)
      return /^[a-z0-9]/i.test(value) && /[a-z0-9]$/i.test(value)
        ? `(?<![a-z0-9])${pattern}(?![a-z0-9])`
        : pattern
    })
    .join('|')
  const pathPattern = ordered(paths.keys()).map(literal).join('|')
  const replacements = new RegExp(
    `account-[a-z0-9][a-z0-9-]{0,63}(?![a-z0-9-])${aliasPattern ? `|${aliasPattern}` : ''}${pathPattern ? `|${pathPattern}` : ''}`,
    'gi',
  )
  const normalized = new Map(
    [...aliases, ...paths].map(([value, replacement]) => [value.toLowerCase(), replacement]),
  )
  let routes = new Map<string, RouteProvider>()
  function route(raw: string): string {
    const provider = telemetryRoute(accounts, raw)
    if (!raw.startsWith('account-')) {
      const publicRoute = raw === provider.provider_id || raw === REFINEMENT_SERVICE.route
      if (!PROVIDER_ROUTE.test(raw) || !publicRoute) return 'other'
      routes.set(raw, provider)
      return raw
    }
    const key = `account-${telemetryHash(installId, raw).slice(0, 8)}`
    routes.set(key, provider)
    return key
  }

  function scrub(text: string) {
    const clean = scrubCredentials(
      text.replace(replacements, (match) =>
        match.toLowerCase().startsWith('account-')
          ? route(match.toLowerCase())
          : (normalized.get(match.toLowerCase()) ?? '<redacted>'),
      ),
    ).replace(/(?:\/Users\/|\/home\/|[a-z]:[\\/]Users[\\/])[^\\/\s"'<>]+/gi, '<agh_home>')
    const result = redactText(clean, { ...DEFAULT_RULES, paths: false }).text.replace(
      /\[REDACTED:[^\]]+\]/g,
      '<redacted>',
    )
    return truncate(looksLikeSecret(result) ? '<redacted>' : result)
  }

  function copy(value: unknown, routeHint?: string): unknown {
    if (typeof value === 'string') {
      if (/^data:[^,\r\n]*;base64,/i.test(value)) {
        const end = value.indexOf(',')
        return binarySummary(value.slice(end + 1), value.slice(5, end - 7)).data
      }
      return scrub(value)
    }
    if (value instanceof Uint8Array) return binarySummary(value, undefined)
    if (Array.isArray(value)) return value.map((item) => copy(item, routeHint))
    if (value === null || typeof value !== 'object') return value
    const fields = record(value)
    const rawRoute = typeof fields.route === 'string' ? fields.route : routeHint
    const isBinary =
      BINARY.has(String(fields.type)) || fields.encoding === 'base64' || typeof fields.mimeType === 'string'
    const binary =
      isBinary && (typeof fields.data === 'string' || fields.data instanceof Uint8Array)
        ? binarySummary(fields.data, fields.mimeType ?? fields.media_type)
        : undefined
    const result = Object.fromEntries(
      Object.entries(fields).map(([key, item]) => {
        if (SECRET_FIELD.test(key) || PRIVATE_FIELD.test(key) || key === '_meta') return [key, '<redacted>']
        if (key === 'data' && binary) return [key, binary.data]
        if (key === 'route' && typeof item === 'string') return [key, route(item)]
        if (
          ['sessionId', 'sessionKey', 'parentSessionId', 'rootTaskId'].includes(key) &&
          typeof item === 'string'
        )
          return [key, sessionId(item)]
        if (['actor', 'sourceId'].includes(key) && typeof item === 'string')
          return [key, telemetryHash(installId, item).slice(0, 24)]
        if (key === 'model' && typeof item === 'string' && rawRoute)
          return [key, modelId(accounts, options.credentialValues, rawRoute, item)]
        if (key === 'id' && typeof item === 'string' && typeof fields.route === 'string')
          return [key, modelId(accounts, options.credentialValues, fields.route, item)]
        // Preserve joins without exposing opaque ledger identifiers as plaintext.
        if (
          typeof item === 'string' &&
          (CORRELATION_FIELD.test(key) || (key === 'id' && LEDGER_ID.test(item)))
        )
          return [key, pseudonym(installId, item)]
        return [scrub(key), copy(item, rawRoute)]
      }),
    )
    if (binary) result.sha256 = binary.sha256
    return result
  }

  return {
    sessionId,
    scrub,
    event(event: EventEnvelope, routeHint?: string) {
      routes = new Map()
      const data = copy(event.data, routeHint)
      return {
        row: {
          seq: event.seq,
          ts: event.ts,
          id: event.id,
          type:
            event.type.startsWith('x/') && scrub(event.type) !== event.type
              ? 'x/telemetry/redacted'
              : event.type,
          origin:
            event.origin.includes(':') && scrub(event.origin) !== event.origin ? 'system' : event.origin,
          trust: event.trust,
          data,
        },
        routes,
      }
    },
  }
}

const PROVIDER_ROUTE = /^[a-z][a-z0-9-]{0,63}$/
