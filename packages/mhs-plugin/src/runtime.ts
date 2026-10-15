import type { PluginContextFacets } from '@agnes/extension-api'
import { MhsError } from '@agnes/mhs-device'
import { type Authority, type BoundWakes, Hub, North, type OwnedStore, South } from '@agnes/mhs-hub'
import { type MhsConnector, registerMhsTools } from './tools.js'

export const MHS_HUB_API_VERSION = '1.0.0'

export interface ManagedMhsInit {
  store: OwnedStore
  wakes: BoundWakes
  authority: Authority
  devicePort: number
  signal: AbortSignal
  ready(info: { apiVersion: string; listeners: readonly string[] }): Promise<void>
  onShutdown(
    fn: (
      reason: 'disable' | 'upgrade' | 'exit',
      signal: AbortSignal,
    ) => Promise<{ state: 'settled' | 'unknown' }>,
  ): void
}
/** Called once by the profile managed-service owner, never by a session plugin's apply(). */
export async function startMhsHub(
  init: ManagedMhsInit,
): Promise<{ north: North; stop(): Promise<{ state: 'settled' | 'unknown' }> }> {
  const hub = new Hub(init)
  const south = new South(hub)
  let stopped: Promise<{ state: 'settled' | 'unknown' }> | undefined
  let initialized = false
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = (reason: 'disable' | 'upgrade' | 'exit' = 'exit') =>
    (stopped ??= (async () => {
      clearInterval(timer)
      try {
        return initialized ? await hub.shutdown(reason) : { state: 'settled' as const }
      } catch {
        return { state: 'unknown' as const }
      } finally {
        await south.close()
      }
    })())
  init.onShutdown(async (reason) => {
    const result = await stop(reason)
    try {
      if (initialized && reason !== 'exit') await hub.watches.interrupt(reason)
      return result
    } catch {
      return { state: 'unknown' }
    }
  })
  init.signal.addEventListener(
    'abort',
    () => {
      void stop(
        init.signal.reason === 'disable' || init.signal.reason === 'upgrade' ? init.signal.reason : 'exit',
      ).catch(() => {})
    },
    { once: true },
  )
  try {
    init.signal.throwIfAborted()
    await hub.recover()
    initialized = true
    await south.listen(init.devicePort)
    init.signal.throwIfAborted()
    timer = setInterval(() => {
      void hub.watches.tick().catch(() => {})
      void hub.journal.flush().catch(() => {})
    }, 1000)
    await init.ready({ apiVersion: MHS_HUB_API_VERSION, listeners: ['device'] })
    return { north: new North(hub), stop }
  } catch (error) {
    await stop()
    throw error
  }
}
export function createMhsPlugin(connector: MhsConnector) {
  return {
    inject: ['tools', 'hooks'],
    apply(ctx: Pick<PluginContextFacets, 'tools' | 'hooks'>) {
      registerMhsTools(ctx, connector)
    },
  }
}
/** The profile managed connector is not wired on older Hosts; refuse instead of bypassing it. */
export const mhsPlugin = {
  inject: ['tools', 'hooks'],
  apply(): never {
    throw new MhsError('E_MHS_MANAGED_CONNECTOR_REQUIRED')
  },
}
