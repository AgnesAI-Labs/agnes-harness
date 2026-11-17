import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The bundled application's connection proof. The daemon mints a key per run and sends it, once the worker's hello is
 * verified, over the IPC channel to the shared session worker that hosts the bundled application's grant; that
 * worker's owner client presents `bundledAppProof(key, clientId)` with its local credential. Holding the proof marks the
 * connection as the bundled application's, which is what a session environment requires. The key is in no process's
 * environment, so neither the worker's children nor other programs of the same user read it there; code running inside
 * the shared worker itself is not kept from it. The proof names the client id it was made for.
 */
export const BUNDLED_APP_CLIENT_PREFIX = 'bundled-app:'
/** The kind of the IPC message that carries the key from the daemon to the shared session worker. */
export const BUNDLED_APP_KEY_MESSAGE = 'agnes.bundledAppKey'

/** The IPC message that carries `key`. */
export function bundledAppKeyMessage(key: string): { kind: typeof BUNDLED_APP_KEY_MESSAGE; key: string } {
  return { kind: BUNDLED_APP_KEY_MESSAGE, key }
}

/**
 * The key the daemon sends this process over its IPC channel, or undefined once the channel closes without one or when
 * the process has none. Listens only until the key arrives.
 */
export function receiveBundledAppKey(channel: NodeJS.Process = process): Promise<string | undefined> {
  if (!channel.send || !channel.connected) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const done = (key: string | undefined) => {
      channel.off('message', onMessage)
      channel.off('disconnect', onDisconnect)
      resolve(key)
    }
    const onMessage = (message: unknown) => {
      const { kind, key } = (message ?? {}) as { kind?: unknown; key?: unknown }
      if (kind === BUNDLED_APP_KEY_MESSAGE && typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)) done(key)
    }
    const onDisconnect = () => done(undefined)
    channel.on('message', onMessage)
    channel.on('disconnect', onDisconnect)
  })
}

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
