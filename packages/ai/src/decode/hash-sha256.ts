/**
 * SHA-256 in plain TypeScript, because this directory may not reach for node:crypto: the decode
 * chain has to be reimplementable in another language against the same fixtures, and a fixture whose
 * expected bytes came from a host-only digest could not be reproduced there.
 *
 * FIPS 180-4, unabridged: the message is padded, then compressed 64 rounds per 512-bit block into
 * eight 32-bit state words. decode-machine.test.ts checks it against the published vectors and
 * against node's implementation on both sides of a block boundary.
 */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** UTF-8 bytes, written out rather than taken from TextEncoder, which this file may not assume. */
function utf8(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

export function sha256Hex(text: string): string {
  const bytes = utf8(text)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  // The length is 64 bits; the high word is written from a float divide because a message long
  // enough to need it is longer than a 32-bit shift can express.
  const hi = Math.floor(bitLen / 0x100000000)
  for (const shift of [24, 16, 8, 0]) bytes.push((hi >>> shift) & 0xff)
  for (const shift of [24, 16, 8, 0]) bytes.push((bitLen >>> shift) & 0xff)

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array<number>(64)
  for (let block = 0; block < bytes.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      const o = block + i * 4
      w[i] =
        (((bytes[o] as number) << 24) |
          ((bytes[o + 1] as number) << 16) |
          ((bytes[o + 2] as number) << 8) |
          (bytes[o + 3] as number)) >>>
        0
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number
      const b = w[i - 2] as number
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const round = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (round[i] as number)) >>> 0
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('')
}
