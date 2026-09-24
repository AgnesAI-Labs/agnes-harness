import { createHmac, timingSafeEqual } from 'node:crypto'
export type PortalClaims = { sub: string; exp: number; attrs?: Record<string, string> }
const MAX_TOKEN_LENGTH = 8_192

function requireSecret(secret: string): void {
  if (typeof secret !== 'string' || !secret) throw new TypeError('identity secret required')
}
function validRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function assertClaims(value: unknown): asserts value is PortalClaims {
  if (!validRecord(value)) throw new TypeError('portal identity claims must be a plain object')
  if (typeof value.sub !== 'string' || !value.sub) throw new TypeError('identity sub required')
  if (!Number.isSafeInteger(value.exp) || (value.exp as number) <= 0)
    throw new TypeError('portal identity exp must be a positive Unix-seconds integer')
  if (
    value.attrs !== undefined &&
    (!validRecord(value.attrs) || !Object.values(value.attrs).every((entry) => typeof entry === 'string'))
  )
    throw new TypeError('portal identity attrs must contain only string values')
  if (!Object.keys(value).every((key) => key === 'sub' || key === 'exp' || key === 'attrs'))
    throw new TypeError('portal identity claims contain an unknown field')
}
const digest = (payload: Uint8Array, secret: string) => createHmac('sha256', secret).update(payload).digest()

export function mintPortalIdentity(claims: PortalClaims, secret: string): string {
  requireSecret(secret)
  assertClaims(claims)
  const payload = Buffer.from(JSON.stringify(claims))
  const token = `${payload.toString('base64url')}.${digest(payload, secret).toString('hex')}`
  if (token.length > MAX_TOKEN_LENGTH) throw new TypeError('portal identity token exceeds protocol limit')
  return token
}

export function verifyPortalIdentity(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): PortalClaims | null {
  requireSecret(secret)
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('identity nowMs must be milliseconds')
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null
  const [encoded, mac, ...extra] = token.split('.')
  if (!encoded || !mac || extra.length > 0 || !/^[0-9a-f]{64}$/.test(mac)) return null
  const payload = Buffer.from(encoded, 'base64url')
  if (payload.toString('base64url') !== encoded) return null
  const actual = Buffer.from(mac, 'hex')
  if (!timingSafeEqual(digest(payload, secret), actual)) return null
  try {
    const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
    assertClaims(claims)
    return claims.exp * 1_000 <= nowMs ? null : claims
  } catch {
    return null
  }
}
