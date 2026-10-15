import { MhsError, object } from '@agnes/mhs-device'
import { encodeMedia, type Invocation, type North } from '@agnes/mhs-hub'

export const MHS_QUERY_SERVICES = ['devices', 'read', 'maps', 'world', 'activity', 'operation'] as const
export const MHS_EFFECT_SERVICES = [
  'call',
  'set',
  'stop',
  'lease',
  'watch',
  'unwatch',
  'configure',
  'resume',
  'cancel',
] as const
/** Adapter for profile/session service contexts supplied by the generic authority layer. */
export function mhsServices(north: North, invocation: (context: unknown) => Promise<Invocation>) {
  return {
    async query(service: string, input: unknown): Promise<unknown> {
      if (!(MHS_QUERY_SERVICES as readonly string[]).includes(service)) throw new MhsError('unknown-query')
      return north.query(service, object(input))
    },
    async effect(service: string, input: unknown, context: unknown): Promise<unknown> {
      if (!(MHS_EFFECT_SERVICES as readonly string[]).includes(service)) throw new MhsError('unknown-effect')
      // No actor, approval, role, lease or session identity is accepted from input.
      const params = object(input)
      if (
        ['actor', 'role', 'approved', 'approval', 'sessionId', 'laneId', 'profileId'].some((k) =>
          Object.hasOwn(params, k),
        )
      )
        throw new MhsError('untrusted-authority')
      return north.effect(service, params, await invocation(context))
    },
  }
}
/** Stream gateway owns authentication, buffering and current activation; this owns MHS semantics. */
export function mhsStreams(north: North) {
  return {
    async media(
      binding: { device: string; source: string },
      send: (frame: Uint8Array) => void,
      signal: AbortSignal,
    ): Promise<() => void> {
      signal.throwIfAborted()
      const dispose = await north.hub.subscribeMedia(binding.device, binding.source, (sample) => {
        try {
          send(encodeMedia(sample))
        } catch {
          /* Gateway budgets drop oversize media; command lane stays available. */
        }
      })
      if (signal.aborted) {
        dispose()
        return dispose
      }
      signal.addEventListener('abort', dispose, { once: true })
      return () => {
        signal.removeEventListener('abort', dispose)
        dispose()
      }
    },
    async dropped(binding: { device: string; source: string }): Promise<void> {
      await north.hub.keyframe(binding.device, binding.source)
    },
    events(send: (event: unknown) => void, signal: AbortSignal): () => void {
      signal.throwIfAborted()
      const dispose = north.hub.subscribe(send)
      signal.addEventListener('abort', dispose, { once: true })
      return () => {
        signal.removeEventListener('abort', dispose)
        dispose()
      }
    },
    async control(input: unknown, binding: { device: string; leaseId: string }): Promise<void> {
      const data = object(input)
      if (data.type === 'stop') {
        await north.hub.stop(binding.device)
        return
      }
      if (data.type !== 'manual') throw new MhsError('invalid-control')
      const axes = object(data.axes)
      if (Object.values(axes).some((v) => typeof v !== 'number' || !Number.isFinite(v)))
        throw new MhsError('invalid-axes')
      await north.hub.manual(binding.device, binding.leaseId, axes as Record<string, number>)
    },
    async disconnect(binding: { device: string }): Promise<void> {
      await north.hub.stop(binding.device)
    },
  }
}
