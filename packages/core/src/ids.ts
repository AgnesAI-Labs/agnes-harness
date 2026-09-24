import type { Clock, IdMinter } from './types.js'

// Crockford base32, in ascending code-point order, so lexicographic string comparison of two ULIDs
// agrees with their numeric order.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function encodeTime(ms: number): string {
  let t = ms
  let s = ''
  for (let i = 0; i < 10; i++) {
    s = (B32[t % 32] as string) + s
    t = Math.floor(t / 32)
  }
  return s
}

export function defaultIds(clock: Clock = () => Date.now()): IdMinter {
  let lastMs = -1
  let lastRand: number[] = []
  const ulid = (): string => {
    const ms = clock()
    if (ms === lastMs) {
      // Two ULIDs minted in the same millisecond must still sort in mint order, so the random
      // component is incremented as a big-endian base-32 counter instead of being drawn afresh.
      for (let i = lastRand.length - 1; i >= 0; i--) {
        if ((lastRand[i] as number) < 31) {
          lastRand[i] = (lastRand[i] as number) + 1
          break
        }
        lastRand[i] = 0
      }
    } else {
      lastMs = ms
      lastRand = Array.from(randomBytes(16)).map((b) => b % 32)
    }
    return encodeTime(ms) + lastRand.map((v) => B32[v]).join('')
  }
  return {
    ulid,
    effectId: () => `e-${hex(randomBytes(16))}`,
    toolUseId: (ordinal) => `t${ordinal}-${hex(randomBytes(16))}`,
    requestId: () => `r-${hex(randomBytes(16))}`,
    // 128 bits, which is 32 hex characters: NONCE_PATTERN admits 32 to 64, so a shorter draw is
    // rejected by the one function that stamps it into an envelope.
    nonce: () => hex(randomBytes(16)),
  }
}
