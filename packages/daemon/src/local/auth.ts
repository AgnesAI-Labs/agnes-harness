import { createHash, createHmac, createPublicKey, verify as cryptoVerify, timingSafeEqual } from 'node:crypto'
import {
  type Auth,
  jcs,
  rpcError,
  type SurfaceServiceGrant,
  validateSurfaceServiceGrant,
} from '@agnes/protocol'
import type { CallContext, ConnectionState, Handler, LocalEndpoint } from './endpoint.js'

// Re-exported rather than reimplemented: protocol already ships a strict RFC 8785 serializer meant
// to be shared across packages that sign or verify bytes derived from it (see the comment at the top
// of packages/protocol/src/index.ts). A second, independently written canonicalizer here - even one
// that agrees on every test case - is exactly the kind of drift that turns into an unverifiable
// signature the day the two diverge on an edge case neither side's tests happen to cover.
export { jcs }

const HARNESS_META = 'ai.agnes.harness'

/**
 * The bytes an `initialize` call's source-auth signature actually covers: the method name, the
 * caller-declared clientId, and a hash of every param except the auth credential itself (which
 * cannot sign over its own bytes). Both signer and verifier must derive the identical string from
 * the identical params for a signature to mean anything.
 */
export function sourceAuthCanonical(clientId: string, params: Record<string, unknown>): string {
  const meta = params._meta as Record<string, Record<string, unknown>> | undefined
  const pocket = meta?.[HARNESS_META]
  const stripped = pocket
    ? {
        ...params,
        _meta: {
          ...meta,
          [HARNESS_META]: Object.fromEntries(Object.entries(pocket).filter(([k]) => k !== 'auth')),
        },
      }
    : params
  return `initialize\n${clientId}\n${createHash('sha256').update(jcs(stripped)).digest('hex')}`
}

/**
 * `nonce` is folded directly into the HMAC input, not carried alongside it as a parallel field
 * checked only at lookup time. A signature that does not cover the nonce is a signature over
 * (secret, timestamp, canonical) alone - anyone who observes one legitimate triple can replay it
 * under any nonce of their choosing, since nothing about the bytes actually signed changes.
 */
export function signSourceAuth(secret: string, timestamp: number, nonce: string, canonical: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${nonce}:${canonical}`).digest('hex')}`
}

export type NonceConsume = { consume(identityKey: string, nonce: string, now: number): boolean }

export function verifySourceAuth(o: {
  auth: { timestamp: number; signature: string; nonce: string }
  clientId: string
  params: Record<string, unknown>
  secrets: string[]
  keyIds?: string[]
  now: number
  nonces: NonceConsume
  skewMs?: number
}): { ok: true; secretIndex: number } | { ok: false; reason: 'skew' | 'nonce' | 'signature' | 'shape' } {
  const { auth } = o
  if (
    !Number.isInteger(auth.timestamp) ||
    !/^v0=[0-9a-f]{64}$/.test(auth.signature) ||
    !/^[0-9a-f]{32}$/.test(auth.nonce)
  )
    return { ok: false, reason: 'shape' }
  if (Math.abs(auth.timestamp * 1000 - o.now) > (o.skewMs ?? 300_000)) return { ok: false, reason: 'skew' }
  const canonical = sourceAuthCanonical(o.clientId, o.params)
  const given = Buffer.from(auth.signature)
  // nonces.consume() is called only once a secret has actually verified below - never before. A
  // request that names someone else's real, still-fresh nonce but carries a bad signature must not
  // be able to burn that nonce: checking the table first would let a forged request deny the
  // legitimate client its own next connection purely by guessing (or observing) its nonce value.
  for (const [secretIndex, s] of o.secrets.entries()) {
    const expect = Buffer.from(signSourceAuth(s, auth.timestamp, auth.nonce, canonical))
    if (expect.length === given.length && timingSafeEqual(expect, given)) {
      // Keep checking the legacy client-scoped namespace during migration, then establish the
      // authoritative key-scoped namespace. This prevents a nonce accepted before the identity-key
      // migration from becoming replayable once under the new schema.
      return o.nonces.consume(o.clientId, auth.nonce, o.now) &&
        o.nonces.consume(`source-key:${o.keyIds?.[secretIndex] ?? secretIndex}`, auth.nonce, o.now)
        ? { ok: true, secretIndex }
        : { ok: false, reason: 'nonce' }
    }
  }
  return { ok: false, reason: 'signature' }
}

export type AuthConfig = {
  transport: 'unix' | 'ws'
  /** Server-only grant after loopback bearer, Host and Origin validation; never from RPC input. */
  localWeb?: boolean
  jwt?: {
    issuer: string
    secret?: string
    jwks?: Array<{ kid?: string; kty: 'RSA' | 'EC' | 'oct'; [k: string]: unknown }>
    jwksUrl?: string
  }
  sourceAuthSecrets?: string[]
  sourceAuthKeys?: () => Array<{ secret: string; keyId: string }>
  /** Trusted deployment-derived Surface identities. A Surface authenticates twice: its source key
   * selects exactly one entry here, while its nested subject is verified by jwt/portal config. */
  surfaceSources?: () => ReadonlyArray<{
    sourceId: string
    keys: ReadonlyArray<{ secret: string; keyId: string }>
    grants: readonly SurfaceServiceGrant[]
  }>
  rotationGraceMs?: number
  portalSecret?: string
}

// Distinct from `@agnes/protocol`'s `Credential` (the wire shape a client may present as
// `_meta.auth`, oneOf jwt/source-auth/portal-identity/local): this is what a connection resolves
// TO after that credential is checked. It carries fields the wire shape does not (a decoded userId,
// portal attrs) and one kind the wire shape has no slot for at all ('sso', what a verified
// portal-identity token resolves to) - so it is its own type rather than a reuse of protocol's.
export type Credential =
  | { kind: 'local' }
  | { kind: 'jwt'; token: string; userId?: string }
  | { kind: 'sso'; userId: string; raw?: Record<string, string> }
  | {
      kind: 'channel'
      channel: string
      accountId: string
      userId: string
      chatId: string
      chatType: 'dm' | 'group' | 'thread'
    }

export type AuthOk = {
  ok: true
  authKind: 'local' | 'jwt' | 'source-auth' | 'portal-identity' | 'surface'
  credential: Credential
  sourceAuthKeyId?: string
  surface?: Readonly<{
    sourceId: string
    sourceAuthKeyId: string
    grants: readonly SurfaceServiceGrant[]
  }>
}
export type AuthResult = AuthOk | { ok: false; reason: string }

function b64uJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function verifyJwt(
  token: string,
  cfg: NonNullable<AuthConfig['jwt']>,
  nowMs: number,
): { ok: true; sub: string } | { ok: false; reason: string } {
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) return { ok: false, reason: 'shape' }
  const header = b64uJson(h)
  const payload = b64uJson(p)
  if (!header || !payload) return { ok: false, reason: 'shape' }
  const signed = Buffer.from(`${h}.${p}`)
  const sig = Buffer.from(s, 'base64url')
  if (header.alg === 'HS256') {
    if (!cfg.secret) return { ok: false, reason: 'alg' }
    const expect = createHmac('sha256', cfg.secret).update(signed).digest()
    if (expect.length !== sig.length || !timingSafeEqual(expect, sig))
      return { ok: false, reason: 'signature' }
  } else if (header.alg === 'RS256') {
    const candidates = (cfg.jwks ?? []).filter(
      (key) => key.kty === 'RSA' && (typeof header.kid === 'string' ? key.kid === header.kid : true),
    )
    if (candidates.length !== 1) return { ok: false, reason: 'kid' }
    try {
      if (
        !cryptoVerify('sha256', signed, createPublicKey({ key: candidates[0] as never, format: 'jwk' }), sig)
      )
        return { ok: false, reason: 'signature' }
    } catch {
      return { ok: false, reason: 'signature' }
    }
  } else return { ok: false, reason: 'alg' }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < nowMs) return { ok: false, reason: 'exp' }
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf * 1000 > nowMs))
    return { ok: false, reason: 'nbf' }
  if (payload.iss !== cfg.issuer) return { ok: false, reason: 'iss' }
  return { ok: true, sub: String(payload.sub ?? '') }
}

function verifyPortal(
  token: string,
  secret: string,
  nowMs: number,
): { ok: true; sub: string; attrs: Record<string, string> } | { ok: false; reason: string } {
  const shape = { ok: false, reason: 'shape' } as const
  const [p, mac, ...extra] = token.split('.')
  if (token.length > 8_192 || !p || !mac || extra.length > 0 || !/^[0-9a-f]{64}$/.test(mac)) return shape
  const payloadBytes = Buffer.from(p, 'base64url')
  if (payloadBytes.toString('base64url') !== p) return shape
  const exp = createHmac('sha256', secret).update(payloadBytes).digest('hex')
  if (!timingSafeEqual(Buffer.from(exp), Buffer.from(mac))) return { ok: false, reason: 'signature' }
  try {
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes))
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return shape
    const c = payload as Record<string, unknown>
    const a = c.attrs
    if (typeof c.sub !== 'string' || c.sub.length === 0) return shape
    if (!Number.isSafeInteger(c.exp) || (c.exp as number) <= 0) return shape
    if (!Object.keys(c).every((key) => key === 'sub' || key === 'exp' || key === 'attrs')) return shape
    if (a !== undefined && (a === null || typeof a !== 'object' || Array.isArray(a))) return shape
    if (a !== undefined && !Object.values(a).every((value) => typeof value === 'string')) return shape
    if ((c.exp as number) * 1000 <= nowMs) return { ok: false, reason: 'exp' }
    return { ok: true, sub: c.sub, attrs: (a ?? {}) as Record<string, string> }
  } catch {
    return shape
  }
}

export function verifyAuth(o: {
  auth: Auth | undefined
  clientId: string
  params: Record<string, unknown>
  config: AuthConfig
  now: number
  nonces: NonceConsume
}): AuthResult {
  const a = o.auth
  if (!a || a.kind === 'local')
    return o.config.transport === 'unix' || o.config.localWeb === true
      ? { ok: true, authKind: 'local', credential: { kind: 'local' } }
      : { ok: false, reason: 'local auth not accepted on ws' }
  if (a.kind === 'jwt') {
    if (!o.config.jwt) return { ok: false, reason: 'jwt not configured' }
    const r = verifyJwt(a.token, o.config.jwt, o.now)
    return r.ok && r.sub.length > 0
      ? {
          ok: true,
          authKind: 'jwt',
          credential: { kind: 'jwt', token: a.token, userId: r.sub },
        }
      : r.ok
        ? { ok: false, reason: 'sub' }
        : r
  }
  if (a.kind === 'portal-identity') {
    if (!o.config.portalSecret) return { ok: false, reason: 'portal not configured' }
    const r = verifyPortal(a.token, o.config.portalSecret, o.now)
    return r.ok
      ? {
          ok: true,
          authKind: 'portal-identity',
          credential: { kind: 'sso', userId: r.sub, raw: r.attrs },
        }
      : r
  }
  if (a.kind === 'source-auth') {
    // `sourceAuthSecrets` is the pre-keyring public configuration shape. Keep it usable for direct
    // LocalEndpoint/verifyAuth consumers while assigning non-secret, client-independent identities;
    // the supervisor composition path supplies persistent opaque ids through `sourceAuthKeys`.
    const keys =
      o.config.sourceAuthKeys?.() ??
      (o.config.sourceAuthSecrets ?? []).map((secret, index) => ({ secret, keyId: `legacy:${index}` }))
    const r = verifySourceAuth({
      auth: a,
      clientId: o.clientId,
      params: o.params,
      secrets: keys.map((key) => key.secret),
      keyIds: keys.map((key) => key.keyId),
      now: o.now,
      nonces: o.nonces,
    })
    const sourceAuthKeyId = r.ok ? keys[r.secretIndex]?.keyId : undefined
    return r.ok && sourceAuthKeyId
      ? {
          ok: true,
          authKind: 'source-auth',
          credential: {
            kind: 'channel',
            channel: 'surface',
            accountId: o.clientId,
            userId: o.clientId,
            chatId: '',
            chatType: 'dm',
          },
          sourceAuthKeyId,
        }
      : { ok: false, reason: r.ok ? 'verified source-auth key unavailable' : r.reason }
  }
  if (a.kind === 'surface') {
    const sources = o.config.surfaceSources?.().filter((source) => source.sourceId === a.sourceId) ?? []
    if (sources.length !== 1) return { ok: false, reason: 'surface source unavailable' }
    const configured = sources[0]
    if (!configured || configured.keys.length === 0)
      return { ok: false, reason: 'surface source unavailable' }
    if (!configured.grants.every((grant) => validateSurfaceServiceGrant(grant).ok))
      return { ok: false, reason: 'surface grants invalid' }
    const source = verifySourceAuth({
      auth: a.source,
      clientId: o.clientId,
      params: o.params,
      secrets: configured.keys.map((key) => key.secret),
      keyIds: configured.keys.map((key) => key.keyId),
      now: o.now,
      nonces: o.nonces,
    })
    const sourceAuthKeyId = source.ok ? configured.keys[source.secretIndex]?.keyId : undefined
    if (!source.ok || !sourceAuthKeyId)
      return { ok: false, reason: source.ok ? 'verified surface key unavailable' : source.reason }

    let credential: Credential
    if (a.subject.kind === 'jwt') {
      if (!o.config.jwt) return { ok: false, reason: 'jwt not configured' }
      const subject = verifyJwt(a.subject.token, o.config.jwt, o.now)
      if (!subject.ok) return subject
      if (!subject.sub) return { ok: false, reason: 'sub' }
      credential = { kind: 'jwt', token: a.subject.token, userId: subject.sub }
    } else {
      if (!o.config.portalSecret) return { ok: false, reason: 'portal not configured' }
      const subject = verifyPortal(a.subject.token, o.config.portalSecret, o.now)
      if (!subject.ok) return subject
      credential = { kind: 'sso', userId: subject.sub, raw: subject.attrs }
    }
    return {
      ok: true,
      authKind: 'surface',
      credential,
      sourceAuthKeyId,
      surface: Object.freeze({
        sourceId: configured.sourceId,
        sourceAuthKeyId,
        grants: Object.freeze(configured.grants.map((grant) => Object.freeze({ ...grant }))),
      }),
    }
  }
  return { ok: false, reason: 'unknown auth kind' }
}

/**
 * Wraps the `initialize` handler with credential verification. `params._meta['ai.agnes.harness']`
 * carries both the client-declared id and the credential; a missing or failing credential never
 * reaches the wrapped handler at all - the connection's `initialized` flag stays false and every
 * other method keeps refusing it as NOT_INITIALIZED.
 */
export function authGate(
  ep: LocalEndpoint,
  cx: { config: AuthConfig; nonces: NonceConsume; clock: () => number },
  inner: Handler,
): Handler {
  return async (params: unknown, c: CallContext): Promise<unknown> => {
    if (ep.conn.initialized) throw rpcError('INVALID_REQUEST', { code: 'ALREADY_INITIALIZED' })
    const meta = (params as { _meta?: Record<string, Record<string, unknown>> })._meta?.[HARNESS_META] ?? {}
    const clientId =
      typeof meta.clientId === 'string' ? meta.clientId : `anon-${Math.random().toString(36).slice(2)}`
    const r = verifyAuth({
      auth: meta.auth as Auth | undefined,
      clientId,
      params: params as Record<string, unknown>,
      config: cx.config,
      now: cx.clock(),
      nonces: cx.nonces,
    })
    if (!r.ok) throw rpcError('AUTH_INVALID', { reason: r.reason })
    const conn: ConnectionState = ep.conn
    if (r.authKind === 'jwt') {
      if (r.credential.kind !== 'jwt' || !r.credential.userId)
        throw rpcError('AUTH_INVALID', { reason: 'verified jwt subject unavailable' })
      ep.establishPrincipal(`jwt:${r.credential.userId}`)
    } else if (r.authKind === 'portal-identity') {
      if (r.credential.kind !== 'sso')
        throw rpcError('AUTH_INVALID', { reason: 'verified portal subject unavailable' })
      ep.establishPrincipal(`portal:${r.credential.userId}`)
    } else if (r.authKind === 'source-auth') {
      if (!r.sourceAuthKeyId)
        throw rpcError('AUTH_INVALID', { reason: 'verified source-auth key unavailable' })
      ep.establishPrincipal(`source-auth:${r.sourceAuthKeyId}`)
    } else if (r.authKind === 'surface') {
      if (!r.surface || (r.credential.kind !== 'jwt' && r.credential.kind !== 'sso'))
        throw rpcError('AUTH_INVALID', { reason: 'verified surface identity unavailable' })
      const subject =
        r.credential.kind === 'jwt' ? `jwt:${r.credential.userId}` : `portal:${r.credential.userId}`
      ep.establishPrincipal(`surface:${r.surface.sourceId}:${subject}`)
      conn.surface = r.surface
    }
    conn.clientId = clientId
    conn.authKind = r.authKind
    conn.credentialKind = r.credential.kind
    conn.credential = r.credential
    return inner(params, c)
  }
}
