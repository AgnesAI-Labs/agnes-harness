import { createHash } from 'node:crypto'
import type { Sha256Implementation, Sha256Stream } from './sha256-types.js'

/** Selected by the `node` condition of `#sha256`; byte-identical to the portable implementation. */
export const SHA256_IMPLEMENTATION: Sha256Implementation = 'node'

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

export function createSha256(): Sha256Stream {
  const hash = createHash('sha256')
  let bytes = 0
  return {
    update(chunk) {
      if (typeof chunk === 'string') {
        hash.update(chunk, 'utf8')
        bytes += Buffer.byteLength(chunk, 'utf8')
      } else {
        hash.update(chunk)
        bytes += chunk.byteLength
      }
    },
    get bytes() {
      return bytes
    },
    digestHex: () => hash.digest('hex'),
  }
}
