import { createHash } from 'node:crypto'

// Re-exported rather than restated. A second canonicalizer is a second byte sequence for the same
// value, and the profile hash this package stamps would stop matching anything core hashed.
export { canonicalJson } from '@agnes/core'

export function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
