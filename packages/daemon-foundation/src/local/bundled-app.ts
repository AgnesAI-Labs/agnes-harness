import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The bundled application's connection proof. The daemon mints a key per run and hands it only to the shared worker
 * that hosts the bundled application's grant; that worker's owner client presents `bundledAppProof(key, clientId)` with
 * its local credential. Holding the proof marks the connection as the bundled application's, which is what a session
 * environment requires. The key never leaves the two processes, and the proof names the client id it was made for.
 */
export const BUNDLED_APP_CLIENT_PREFIX = 'bundled-app:'

export function bundledAppProof(key: string, clientId: string): string {
  return createHmac('sha256', key).update(`agnes.bundled-app\0${clientId}`).digest('hex')
}

/** Whether `proof` is the proof for `clientId` under `key`; false for any missing part. */
export function verifyBundledAppProof(key: string | undefined, clientId: string, proof: unknown): boolean {
  if (!key || typeof proof !== 'string' || !clientId.startsWith(BUNDLED_APP_CLIENT_PREFIX)) return false
  const expected = Buffer.from(bundledAppProof(key, clientId))
  const given = Buffer.from(proof)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
