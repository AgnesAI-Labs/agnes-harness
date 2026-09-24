// SHA-256 and a canonical JSON serializer, both pure and dependency-free. They are the byte source
// for every hash core stamps on a request, so they may not vary with the host: `node:crypto` is off
// limits inside this package, and a canonicalization that reordered keys differently on another
// runtime would make two identical requests hash differently.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
const at = (a: Uint32Array, i: number): number => a[i] as number

export function sha256Hex(input: string | Uint8Array): string {
  const msg = typeof input === 'string' ? utf8(input) : input
  const l = msg.length
  const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6)
  padded.set(msg)
  padded[l] = 0x80
  const dv = new DataView(padded.buffer)
  // The length is written as a 64-bit big-endian bit count in two halves: a message over 512 MiB
  // overflows a single 32-bit word, and writing only the low half would hash it as a shorter one.
  dv.setUint32(padded.length - 4, (l * 8) >>> 0)
  dv.setUint32(padded.length - 8, Math.floor((l * 8) / 0x100000000))
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(at(w, i - 15), 7) ^ rotr(at(w, i - 15), 18) ^ (at(w, i - 15) >>> 3)
      const s1 = rotr(at(w, i - 2), 17) ^ rotr(at(w, i - 2), 19) ^ (at(w, i - 2) >>> 10)
      w[i] = (at(w, i - 16) + s0 + at(w, i - 7) + s1) >>> 0
    }
    let a = at(h, 0)
    let b = at(h, 1)
    let c = at(h, 2)
    let d = at(h, 3)
    let e = at(h, 4)
    let f = at(h, 5)
    let g = at(h, 6)
    let hh = at(h, 7)
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + at(K, i) + at(w, i)) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = at(h, 0) + a
    h[1] = at(h, 1) + b
    h[2] = at(h, 2) + c
    h[3] = at(h, 3) + d
    h[4] = at(h, 4) + e
    h[5] = at(h, 5) + f
    h[6] = at(h, 6) + g
    h[7] = at(h, 7) + hh
  }
  return [...h].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/**
 * One byte sequence per JSON value: object keys sorted by UTF-16 code unit, array order kept,
 * `undefined` members dropped from objects and written as `null` inside arrays (dropping them there
 * would shift every later index). Two requests that differ only in the order their keys were built
 * therefore hash the same, which is what makes `headerEquals` and `derived_hash` mean anything.
 */
export function canonicalJson(value: unknown): string {
  // `JSON.stringify` answers `undefined` — not a string — for these three at the top level, which
  // would hand a caller hashing the result a `TypeError` or the literal text `undefined`. They are
  // written as `null`, the same way an undefined array member already is.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}
