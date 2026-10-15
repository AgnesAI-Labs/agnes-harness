import type { PluginContextFacets } from '@agnes/extension-api'
import { object } from '@agnes/mhs-device'
import { type Authority, type BoundWakes, Hub, North, type OwnedStore, South } from '@agnes/mhs-hub'
import { MHS_HUB_CHECK_SCHEMA, MHS_HUB_CONFIG_SCHEMA } from './config.js'
import { createMhsNativeProfileAdapter } from './native-profile.js'
import { mhsOwnedStore } from './owned-store.js'
import { createMhsProducer } from './producer.js'
import { type MhsConnector, registerMhsTools } from './tools.js'
import { registerMhsStreams } from './transport.js'

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
/** The installed plugin runs on the Host's current-profile managed resource owner. */
export const mhsPlugin = {
  inject: ['tools', 'hooks', 'services', 'profileRuntime'],
  apply(ctx: Pick<PluginContextFacets, 'tools' | 'hooks' | 'services' | 'profileRuntime'>) {
    let current: (() => void) | undefined
    const adapter = createMhsNativeProfileAdapter(async () => {
      if (!current) throw new Error('hub-unavailable')
      current()
    })
    const resource = ctx.profileRuntime.register({
      id: 'hub',
      configSchema: MHS_HUB_CONFIG_SCHEMA,
      defaultConfig: { listenerPorts: { device: 'auto' } },
      checkSchema: MHS_HUB_CHECK_SCHEMA,
      async start(init) {
        const deviceListener = init.listeners.device
        if (!deviceListener) throw new Error('device-listener-required')
        current = init.assertCurrent
        const hub = await startMhsHub({
          authority: adapter.authority,
          wakes: init.wakes,
          store: mhsOwnedStore(init.store),
          devicePort: deviceListener.port,
          signal: init.signal,
          ready: async () => init.ready(),
          onShutdown: (handler) => init.onShutdown((reason) => handler(reason, AbortSignal.timeout(5000))),
        })
        return { north: hub.north, signal: init.signal }
      },
      async check({ north }, input) {
        const device = object(input).device
        const devices = await north.hub.list()
        const row = devices.find((d) => d.id === device)
        return [
          { name: 'registration', state: row ? 'passed' : 'failed' },
          { name: 'connection', state: row?.available ? 'passed' : 'failed' },
          { name: 'health', state: row?.health === 'ok' ? 'passed' : 'unknown' },
        ]
      },
    })
    const north = async () => (await resource.get()).north
    adapter.register(ctx, north)
    const producer = createMhsProducer(north)
    const streams = ctx.profileRuntime.streams
    const disposeStreams = registerMhsStreams(
      north,
      {
        register: (name, handler) =>
          streams.register(name, async (input, context) => {
            const running = await resource.get()
            const signal = AbortSignal.any([context.signal, running.signal])
            const close = () => context.stream.close('runtime-replaced')
            running.signal.addEventListener('abort', close, { once: true, signal: context.signal })
            if (running.signal.aborted) close()
            signal.throwIfAborted()
            await handler(input, { ...context, signal })
          }),
      },
      adapter.bindControl,
    )
    const producers = [
      streams.register('mhs.producer', async (input, context) => {
        const running = await resource.get()
        const signal = AbortSignal.any([context.signal, running.signal])
        running.signal.addEventListener('abort', () => context.stream.close('runtime-replaced'), {
          once: true,
          signal: context.signal,
        })
        await producer.devices(input, { ...context, signal })
      }),
      streams.register('mhs.producer.media', async (input, context) => {
        const running = await resource.get()
        const signal = AbortSignal.any([context.signal, running.signal])
        running.signal.addEventListener('abort', () => context.stream.close('runtime-replaced'), {
          once: true,
          signal: context.signal,
        })
        await producer.media(input, { ...context, signal })
      }),
    ]
    registerMhsTools(ctx, {
      north,
      invocation: (context, method, input) =>
        adapter.toolInvocation(context, method ?? '', input ?? {}, north),
      async bindWake(context) {
        if (!context.wake) throw new Error('wake-binding-unavailable')
        return context.wake.bind()
      },
    })
    return () => {
      for (const off of producers) off()
      disposeStreams()
    }
  },
}
