import type { Device, Json, Outcome } from '@agnes/mhs-device'
import type { DeviceLink, Hub } from '@agnes/mhs-hub'
import type { MarsConnection, MarsTransport } from './runtime.js'
import { DEVICE_IDS } from './world.js'

/** Embedded managed-runtime adapter against the public Hub/SDK, with no second Hub or socket. */
export function createMarsHubTransport(
  hub: Hub,
  assertReviewedCurrentLink: (signal: AbortSignal) => Promise<void>,
): MarsTransport {
  return {
    async connect(device: Device, signal: AbortSignal): Promise<MarsConnection> {
      signal.throwIfAborted()
      await assertReviewedCurrentLink(signal)
      signal.throwIfAborted()
      device.reconnect()
      const id = device.description.device.id
      if (!DEVICE_IDS.some((known) => known === id)) throw new Error('undeclared-example-device')
      if (hub.snapshot().some((view) => view.id === id && view.online))
        throw new Error('example-device-already-owned')
      let finish!: () => void
      const closed = new Promise<void>((resolve) => {
        finish = resolve
      })
      let closing: Promise<void> | undefined
      const close = () =>
        (closing ??= (async () => {
          signal.removeEventListener('abort', abort)
          try {
            await device.disconnect()
          } finally {
            device.onState = undefined
            device.onObservation = undefined
            device.onProgress = undefined
            hub.offline(id, link)
            finish()
          }
        })())
      const abort = () => {
        void close().catch(() => {})
      }
      const link: DeviceLink = {
        registration: device.description,
        get available() {
          return !closing && !signal.aborted
        },
        async request(method, params) {
          if (method === 'mhs/stop') {
            await device.stop()
            return {}
          }
          signal.throwIfAborted()
          await assertReviewedCurrentLink(signal)
          switch (method) {
            case 'mhs/set':
              return device.set(params.values as Record<string, Json>)
            case 'mhs/configure':
              return device.configure(params.sources)
            case 'mhs/cancel':
              await device.cancel(String(params.call))
              return {}
            case 'mhs/pause':
              await device.pause(String(params.call))
              return {}
            case 'mhs/resume':
              device.resume(String(params.call))
              return {}
            case 'mhs/keyframe':
              await device.onKeyframe?.(String(params.source))
              return {}
            default:
              throw new Error('unsupported-device-request')
          }
        },
        async call(operationId, name, args) {
          signal.throwIfAborted()
          await assertReviewedCurrentLink(signal)
          const accepted = device.call(operationId, name, args)
          return {
            accepted: accepted.accepted,
            ...(accepted.reason ? { reason: accepted.reason } : {}),
            result:
              accepted.result ??
              Promise.resolve<Outcome>({ status: 'rejected', reason: accepted.reason ?? 'refused' }),
          }
        },
        manual(axes) {
          void assertReviewedCurrentLink(signal)
            .then(() => {
              signal.throwIfAborted()
              return device.manual(axes)
            })
            .catch(async () => {
              await close()
            })
            .catch(() => {})
        },
        close: abort,
      }
      device.onState = (values) => hub.state(id, values)
      device.onObservation = (observation, bytes) => {
        if (closing || signal.aborted) return false
        hub.observation(id, observation.source, observation.data ?? null, bytes, observation.mime)
        return true
      }
      device.onProgress = (call, data) => hub.progress(id, call, data)
      signal.addEventListener('abort', abort, { once: true })
      hub.online(link)
      device.update(device.state())
      return { ready: Promise.resolve(), closed, close }
    },
  }
}
