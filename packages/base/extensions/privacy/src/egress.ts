import { createHash } from 'node:crypto'
import type { ConsentLevel } from './consent.js'

export type EgressReceipt = {
  sha256: string
  bytes: number
  consent: ConsentLevel
  prev: string | null
  chain: string
}

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

/** Creates a content digest and links it to the preceding egress receipt. */
export function egressReceipt(prev: string | null, bytes: Uint8Array, consent: ConsentLevel): EgressReceipt {
  const digest = sha256(bytes)
  return {
    sha256: digest,
    bytes: bytes.byteLength,
    consent,
    prev,
    chain: sha256(`${prev ?? ''}${digest}`),
  }
}
