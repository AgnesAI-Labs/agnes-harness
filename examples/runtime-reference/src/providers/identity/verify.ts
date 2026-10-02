import { webcrypto } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type SurfaceServiceGrant, validateSurfaceServiceGrant } from '@agnes/protocol'
import type {
  LegacyIdentityCredentialEnvelope,
  LegacyIdentityTransportEvidence,
} from '@agnes/protocol/runtime'

export type ReferenceCredential = Readonly<{
  authKind: 'local' | 'jwt' | 'source-auth' | 'portal-identity' | 'surface'
  credentialKind: 'local' | 'jwt' | 'sso' | 'channel'
  ownerClass: 'local-owner' | 'remote' | 'service'
  subject: string
  expiresAt: number
  sourceKeyId?: string
  sourceId?: string
  attributes?: Readonly<Record<string, string>>
  serviceGrants?: readonly SurfaceServiceGrant[]
  principalRef?: string
  credentialOwnerRef?: string
  credentialRevision?: number
}>
export type ReferenceVerification = Readonly<{
  now(): number
  generation: string
  jwt?: {
    issuer: string
    secret?: string
    keys?: readonly (webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string })[]
  }
  portalSecret?: string
  sourceKeys?: () => readonly { keyId: string; secret: string }[]
  surfaceSources?: () => readonly {
    sourceId: string
    keys: readonly { keyId: string; secret: string }[]
    grants: readonly SurfaceServiceGrant[]
  }[]
}>

function decoded(segment: string): Record<string, unknown> | null {
  try {
    const bytes = Buffer.from(segment, 'base64url')
    if (bytes.toString('base64url') !== segment) return null
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
async function mac(secret: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await webcrypto.subtle.importKey(
    'raw',
    Buffer.from(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return webcrypto.subtle.verify('HMAC', key, Buffer.from(signature), Buffer.from(message))
}
export async function referenceJwt(
  token: string,
  options: ReferenceVerification,
): Promise<ReferenceCredential | null> {
  const parts = token.split('.')
  const configuration = options.jwt
  if (!configuration || parts.length !== 3 || parts.some((part) => !part)) return null
  const [head = '', body = '', signature = ''] = parts
  const header = decoded(head)
  const payload = decoded(body)
  if (
    !header ||
    !payload ||
    header.crit !== undefined ||
    header.b64 === false ||
    (header.kid !== undefined && (typeof header.kid !== 'string' || !header.kid))
  )
    return null
  const bytes = Buffer.from(signature, 'base64url')
  if (bytes.toString('base64url') !== signature) return null
  const input = Buffer.from(`${head}.${body}`)
  let valid = false
  try {
    if (header.alg === 'HS256' && configuration.secret) valid = await mac(configuration.secret, input, bytes)
    if (header.alg === 'RS256') {
      const eligible = (configuration.keys ?? []).filter(
        (key) =>
          key.kty === 'RSA' &&
          (header.kid === undefined || key.kid === header.kid) &&
          (key.alg === undefined || key.alg === 'RS256') &&
          (key.use === undefined || key.use === 'sig'),
      )
      if (eligible.length !== 1 || !eligible[0]) return null
      const key = await webcrypto.subtle.importKey(
        'jwk',
        eligible[0],
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      valid = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes, input)
    }
  } catch {
    return null
  }
  if (
    !valid ||
    payload.iss !== configuration.issuer ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp * 1000) ||
    payload.exp * 1000 <= options.now() ||
    (payload.nbf !== undefined &&
      (typeof payload.nbf !== 'number' ||
        !Number.isFinite(payload.nbf) ||
        payload.nbf * 1000 > options.now()))
  )
    return null
  return {
    authKind: 'jwt',
    credentialKind: 'jwt',
    ownerClass: 'remote',
    subject: payload.sub,
    expiresAt: payload.exp * 1000,
  }
}
async function referencePortal(
  token: string,
  options: ReferenceVerification,
): Promise<ReferenceCredential | null> {
  const [body, signature, ...tail] = token.split('.')
  if (
    !body ||
    !signature ||
    tail.length ||
    token.length > 8192 ||
    !options.portalSecret ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return null
  const bytes = Buffer.from(body, 'base64url')
  if (
    bytes.toString('base64url') !== body ||
    !(await mac(options.portalSecret, bytes, Buffer.from(signature, 'hex')))
  )
    return null
  const payload = decoded(body)
  if (
    !payload ||
    !Object.keys(payload).every((key) => ['sub', 'exp', 'attrs'].includes(key)) ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp) ||
    !Number.isSafeInteger(payload.exp * 1000) ||
    payload.exp * 1000 <= options.now()
  )
    return null
  const attributes = payload.attrs ?? {}
  if (
    !attributes ||
    typeof attributes !== 'object' ||
    Array.isArray(attributes) ||
    !Object.values(attributes).every((value) => typeof value === 'string')
  )
    return null
  return {
    authKind: 'portal-identity',
    credentialKind: 'sso',
    ownerClass: 'remote',
    subject: payload.sub,
    expiresAt: payload.exp * 1000,
    attributes: Object.freeze({ ...(attributes as Record<string, string>) }),
  }
}

/** Reference uses WebCrypto and its own transaction algorithm, without the default verifier. */
export function createReferenceCredentialVerifier(database: DatabaseSync) {
  database.exec(
    'CREATE TABLE IF NOT EXISTS auth_nonces (client_id TEXT NOT NULL,nonce TEXT NOT NULL,seen_at INTEGER NOT NULL,PRIMARY KEY(client_id,nonce))',
  )
  if (
    !database
      .prepare('PRAGMA table_info(auth_nonces)')
      .all()
      .some((column) => column.name === 'expires_at')
  ) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec('ALTER TABLE auth_nonces ADD COLUMN expires_at INTEGER')
      database.exec('UPDATE auth_nonces SET expires_at = seen_at + 600000')
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  return async (
    auth: LegacyIdentityCredentialEnvelope,
    evidence: LegacyIdentityTransportEvidence,
    options: ReferenceVerification,
    signal: AbortSignal,
  ): Promise<ReferenceCredential | null> => {
    if (auth.kind === 'local')
      return evidence.localGate === 'none'
        ? null
        : {
            authKind: 'local',
            credentialKind: 'local',
            ownerClass: 'local-owner',
            subject: 'machine-owner',
            expiresAt: options.now() + 300000,
          }
    if (auth.kind === 'jwt') return referenceJwt(auth.token, options)
    if (auth.kind === 'portal-identity') return referencePortal(auth.token, options)
    const configured =
      auth.kind === 'surface'
        ? (options.surfaceSources?.().filter((item) => item.sourceId === auth.sourceId) ?? [])
        : []
    if (
      auth.kind === 'surface' &&
      (configured.length !== 1 ||
        !configured[0]?.grants.every((grant) => validateSurfaceServiceGrant(grant).ok))
    )
      return null
    const signed = auth.kind === 'surface' ? auth.source : auth
    const time = signed.timestamp * 1000
    if (
      !Number.isSafeInteger(time) ||
      time < 0 ||
      Math.abs(time - options.now()) > 300000 ||
      time + 300000 <= options.now() ||
      !/^[a-f0-9]{32}$/.test(signed.nonce) ||
      !/^v0=[a-f0-9]{64}$/.test(signed.signature)
    )
      return null
    const keys = auth.kind === 'surface' ? (configured[0]?.keys ?? []) : (options.sourceKeys?.() ?? [])
    const accepted: { keyId: string; secret: string }[] = []
    for (const key of keys) {
      if (
        key.keyId &&
        key.secret &&
        (await mac(
          key.secret,
          Buffer.from(
            `v0:${signed.timestamp}:${signed.nonce}:initialize\n${evidence.clientId}\n${evidence.initializeDigest}`,
          ),
          Buffer.from(signed.signature.slice(3), 'hex'),
        ))
      )
        accepted.push(key)
    }
    if (accepted.length !== 1 || !accepted[0]) return null
    const user =
      auth.kind === 'surface'
        ? auth.subject.kind === 'jwt'
          ? await referenceJwt(auth.subject.token, options)
          : await referencePortal(auth.subject.token, options)
        : null
    if (auth.kind === 'surface' && !user) return null
    if (signal.aborted || time + 300000 <= options.now() || (user && user.expiresAt <= options.now()))
      return null
    // No await occurs between BEGIN and COMMIT; the pair is one durable owner operation.
    database.exec('BEGIN IMMEDIATE')
    try {
      database
        .prepare('DELETE FROM auth_nonces WHERE COALESCE(expires_at, seen_at + 600000) <= ?')
        .run(options.now())
      const first = evidence.clientId
      const second = `source-key:${accepted[0].keyId}`
      const count = database
        .prepare('SELECT COUNT(*) AS n FROM auth_nonces WHERE nonce = ? AND client_id IN (?, ?)')
        .get(signed.nonce, first, second)
      if (count?.n !== 0) {
        database.exec('ROLLBACK')
        return null
      }
      database
        .prepare('INSERT INTO auth_nonces VALUES (?, ?, ?, ?)')
        .run(first, signed.nonce, options.now(), time + 300000)
      if (first !== second)
        database
          .prepare('INSERT INTO auth_nonces VALUES (?, ?, ?, ?)')
          .run(second, signed.nonce, options.now(), time + 300000)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return user
      ? {
          ...user,
          authKind: 'surface',
          ...(auth.kind === 'surface' ? { sourceId: auth.sourceId } : {}),
          sourceKeyId: accepted[0].keyId,
          serviceGrants: configured[0]?.grants ?? [],
          expiresAt: Math.min(user.expiresAt, time + 300000),
        }
      : {
          authKind: 'source-auth',
          credentialKind: 'channel',
          ownerClass: 'service',
          subject: evidence.clientId,
          sourceKeyId: accepted[0].keyId,
          expiresAt: time + 300000,
        }
  }
}
