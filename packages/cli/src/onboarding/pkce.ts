import { createHash, randomBytes } from 'node:crypto'

const RANDOM_OCTETS = 32
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/

/** Injectable only so a caller can make deterministic tests; production defaults to Node's CSPRNG. */
export type RandomBytesSource = (size: number) => Uint8Array

export type PkcePair = Readonly<{
  verifier: string
  challenge: string
  method: 'S256'
}>

function secureRandomBytes(size: number): Uint8Array {
  return randomBytes(size)
}

function randomBase64Url(source: RandomBytesSource): string {
  const bytes = source(RANDOM_OCTETS)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== RANDOM_OCTETS) {
    throw new Error(`random source must return exactly ${RANDOM_OCTETS} bytes`)
  }
  return Buffer.from(bytes).toString('base64url')
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))), without padding. */
export function derivePkceChallenge(verifier: string): string {
  if (!PKCE_VERIFIER.test(verifier)) {
    throw new Error('PKCE verifier must contain 43-128 RFC 7636 unreserved ASCII characters')
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function createPkcePair(source: RandomBytesSource = secureRandomBytes): PkcePair {
  const verifier = randomBase64Url(source)
  return { verifier, challenge: derivePkceChallenge(verifier), method: 'S256' }
}

/** Generates an opaque 256-bit OAuth state value. It must stay in memory with its auth transaction. */
export function generateAuthorizationState(source: RandomBytesSource = secureRandomBytes): string {
  return randomBase64Url(source)
}

/** Kept distinct from state so callers cannot accidentally reuse one value for both protocol roles. */
export function generateAuthorizationNonce(source: RandomBytesSource = secureRandomBytes): string {
  return randomBase64Url(source)
}
