import type { PluginStream, PluginStreamsClient } from '@agnes/extension-api'
import type { Device, Json, Outcome } from '@agnes/mhs-device'
import { object } from '@agnes/mhs-device'
import { MARS_PACKAGE_ID, type MarsExampleAccess } from './access.js'
import type { MarsConnection } from './runtime.js'

/** Two same-origin authenticated lanes: state/commands stay separate from camera media.
 * One multiplexed fleet avoids opening 22 browser connections. No URL/owner may be selected here. */
export function createMarsExampleAccess(streams: PluginStreamsClient): MarsExampleAccess {
  type Entry = {
    device: Device
    detached(): void
    ready(): void
    reject(error: Error): void
    finish(): void
    closed: Promise<void>
    off(): void
    outcomes: Map<string, Promise<Outcome>>
  }
  let fleet:
    | { devices: PluginStream; media: PluginStream; entries: Map<string, Entry>; close(): void }
    | undefined
  let opening: Promise<NonNullable<typeof fleet>> | undefined
  const open = (signal: AbortSignal) =>
    (opening ??= (async () => {
      const token = crypto.randomUUID(),
        entries = new Map<string, Entry>()
      const devices = await streams.open('mars.devices', { fleet: token })
      let media: PluginStream | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let nonce = 0,
        lastPong = performance.now()
      let ended = false
      const close = () => {
        if (ended) return
        ended = true
        clearInterval(heartbeat)
        devices.close('closed')
        media?.close('closed')
        for (const entry of entries.values()) {
          entry.off()
          entry.reject(new Error('producer-disconnected'))
          void entry.device
            .disconnect()
            .finally(entry.finish)
            .catch(() => {})
        }
        entries.clear()
        fleet = undefined
        opening = undefined
      }
      devices.onDisconnect(close)
      devices.onFrame((frame) => {
        void (async () => {
          const m = object(frame)
          if (m.type === 'pong') {
            if (m.nonce === nonce) lastPong = performance.now()
            return
          }
          const entry = entries.get(String(m.device))
          if (!entry) throw new Error('unknown-device')
          const d = entry.device
          if (m.type === 'detached') {
            entry.detached()
            return
          }
          if (m.type === 'registered') {
            entry.ready()
            return
          }
          if (m.type === 'manual') {
            await d.manual(m.axes)
            return
          }
          if (m.type !== 'request' || typeof m.requestId !== 'string') throw new Error('invalid-request')
          const p = object(m.params)
          const reply = (value: Json, error = false) =>
            devices.send({
              type: 'response',
              device: m.device as string,
              requestId: m.requestId as string,
              value,
              error,
            })
          try {
            let result: Json = {}
            switch (m.method) {
              case 'call': {
                const accepted = d.call(String(p.call), String(p.name), p.args)
                if (accepted.result) entry.outcomes.set(String(p.call), accepted.result)
                result = {
                  accepted: accepted.accepted,
                  ...(accepted.reason ? { reason: accepted.reason } : {}),
                }
                break
              }
              case 'outcome': {
                const outcome = entry.outcomes.get(String(p.call))
                if (!outcome) throw new Error('missing-outcome')
                result = (await outcome) as unknown as Json
                entry.outcomes.delete(String(p.call))
                break
              }
              case 'mhs/stop':
                await d.stop()
                break
              case 'mhs/set':
                result = d.set(p.values as Record<string, Json>)
                break
              case 'mhs/configure':
                result = await d.configure(p.sources)
                break
              case 'mhs/cancel':
                await d.cancel(String(p.call))
                break
              case 'mhs/pause':
                await d.pause(String(p.call))
                break
              case 'mhs/resume':
                d.resume(String(p.call))
                break
              case 'mhs/keyframe':
                await d.onKeyframe?.(String(p.source))
                break
              default:
                throw new Error('invalid-request')
            }
            if (reply(result) !== 'accepted') close()
          } catch {
            reply({}, true)
          }
        })().catch(close)
      })
      try {
        media = await streams.open('mars.media', { fleet: token })
        media.onDisconnect(close)
        if (ended || signal.aborted) throw new Error('producer-disconnected')
        const value = { devices, media, entries, close }
        fleet = value
        heartbeat = setInterval(() => {
          if (
            performance.now() - lastPong > 1500 ||
            devices.send({ type: 'ping', nonce: ++nonce }) !== 'accepted'
          )
            close()
        }, 500)
        return value
      } catch (error) {
        close()
        throw error
      }
    })())
  return {
    async connect(example, device, signal): Promise<MarsConnection> {
      if (example !== MARS_PACKAGE_ID) throw new Error('unreviewed-example')
      signal.throwIfAborted()
      const connection = await open(signal)
      signal.throwIfAborted()
      const id = device.description.device.id
      if (connection.entries.has(id)) throw new Error('duplicate-device')
      device.reconnect()
      let yes!: () => void,
        no!: (error: Error) => void,
        finish!: () => void,
        closing: Promise<void> | undefined
      const ready = new Promise<void>((resolve, reject) => {
        yes = resolve
        no = reject
      })
      // Runtime may observe the ready promise only after connect returns.
      void ready.catch(() => {})
      let detached!: () => void
      const settled = new Promise<void>((resolve) => {
        detached = resolve
      })
      const closed = new Promise<void>((resolve) => {
        finish = resolve
      })
      const off = () => {
        device.onState = undefined
        device.onProgress = undefined
        device.onObservation = undefined
        signal.removeEventListener('abort', abort)
      }
      const close = () =>
        (closing ??= (async () => {
          off()
          no(new Error('device-closed'))
          if (connection.devices.send({ type: 'detach', device: id }) === 'accepted') {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                settled,
                closed,
                new Promise<void>((_, reject) => {
                  timer = setTimeout(() => reject(new Error('stop-unconfirmed')), 2500)
                }),
              ])
            } finally {
              clearTimeout(timer)
            }
          }
          await device.disconnect()
          connection.entries.delete(id)
          finish()
          if (!connection.entries.size) connection.close()
        })())
      const abort = () => {
        void close().catch(connection.close)
      }
      const send = (value: Json) => {
        if (connection.devices.send(new TextEncoder().encode(JSON.stringify(value))) !== 'accepted')
          connection.close()
      }
      connection.entries.set(id, {
        device,
        detached,
        ready: yes,
        reject: no,
        finish,
        closed,
        off,
        outcomes: new Map(),
      })
      device.onState = (values) => send({ type: 'state', device: id, values })
      device.onProgress = (call, data) => send({ type: 'progress', device: id, call, data })
      device.onObservation = (observation, bytes) => {
        const meta = new TextEncoder().encode(JSON.stringify({ device: id, ...observation }))
        if (meta.length > 4096 || meta.length + (bytes?.length ?? 0) + 24 > 1048576) return false
        const frame = new Uint8Array(4 + meta.length + (bytes?.length ?? 0))
        new DataView(frame.buffer).setUint32(0, meta.length)
        frame.set(meta, 4)
        if (bytes) frame.set(bytes, meta.length + 4)
        return connection.media.send(frame) === 'accepted'
      }
      signal.addEventListener('abort', abort, { once: true })
      send({
        type: 'register',
        device: id,
        registration: device.description as unknown as Json,
        state: device.state(),
      })
      return { ready, closed, close }
    },
  }
}
