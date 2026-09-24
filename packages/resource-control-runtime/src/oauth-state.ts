import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signed, replay-protected OAuth `state` parameter orchestrator - the CSRF/tamper protection for
 * the authorization_code flow this package's MCP OAuth support is built on. This is a generic
 * primitive: it knows nothing about MCP, HTTP routing or the daemon's transport layer, only about
 * sealing an arbitrary payload into an opaque token a browser round-trip can carry, and unsealing
 * it back with tamper/expiry checks that fail closed.
 *
 * Signing convention mirrors packages/daemon/src/local/auth.ts's signSourceAuth/verifySourceAuth:
 * HMAC-SHA256 over an explicit versioned/delimited byte string, decoded with a
 * length-checked timingSafeEqual (never a raw ===, and never comparing before confirming equal
 * length - timingSafeEqual throws on a length mismatch rather than returning false).
 */
export type OAuthStatePayload = Readonly<{
  serverId: string
  redirectUri: string
  codeVerifier: string
  nonce: string
  issuedAt: number
  returnTo?: string
}>

// Single opaque failure for every rejection path (parse, signature, expiry) - deliberately does
// not distinguish "tampered" from "expired" from "malformed" in the thrown message, so a caller
// forwarding this to an HTTP response can never leak which check failed to a probing client.
const INVALID_STATE_ERROR = 'invalid or expired oauth state'

function invalid(): never {
  throw new Error(INVALID_STATE_ERROR)
}

/**
 * The signed byte string: `oauth-state:v1:<base64url body>`. The version tag and field separator
 * are part of what gets signed, not appended after - this is the same reasoning as
 * sourceAuthCanonical/signSourceAuth folding the nonce into the HMAC input rather than checking it
 * out-of-band: a signature only means something if the bytes it covers cannot be reinterpreted a
 * second way by an attacker who controls framing but not the secret.
 */
function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(`oauth-state:v1:${body}`).digest('base64url')
}

export async function sealOAuthState(payload: OAuthStatePayload, opts: { secret: string }): Promise<string> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = signBody(opts.secret, body)
  return `${body}.${signature}`
}

export async function openOAuthState(
  sealed: string,
  opts: { secret: string; maxAgeMs: number },
): Promise<OAuthStatePayload> {
  // A raw string.split('.') would silently accept "a.b.c" by discarding everything past the first
  // separator (destructuring [body, sig] just drops the third element), letting a body containing
  // an unencoded '.' desync from what the signature actually covers. Splitting on the *last* dot
  // instead treats everything before it as the body, which stays correct even though base64url's
  // own alphabet never itself contains '.', and rejects outright when there is no separator at all.
  const dot = sealed.lastIndexOf('.')
  if (dot < 0) invalid()
  const body = sealed.slice(0, dot)
  const signature = sealed.slice(dot + 1)
  if (!body || !signature) invalid()

  const expected = signBody(opts.secret, body)
  // timingSafeEqual throws on unequal-length buffers rather than returning false, so the length
  // check must happen first - and it must happen without an early-return based on length alone,
  // since a length mismatch is itself a form of signal an attacker could otherwise time. Buffers
  // are compared byte-for-byte in constant time only once lengths already match; the base64url
  // encoding of a fixed-size 32-byte HMAC digest means a genuine signature is always a fixed
  // length, so this length check does not itself leak partial-match information.
  const givenBuf = Buffer.from(signature, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (givenBuf.length !== expectedBuf.length || !timingSafeEqual(givenBuf, expectedBuf)) invalid()

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    invalid()
  }
  if (!isOAuthStatePayload(parsed)) invalid()
  if (Date.now() - parsed.issuedAt > opts.maxAgeMs) invalid()
  return parsed
}

function isOAuthStatePayload(value: unknown): value is OAuthStatePayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.serverId === 'string' &&
    typeof v.redirectUri === 'string' &&
    typeof v.codeVerifier === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.issuedAt === 'number' &&
    Number.isFinite(v.issuedAt) &&
    (v.returnTo === undefined || typeof v.returnTo === 'string')
  )
}

// Process-in-memory replay guard: a nonce is claimed exactly once, first-claimant-wins. Intentional
// scope: this does not survive a daemon restart, and one daemon process does not coordinate with
// another - the plan this belongs to explicitly narrows replay protection to "valid within a single
// daemon process's lifetime", since the OAuth authorization_code round-trip this guards is itself
// bounded by a short-lived browser redirect that cannot usefully outlive one daemon process anyway.
const claimedNonces = new Map<string, number>()

function sweepExpiredNonces(now: number): void {
  for (const [nonce, expiresAt] of claimedNonces) if (expiresAt < now) claimedNonces.delete(nonce)
}

export async function claimOAuthNonce(nonce: string, expiresAt: number): Promise<boolean> {
  const now = Date.now()
  sweepExpiredNonces(now)
  if (claimedNonces.has(nonce)) return false
  claimedNonces.set(nonce, expiresAt)
  return true
}
