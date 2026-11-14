import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { BundledAppChannels, BundledAppGrant } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'

/** The worker's own backend scope; never the destination workspace of a plugin operation. */
export type BundledAppScope = Readonly<{ home: string; profile: string; dataDir: string; workspace: string }>
/** What the backend client factory receives; every connection attempt must pass `assertCurrent`. */
export type BundledAppClientContext = Readonly<{
  scope: BundledAppScope
  stateDirectory: string
  clientId: string
  signal: AbortSignal
  assertCurrent(): void
}>
export type BundledAppClientLease = Readonly<{ client: unknown; close(): Promise<void> }>
/** Backend composition only; never a plugin-supplied factory or transport address. */
export type BundledAppClientFactory = (context: BundledAppClientContext) => BundledAppClientLease
/** Assembly-owned inputs: where application state lives and how the owner client is built. */
export type BundledAppHost = Readonly<{
  stateRoot: string
  scope: BundledAppScope
  client: BundledAppClientFactory
}>
/** Chosen by release assembly for one granted row and managed service; never by package input. */
export type BundledAppProvision = Readonly<{ host: BundledAppHost; packageId: string; service: string }>

const refuse = async (): Promise<never> => {
  throw rpcError('CAPABILITY_DENIED')
}
/** Channel group access is supplied by the channel runtime; until then every call is refused. */
export const deniedBundledAppChannels: BundledAppChannels = Object.freeze({
  subscribe: () => {
    throw rpcError('CAPABILITY_DENIED')
  },
  send: refuse,
  fetchMessages: refuse,
  listThread: refuse,
  listHistory: refuse,
  listChats: refuse,
  listMembers: refuse,
})

/** Open the grant for one started resource. `close` is idempotent and ends the client connection. */
export function openBundledApp(
  provision: BundledAppProvision,
  fence: Readonly<{ signal: AbortSignal; assertCurrent(): void }>,
): { grant: BundledAppGrant; close(): Promise<void> } {
  const { host, packageId, service } = provision
  const key = createHash('sha256').update(`${host.scope.profile}\0${packageId}\0${service}`).digest('hex')
  const stateDirectory = join(host.stateRoot, key.slice(0, 32))
  privateDirectory(host.stateRoot)
  privateDirectory(stateDirectory)
  const assertCurrent = () => {
    try {
      fence.signal.throwIfAborted()
      fence.assertCurrent()
    } catch {
      throw rpcError('CAPABILITY_DENIED')
    }
  }
  const lease = host.client({
    scope: host.scope,
    stateDirectory,
    clientId: `bundled-app:${packageId}/${service}`,
    signal: fence.signal,
    assertCurrent,
  })
  let closing: Promise<void> | undefined
  return {
    grant: Object.freeze({
      stateDirectory,
      client: lease.client,
      channels: deniedBundledAppChannels,
      assertCurrent,
    }),
    close: () => (closing ??= lease.close().catch(() => undefined)),
  }
}

function privateDirectory(path: string): void {
  try {
    createPrivateDirectorySync(path)
  } catch (error) {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat?.isDirectory() || stat.isSymbolicLink() || !hasPrivateDaclSync(path)) throw error
  }
}
