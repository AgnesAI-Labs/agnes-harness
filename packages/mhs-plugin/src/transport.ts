import type {
  ManagedServiceInit,
  ManagedServiceRuntime,
  PluginStreamsPort,
  StreamContext,
} from '@agnes/extension-api'
import { type Json, MhsError, object } from '@agnes/mhs-device'
import type { Authority, BoundWakes, North } from '@agnes/mhs-hub'
import { startMhsHub } from './runtime.js'
import { mhsStreams } from './services.js'

/** Adapt the real generic managed runtime, including its namespaced transactional store.
 * Authority and wakes come from the trusted current profile service owner, never initialization JSON. */
export function startManagedMhsHub(
  runtime: ManagedServiceInit & ManagedServiceRuntime,
  ports: { authority: Authority; wakes: BoundWakes },
) {
  const device = runtime.listeners.device
  if (device?.host !== '127.0.0.1' || Object.keys(runtime.listeners).length !== 1)
    throw new MhsError('managed-listeners-mismatch')
  return startMhsHub({
    ...ports,
    store: runtime.store,
    signal: runtime.signal,
    devicePort: device.port,
    ready: (info) => runtime.ready(info),
    onShutdown: (handler) => runtime.onShutdown(handler),
  })
}

/** Register MHS handlers on the generic gateway. The reviewed declarations own limits/scope.
 * bindControl resolves the exact admitted device and Hub lease; no authority comes from input. */
export function registerMhsStreams(
  north: North,
  streams: PluginStreamsPort,
  bindControl: (context: StreamContext) => Promise<{ grantId: string; device: string; leaseId: string }>,
): () => void {
  const handlers = mhsStreams(north)
  const releases: (() => void)[] = []
  const owned = (context: StreamContext, release: () => void) => {
    if (context.signal.aborted) {
      release()
      return
    }
    context.signal.addEventListener('abort', release, { once: true })
  }
  try {
    releases.push(
      streams.register('mhs.events', (_input, context) => {
        owned(
          context,
          handlers.events((event) => context.stream.send(event as Json), context.signal),
        )
      }),
    )
    releases.push(
      streams.register('mhs.media', async (input, context) => {
        const data = object(input)
        if (typeof data.device !== 'string' || typeof data.source !== 'string')
          throw new MhsError('invalid-media-binding')
        const binding = { device: data.device, source: data.source }
        let nextKeyframeAt = 0
        const drop = context.stream.onDrop(() => {
          if (Date.now() < nextKeyframeAt) return
          nextKeyframeAt = Date.now() + 1000
          void handlers.dropped(binding).catch(() => {})
        })
        try {
          const release = await handlers.media(
            binding,
            (frame) => {
              context.stream.send(frame)
            },
            context.signal,
          )
          owned(context, () => {
            drop()
            release()
          })
        } catch (error) {
          drop()
          throw error
        }
      }),
    )
    releases.push(
      streams.register('mhs.control', async (_input, context) => {
        if (!context.control) throw new MhsError('control-admission-required')
        const binding = await bindControl(context)
        context.signal.throwIfAborted()
        if (binding.grantId !== context.control.grantId || !binding.device || !binding.leaseId)
          throw new MhsError('control-binding-mismatch')
        // No awaits between the current-signal check and cleanup/receive registration.
        context.stream.onDisconnect(() => handlers.disconnect(binding))
        const frame = context.stream.onFrame((input) => {
          void handlers.control(input, binding).catch(() => context.stream.close('unavailable'))
        })
        owned(context, () => {
          frame()
        })
      }),
    )
  } catch (error) {
    for (const release of releases.reverse()) release()
    throw error
  }
  return () => {
    for (const release of releases.splice(0).reverse()) release()
  }
}
