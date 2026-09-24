import { createHash } from 'node:crypto'
import type { ResolvedDeployment } from '@agnes/host'
import { inspectJsonData, jcs } from '@agnes/protocol'
import { type SurfaceHeaders, safeSurfaceContent, surfaceSecurityHeaders } from './security-headers.js'
import { mountMatches } from './types.js'

export const FORGED_IDENTITY_KEYS = new Set([
  'actor',
  'actorid',
  'auth',
  'authorization',
  'credential',
  'credentialid',
  'credentials',
  'principal',
  'principalid',
  'sourceauth',
  'sourceid',
  'subject',
  'subjectid',
])
const SECRET_RESPONSE_KEYS = new Set([
  ...FORGED_IDENTITY_KEYS,
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'token',
])
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
  'x-request-id',
])
const RESPONSE_FRAMING_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const UNTRUSTED_REPRESENTATION_HEADERS = new Set([
  'accept-ranges',
  'content-digest',
  'content-encoding',
  'content-md5',
  'content-range',
  'digest',
  'etag',
  'last-modified',
  'repr-digest',
  'want-content-digest',
  'want-repr-digest',
])
const MAX_BODY_BYTES = 1024 * 1024
export const DEFAULT_SURFACE_RESPONSE_BODY_BYTES = 1024 * 1024

type ResolvedSurface = ResolvedDeployment['surfaces'][number]

export type SurfaceRouteRequest = Readonly<{
  method: string
  url: string
  headers?: Readonly<Record<string, string | undefined>>
  body?: unknown
}>

export type SurfaceRouteResponse = Readonly<{
  status: number
  headers: SurfaceHeaders
  body: string
}>

export type PortalSubject = Readonly<{
  /** Stable login-session identity. Connections are never shared across this boundary. */
  sessionId: string
  subjectId: string
  credential: unknown
}>

export type SurfaceRelayRequest = Readonly<{
  method: string
  path: string
  headers: SurfaceHeaders
  body?: unknown
  signal: AbortSignal
}>

export type SurfaceRelayResponse = Readonly<{
  status: number
  headers?: SurfaceHeaders
  body?: unknown
}>

/** Node-only SDK relay shape; F5 deliberately does not add or import an SDK implementation. */
export type SurfaceRelay = {
  request(request: SurfaceRelayRequest): Promise<SurfaceRelayResponse>
  close?(): Promise<void> | void
}

export type SurfaceConnectionFactory = (binding: {
  sourceId: string
  /** Authenticated Portal login-session binding; relays must not derive it from browser input. */
  sessionId: string
  subjectId: string
  subjectCredential: unknown
  grants: ResolvedSurface['instance']['grants']
  signal: AbortSignal
}) => Promise<SurfaceRelay>

/** A complete snapshot of every secret value leased to this Surface route boundary. */
export type SurfaceSecretRedactionLease = Readonly<{
  complete: true
  values: readonly string[]
}>

export type SurfaceRoutes = {
  handle(request: SurfaceRouteRequest): Promise<SurfaceRouteResponse>
  closeSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

type Connection = {
  sessionId: string
  subjectId: string
  relay: SurfaceRelay
}

type ConnectionEntry = {
  key: string
  generation: number
  sessionId: string
  subjectId: string
  credentialFingerprint: string
  abort: AbortController
  connection: Promise<Connection>
  relay?: SurfaceRelay
  invalidCode?: 'unauthorized' | 'surface_unavailable'
  closePromise?: Promise<void>
}

export function createSurfaceRoutes(options: {
  deployment: ResolvedDeployment
  resolveSubject(request: SurfaceRouteRequest): Promise<PortalSubject | null>
  connectionFactory: SurfaceConnectionFactory
  secretLease: SurfaceSecretRedactionLease
  sanitizeHtml?: (html: string) => string
  maxBodyBytes?: number
  maxResponseBodyBytes?: number
}): SurfaceRoutes {
  if (options.secretLease?.complete !== true || !validSecretValues(options.secretLease.values)) {
    throw new Error('A complete Surface secret redaction lease is required')
  }
  const redactValues = [...options.secretLease.values]
  const maxResponseBodyBytes = options.maxResponseBodyBytes ?? DEFAULT_SURFACE_RESPONSE_BODY_BYTES
  if (!Number.isSafeInteger(maxResponseBodyBytes) || maxResponseBodyBytes < 1) {
    throw new Error('Surface response body limit must be a positive safe integer')
  }
  const surfaces = [...options.deployment.surfaces]
  const connections = new Map<string, ConnectionEntry>()
  let generation = 0
  let closed = false

  async function handle(request: SurfaceRouteRequest): Promise<SurfaceRouteResponse> {
    if (closed) return errorResponse(503, 'surface_unavailable', redactValues)
    const target = routeTarget(request.url, surfaces)
    if (target === 'unsafe') return errorResponse(400, 'bad_request', redactValues)
    if (target === null) return errorResponse(404, 'not_found', redactValues)
    if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/i.test(request.method))
      return errorResponse(405, 'method_not_allowed', redactValues)
    if (byteLength(request.body) > (options.maxBodyBytes ?? MAX_BODY_BYTES))
      return errorResponse(413, 'payload_too_large', redactValues)

    // Capture arrival order before the asynchronous identity lookup. A slow request carrying an older
    // credential must not wake later and replace a newer connection that has already been installed.
    const requestGeneration = ++generation
    let subject: PortalSubject | null
    try {
      subject = await options.resolveSubject(request)
    } catch {
      return errorResponse(401, 'unauthorized', redactValues)
    }
    if (!validSubject(subject) || closed) return errorResponse(401, 'unauthorized', redactValues)
    const key = `${target.surface.instance.sourceId}\0${subject.sessionId}`
    const fingerprint = credentialFingerprint(subject.credential)
    if (fingerprint === null) {
      const existing = connections.get(key)
      if (existing !== undefined) invalidateEntry(existing, 'unauthorized')
      return errorResponse(401, 'unauthorized', redactValues)
    }

    let entry = connections.get(key)
    if (entry !== undefined && entry.subjectId !== subject.subjectId) {
      invalidateEntry(entry, 'unauthorized')
      return errorResponse(401, 'unauthorized', redactValues)
    }
    if (entry !== undefined && entry.credentialFingerprint !== fingerprint) {
      if (entry.generation > requestGeneration) return errorResponse(401, 'unauthorized', redactValues)
      // A refreshed/replaced credential is a new authenticated connection even when the Portal keeps
      // the same login-session and subject ids. Keeping the old initialized relay here would let an
      // expired or downgraded credential retain its original daemon authority indefinitely.
      invalidateEntry(entry, 'unauthorized')
      entry = undefined
    }
    if (entry === undefined) {
      const abort = new AbortController()
      const newEntry: ConnectionEntry = {
        key,
        generation: requestGeneration,
        sessionId: subject.sessionId,
        subjectId: subject.subjectId,
        credentialFingerprint: fingerprint,
        abort,
        connection: undefined as never,
      }
      newEntry.connection = Promise.resolve()
        .then(() =>
          options.connectionFactory({
            sourceId: target.surface.instance.sourceId,
            sessionId: subject.sessionId,
            subjectId: subject.subjectId,
            subjectCredential: subject.credential,
            grants: target.surface.instance.grants,
            signal: abort.signal,
          }),
        )
        .then(async (relay) => {
          newEntry.relay = relay
          if (!isCurrent(newEntry)) {
            await closeRelayOnce(newEntry)
            throw new Error('stale Surface connection')
          }
          return { sessionId: subject.sessionId, subjectId: subject.subjectId, relay }
        })
      entry = newEntry
      connections.set(key, newEntry)
    }
    let connection: Connection
    try {
      connection = await entry.connection
    } catch {
      if (connections.get(key) === entry) connections.delete(key)
      return errorResponse(
        entry.invalidCode === 'unauthorized' ? 401 : 502,
        entry.invalidCode ?? 'surface_unavailable',
        redactValues,
      )
    }

    if (!isCurrent(entry))
      return errorResponse(
        entry.invalidCode === 'unauthorized' ? 401 : 503,
        entry.invalidCode ?? 'surface_unavailable',
        redactValues,
      )

    try {
      const forwardedBody = requestBody(request.body, request.headers)
      if (forwardedBody === INVALID_BODY) return errorResponse(400, 'bad_request', redactValues)
      const upstream = await connection.relay.request({
        method: request.method.toUpperCase(),
        path: target.path,
        headers: requestHeaders(request.headers),
        ...(forwardedBody === undefined ? {} : { body: forwardedBody }),
        signal: entry.abort.signal,
      })
      if (!isCurrent(entry))
        return errorResponse(
          entry.invalidCode === 'unauthorized' ? 401 : 503,
          entry.invalidCode ?? 'surface_unavailable',
          redactValues,
        )
      return responseFor(upstream, target.surface.instance.mount, options, redactValues, maxResponseBodyBytes)
    } catch {
      invalidateEntry(entry, entry.invalidCode ?? 'surface_unavailable')
      return errorResponse(
        entry.invalidCode === 'unauthorized' ? 401 : 502,
        entry.invalidCode ?? 'surface_unavailable',
        redactValues,
      )
    }
  }

  function isCurrent(entry: ConnectionEntry): boolean {
    const current = connections.get(entry.key)
    return (
      !closed && !entry.abort.signal.aborted && current === entry && current.generation === entry.generation
    )
  }

  function invalidateEntry(entry: ConnectionEntry, code: 'unauthorized' | 'surface_unavailable'): void {
    entry.invalidCode ??= code
    if (connections.get(entry.key) === entry) connections.delete(entry.key)
    entry.abort.abort()
    void closeEntry(entry)
  }

  return {
    handle,
    async closeSession(sessionId) {
      const closing: Promise<void>[] = []
      for (const [key, entry] of connections) {
        if (entry.sessionId !== sessionId) continue
        connections.delete(key)
        invalidateEntry(entry, 'unauthorized')
        if (entry.relay !== undefined) closing.push(closeEntry(entry))
      }
      await Promise.allSettled(closing)
    },
    async close() {
      closed = true
      const entries = [...connections.values()]
      connections.clear()
      for (const entry of entries) invalidateEntry(entry, 'surface_unavailable')
      await Promise.allSettled(entries.filter((entry) => entry.relay !== undefined).map(closeEntry))
    },
  }
}

const INVALID_BODY = Symbol('invalid surface request body')

function requestBody(value: unknown, headers: SurfaceRouteRequest['headers']): unknown | typeof INVALID_BODY {
  const contentType = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1]
  if (
    typeof value === 'string' &&
    contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  ) {
    try {
      return stripIdentity(JSON.parse(value))
    } catch {
      return INVALID_BODY
    }
  }
  return stripIdentity(value)
}

function routeTarget(
  input: string,
  surfaces: ResolvedSurface[],
): { surface: ResolvedSurface; path: string } | 'unsafe' | null {
  if (!input.startsWith('/') || input.startsWith('//') || /[\\\0\r\n]/.test(input)) return 'unsafe'
  const queryAt = input.indexOf('?')
  const rawPath = queryAt < 0 ? input : input.slice(0, queryAt)
  const query = queryAt < 0 ? '' : input.slice(queryAt)
  if (/#/.test(query) || stableDecode(query, true) === null) return 'unsafe'
  const path = stableDecode(rawPath, false)
  if (path === null || /[\\\0\r\n]/.test(path) || path.includes('//')) return 'unsafe'
  const segments = path.split('/')
  if (
    segments.some((segment) => segment === '.' || segment === '..') ||
    path === '/_agnes/v1' ||
    path.startsWith('/_agnes/v1/') ||
    path.includes('/_agnes/v1/') ||
    path.endsWith('/_agnes/v1')
  )
    return 'unsafe'
  // I3 (final review, Important): shared match predicate with mount-proxy.ts's `matchMount` (see
  // `mountMatches`'s own doc in types.ts for why the predicate is shared but not the whole
  // table-lookup -- this table's shape, `ResolvedSurface[]` with `mount` nested under
  // `.instance.mount`, differs from mount-proxy.ts's `{mount, host, port}[]`).
  const surface = surfaces.find(({ instance }) => mountMatches(instance.mount, path))
  if (surface === undefined) return null
  const suffix = path.slice(surface.instance.mount.length) || '/'
  return { surface, path: `${suffix}${query}` }
}

function validSubject(subject: PortalSubject | null): subject is PortalSubject {
  return (
    subject !== null &&
    subject.sessionId.length > 0 &&
    subject.sessionId.length <= 256 &&
    subject.subjectId.length > 0 &&
    subject.subjectId.length <= 256 &&
    subject.credential !== undefined &&
    subject.credential !== null
  )
}

/** Compare credential generations without retaining or exposing the credential bytes themselves. */
function credentialFingerprint(value: unknown): string | null {
  const inspected = inspectJsonData(value, 65_536)
  if (!inspected.ok) return null
  return createHash('sha256')
    .update('agnes-surface-credential-v1\0')
    .update(jcs(inspected.value))
    .digest('hex')
}

function stripIdentity(value: unknown, depth = 0): unknown {
  if (depth > 64) return null
  if (Array.isArray(value)) return value.map((item) => stripIdentity(item, depth + 1))
  if (!plainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !FORGED_IDENTITY_KEYS.has(normalizeKey(key)))
      .map(([key, item]) => [key, stripIdentity(item, depth + 1)]),
  )
}

function sanitizeResponse(value: unknown, redactValues: readonly string[], depth = 0): unknown {
  if (depth > 64) return null
  if (typeof value === 'string') return redact(value, redactValues)
  if (typeof value === 'number' || typeof value === 'boolean') {
    const serialized = String(value)
    const sanitized = redact(serialized, redactValues)
    return sanitized === serialized ? value : sanitized
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeResponse(item, redactValues, depth + 1))
  if (!plainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_RESPONSE_KEYS.has(normalizeKey(key)))
      .map(([key, item]) => [redact(key, redactValues), sanitizeResponse(item, redactValues, depth + 1)]),
  )
}

function responseFor(
  response: SurfaceRelayResponse,
  mount: string,
  options: { sanitizeHtml?: (html: string) => string },
  redactValues: readonly string[],
  maxBodyBytes: number,
): SurfaceRouteResponse {
  if (!jsonBodyWithinLimit(response.body, maxBodyBytes))
    return errorResponse(502, 'response_too_large', redactValues)
  const status =
    Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : 502
  const headers = responseHeaders(response.headers, redactValues)
  const location = headers.location
  if (location !== undefined && !safeRedirect(location, mount))
    return errorResponse(502, 'unsafe_redirect', redactValues)
  const sanitized = sanitizeResponse(response.body, redactValues)
  const content = safeSurfaceContent(sanitized, headers['content-type'], {
    ...(options.sanitizeHtml === undefined ? {} : { sanitizeHtml: options.sanitizeHtml }),
  })
  if (Buffer.byteLength(content.body) > maxBodyBytes)
    return errorResponse(502, 'response_too_large', redactValues)
  headers['content-type'] = content.contentType
  return { status, headers: surfaceSecurityHeaders(headers), body: content.body }
}

function requestHeaders(input: SurfaceRouteRequest['headers']): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input ?? {})) {
    const lower = name.toLowerCase()
    if (value !== undefined && FORWARDED_REQUEST_HEADERS.has(lower) && !/[\r\n\0]/.test(value))
      output[lower] = value
  }
  return output
}

function responseHeaders(
  input: SurfaceHeaders | undefined,
  redactValues: readonly string[],
): Record<string, string> {
  const output: Record<string, string> = {}
  const dynamicHopByHop = new Set<string>()
  for (const [name, value] of Object.entries(input ?? {})) {
    if (name.toLowerCase() !== 'connection') continue
    for (const token of value.split(',')) {
      const lower = token.trim().toLowerCase()
      if (/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower)) dynamicHopByHop.add(lower)
    }
  }
  for (const [name, value] of Object.entries(input ?? {})) {
    const lower = name.toLowerCase()
    if (
      redact(lower, redactValues) === lower &&
      !/[\r\n\0]/.test(value) &&
      !RESPONSE_FRAMING_HEADERS.has(lower) &&
      !UNTRUSTED_REPRESENTATION_HEADERS.has(lower) &&
      !dynamicHopByHop.has(lower) &&
      !['authorization', 'refresh', 'server', 'set-cookie', 'www-authenticate'].includes(lower) &&
      !lower.startsWith('x-agnes-')
    )
      output[lower] = redact(value, redactValues)
  }
  return output
}

function safeRedirect(location: string, mount: string): boolean {
  if (!location.startsWith('/') || location.startsWith('//')) return false
  const target = routeTarget(location, [{ instance: { mount } } as ResolvedSurface])
  return target !== null && target !== 'unsafe'
}

function errorResponse(status: number, code: string, redactValues: readonly string[]): SurfaceRouteResponse {
  return {
    status,
    headers: surfaceSecurityHeaders({ 'content-type': 'application/json; charset=utf-8' }),
    body: redact(JSON.stringify({ error: { code } }), redactValues),
  }
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null))
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Exported so callers matching against FORGED_IDENTITY_KEYS outside this module (e.g. the Surface
 * mount proxy, which filters HTTP header names rather than JSON body keys) use the exact same
 * case/punctuation normalization instead of assuming a plain toLowerCase() is equivalent -- it is not,
 * since this also strips non-alphanumeric characters (so e.g. a `Source-Auth` header normalizes to
 * `sourceauth`, matching the set, where a bare toLowerCase() would not). */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function redact(value: string, secrets: readonly string[]): string {
  let cursor = 0
  let output = ''
  while (cursor < value.length) {
    let nextIndex = -1
    let nextSecret = ''
    for (const secret of secrets) {
      const index = value.indexOf(secret, cursor)
      if (
        index >= 0 &&
        (nextIndex < 0 || index < nextIndex || (index === nextIndex && secret.length > nextSecret.length))
      ) {
        nextIndex = index
        nextSecret = secret
      }
    }
    if (nextIndex < 0) return output + value.slice(cursor)
    output += `${value.slice(cursor, nextIndex)}[REDACTED]`
    cursor = nextIndex + nextSecret.length
  }
  return output
}

function jsonBodyWithinLimit(value: unknown, limit: number): boolean {
  const seen = new WeakSet<object>()
  let size = 0
  const add = (bytes: number): boolean => {
    size += bytes
    return size <= limit
  }
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 64) return false
    if (item === null || item === undefined) return add(4)
    if (typeof item === 'string') return add(jsonStringBytes(item))
    if (typeof item === 'boolean') return add(item ? 4 : 5)
    if (typeof item === 'number') {
      const encoded = Number.isFinite(item) ? String(item) : 'null'
      return add(Buffer.byteLength(encoded))
    }
    if (Array.isArray(item)) {
      if (seen.has(item) || !add(2)) return false
      seen.add(item)
      for (let index = 0; index < item.length; index += 1) {
        if (index > 0 && !add(1)) return false
        if (!visit(item[index], depth + 1)) return false
      }
      return true
    }
    if (plainObject(item)) {
      if (seen.has(item) || !add(2)) return false
      seen.add(item)
      let first = true
      for (const [key, nested] of Object.entries(item)) {
        if (!first && !add(1)) return false
        first = false
        if (!add(jsonStringBytes(key) + 1) || !visit(nested, depth + 1)) return false
      }
      return true
    }
    return false
  }
  return visit(value, 0)
}

function jsonStringBytes(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2
    } else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff && !validSurrogatePair(value, index))) {
      bytes += 6
    } else if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

function validSurrogatePair(value: string, index: number): boolean {
  const code = value.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1)
    return next >= 0xdc00 && next <= 0xdfff
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = value.charCodeAt(index - 1)
    return previous >= 0xd800 && previous <= 0xdbff
  }
  return true
}

function validSecretValues(values: readonly string[] | undefined): values is readonly string[] {
  return Array.isArray(values) && values.every((value) => typeof value === 'string' && value.length > 0)
}

function stableDecode(value: string, query: boolean): string | null {
  let current = value
  for (let pass = 0; pass < 8; pass += 1) {
    if (/%(?:00|0a|0d|2e|2f|5c)/i.test(current)) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return null
    }
    if (/[\\\0\r\n]/.test(decoded) || (!query && decoded.includes('//'))) return null
    if (decoded === current) return decoded
    current = decoded
  }
  return null
}

async function closeRelay(relay: SurfaceRelay): Promise<void> {
  try {
    await relay.close?.()
  } catch {
    // Closing one subject-bound relay must not retain or expose it through a failed cleanup path.
  }
}

async function closeEntry(entry: ConnectionEntry): Promise<void> {
  if (entry.relay !== undefined) return closeRelayOnce(entry)
  void entry.connection.then(() => closeRelayOnce(entry)).catch(() => undefined)
}

async function closeRelayOnce(entry: ConnectionEntry): Promise<void> {
  if (entry.relay === undefined) return
  entry.closePromise ??= closeRelay(entry.relay)
  await entry.closePromise
}
