const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_TIME = 0xffffffffffff

/** A deterministic ULID primitive. Monotonicity across events is owned by EnvelopeBuilder. */
export function ulidAt(ms: number, rng: () => number): string {
  let value = Number.isFinite(ms) ? Math.max(0, Math.min(MAX_TIME, Math.floor(ms))) : 0
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = `${ALPHABET[value % 32]}${time}`
    value = Math.floor(value / 32)
  }
  let random = ''
  for (let i = 0; i < 16; i++) {
    const n = rng()
    const index = Number.isFinite(n) ? Math.max(0, Math.min(31, Math.floor(n * 32))) : 0
    random += ALPHABET[index]
  }
  return time + random
}
