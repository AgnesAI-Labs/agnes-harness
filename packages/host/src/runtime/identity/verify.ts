import {
  createHmac,
  createPublicKey,
  type JsonWebKeyInput,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import type { SurfaceServiceGrant } from '@agnes/protocol'
import { validateSurfaceServiceGrant } from '@agnes/protocol'
import type {
  LegacyIdentityCredentialEnvelope,
  LegacyIdentityTransportEvidence,
} from '@agnes/protocol/runtime'
import type { IdentityNonceOwner } from './nonce.js'

export type IdentityKey = { readonly keyId: string; readonly secret: string }
export type IdentityJwk = JsonWebKeyInput['key'] & { kid?: string; alg?: string; use?: string }
export type IdentityVerificationPorts = {
  readonly now: () => number
  readonly generation: string
  readonly nonces: IdentityNonceOwner
  readonly jwt?: { readonly issuer: string; readonly secret?: string; readonly keys?: readonly IdentityJwk[] }
  readonly portalSecret?: string
  readonly sourceKeys?: () => readonly IdentityKey[]
  readonly surfaceSources?: () => readonly {
    readonly sourceId: string
    readonly keys: readonly IdentityKey[]
    readonly grants: readonly SurfaceServiceGrant[]
  }[]
}

/** Private verified material. It is never a credential envelope or a publicly serialized DTO. */
export type VerifiedIdentityCredential = {
  readonly authKind: 'local' | 'jwt' | 'source-auth' | 'portal-identity' | 'surface'
  readonly credentialKind: 'local' | 'jwt' | 'sso' | 'channel'
  readonly ownerClass: 'local-owner' | 'remote' | 'service'
  readonly subject: string
  readonly expiresAt: number
  readonly sourceKeyId?: string
  readonly sourceId?: string
  readonly serviceGrants?: readonly SurfaceServiceGrant[]
  readonly attributes?: Readonly<Record<string, string>>
  readonly principalRef?: string
  readonly credentialOwnerRef?: string
  readonly credentialRevision?: number
}

export type CredentialVerification =
  | { readonly ok: true; readonly value: VerifiedIdentityCredential }
  | { readonly ok: false }
const reject: CredentialVerification = Object.freeze({ ok: false })

function jsonSegment(value: string): Record<string, unknown> | null {
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) return null
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function jwt(token: string, ports: IdentityVerificationPorts): { subject: string; expiresAt: number } | null {
  const config = ports.jwt
  const [headerPart, payloadPart, signaturePart, ...extra] = token.split('.')
  if (!config || !headerPart || !payloadPart || !signaturePart || extra.length) return null
  const header = jsonSegment(headerPart)
  const claims = jsonSegment(payloadPart)
  if (
    !header ||
    !claims ||
    header.crit !== undefined ||
    header.b64 === false ||
    (header.kid !== undefined && (typeof header.kid !== 'string' || !header.kid))
  )
    return null
  const signed = Buffer.from(`${headerPart}.${payloadPart}`)
  const signature = Buffer.from(signaturePart, 'base64url')
  if (signature.toString('base64url') !== signaturePart) return null
  let valid = false
  if (header.alg === 'HS256' && config.secret) {
    const expected = createHmac('sha256', config.secret).update(signed).digest()
    valid = expected.length === signature.length && timingSafeEqual(expected, signature)
  } else if (header.alg === 'RS256') {
    const keys = (config.keys ?? []).filter(
      (key) =>
        key.kty === 'RSA' &&
        (typeof header.kid === 'string' ? key.kid === header.kid : true) &&
        (key.alg === undefined || key.alg === 'RS256') &&
        (key.use === undefined || key.use === 'sig'),
    )
    if (keys.length !== 1 || !keys[0]) return null
    try {
      valid = verifySignature('sha256', signed, createPublicKey({ key: keys[0], format: 'jwk' }), signature)
    } catch {
      return null
    }
  }
  const now = ports.now()
  if (
    !valid ||
    claims.iss !== config.issuer ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= now ||
    !Number.isSafeInteger(claims.exp * 1000) ||
    (claims.nbf !== undefined &&
      (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf * 1000 > now))
  )
    return null
  return { subject: claims.sub, expiresAt: claims.exp * 1000 }
}

function portal(
  token: string,
  ports: IdentityVerificationPorts,
): { subject: string; expiresAt: number; attributes: Readonly<Record<string, string>> } | null {
  const [payloadPart, mac, ...extra] = token.split('.')
  if (
    !ports.portalSecret ||
    !payloadPart ||
    !mac ||
    extra.length ||
    token.length > 8192 ||
    !/^[a-f0-9]{64}$/.test(mac)
  )
    return null
  const bytes = Buffer.from(payloadPart, 'base64url')
  if (bytes.toString('base64url') !== payloadPart) return null
  const expected = createHmac('sha256', ports.portalSecret).update(bytes).digest('hex')
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  const claims = jsonSegment(payloadPart)
  if (
    !claims ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    !Number.isSafeInteger(claims.exp) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= 0 ||
    !Number.isSafeInteger(claims.exp * 1000) ||
    claims.exp * 1000 <= ports.now() ||
    !Object.keys(claims).every((key) => ['sub', 'exp', 'attrs'].includes(key))
  )
    return null
  if (
    claims.attrs !== undefined &&
    (!claims.attrs ||
      typeof claims.attrs !== 'object' ||
      Array.isArray(claims.attrs) ||
      !Object.values(claims.attrs).every((value) => typeof value === 'string'))
  )
    return null
  return {
    subject: claims.sub,
    expiresAt: claims.exp * 1000,
    attributes: Object.freeze({ ...(claims.attrs as Record<string, string> | undefined) }),
  }
}

function sourceKey(
  auth: { timestamp: number; signature: string; nonce: string },
  evidence: LegacyIdentityTransportEvidence,
  keys: readonly IdentityKey[],
  ports: IdentityVerificationPorts,
): IdentityKey | null {
  if (
    !Number.isSafeInteger(auth.timestamp) ||
    !Number.isSafeInteger(auth.timestamp * 1000) ||
    auth.timestamp < 0 ||
    auth.timestamp * 1000 + 300000 <= ports.now() ||
    Math.abs(auth.timestamp * 1000 - ports.now()) > 300000 ||
    !/^[a-f0-9]{32}$/.test(auth.nonce) ||
    !/^v0=[a-f0-9]{64}$/.test(auth.signature)
  )
    return null
  const canonical = `initialize\n${evidence.clientId}\n${evidence.initializeDigest}`
  const matches = keys.filter((key) => {
    if (!key.keyId || !key.secret) return false
    const expected = `v0=${createHmac('sha256', key.secret).update(`v0:${auth.timestamp}:${auth.nonce}:${canonical}`).digest('hex')}`
    return timingSafeEqual(Buffer.from(expected), Buffer.from(auth.signature))
  })
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export function verifyIdentityCredential(
  auth: LegacyIdentityCredentialEnvelope,
  evidence: LegacyIdentityTransportEvidence,
  ports: IdentityVerificationPorts,
): CredentialVerification {
  const now = ports.now()
  if (auth.kind === 'local') {
    if (evidence.localGate === 'none') return reject
    return {
      ok: true,
      value: {
        authKind: 'local',
        credentialKind: 'local',
        ownerClass: 'local-owner',
        subject: 'machine-owner',
        expiresAt: now + 300000,
      },
    }
  }
  if (auth.kind === 'jwt' || auth.kind === 'portal-identity') {
    const verified = auth.kind === 'jwt' ? jwt(auth.token, ports) : portal(auth.token, ports)
    return verified
      ? {
          ok: true,
          value: {
            ...verified,
            authKind: auth.kind,
            credentialKind: auth.kind === 'jwt' ? 'jwt' : 'sso',
            ownerClass: 'remote',
          },
        }
      : reject
  }
  const surface =
    auth.kind === 'surface'
      ? ports.surfaceSources?.().filter((source) => source.sourceId === auth.sourceId)
      : undefined
  if (
    auth.kind === 'surface' &&
    (surface?.length !== 1 || !surface[0]?.grants.every((grant) => validateSurfaceServiceGrant(grant).ok))
  )
    return reject
  const source = auth.kind === 'surface' ? auth.source : auth
  const keys = auth.kind === 'surface' ? (surface?.[0]?.keys ?? []) : (ports.sourceKeys?.() ?? [])
  const key = sourceKey(source, evidence, keys, ports)
  if (!key) return reject
  let subject = evidence.clientId
  let expiresAt = source.timestamp * 1000 + 300000
  let attributes: Readonly<Record<string, string>> | undefined
  if (auth.kind === 'surface') {
    const portalUser = auth.subject.kind === 'portal-identity' ? portal(auth.subject.token, ports) : null
    const user = auth.subject.kind === 'jwt' ? jwt(auth.subject.token, ports) : portalUser
    if (!user) return reject
    subject = user.subject
    expiresAt = Math.min(expiresAt, user.expiresAt)
    if (portalUser) attributes = portalUser.attributes
  }
  // Validation of both source and subject finishes before either namespace is consumed.
  if (
    !ports.nonces.consumePair({
      clientId: evidence.clientId,
      keyId: key.keyId,
      nonce: source.nonce,
      now,
      expiresAt: Math.max(now + 1, source.timestamp * 1000 + 300000),
    })
  )
    return reject
  return {
    ok: true,
    value: {
      authKind: auth.kind,
      credentialKind: auth.kind === 'surface' ? (auth.subject.kind === 'jwt' ? 'jwt' : 'sso') : 'channel',
      ownerClass: auth.kind === 'surface' ? 'remote' : 'service',
      subject,
      expiresAt,
      sourceKeyId: key.keyId,
      ...(auth.kind === 'surface'
        ? { sourceId: auth.sourceId, serviceGrants: surface?.[0]?.grants ?? [] }
        : {}),
      ...(attributes ? { attributes } : {}),
    },
  }
}

/** Token verification for the HTTP bearer family does not manufacture legacy transport evidence. */
export function verifyIdentityJwt(token: string, ports: IdentityVerificationPorts): CredentialVerification {
  const result = jwt(token, ports)
  return result
    ? { ok: true, value: { ...result, authKind: 'jwt', credentialKind: 'jwt', ownerClass: 'remote' } }
    : reject
}

export function identityPrincipalKey(verified: VerifiedIdentityCredential): string {
  if (verified.authKind === 'local') return 'machine-owner'
  if (verified.authKind === 'source-auth') return `source-auth:${verified.sourceKeyId}`
  if (verified.authKind === 'surface')
    return `surface:${verified.sourceId}:${verified.credentialKind === 'jwt' ? 'jwt' : 'portal'}:${verified.subject}`
  return `${verified.authKind === 'jwt' ? 'jwt' : 'portal'}:${verified.subject}`
}
