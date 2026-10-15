import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import {
  type Device,
  type Json,
  MhsError,
  type Outcome,
  object,
  type ResourceHolder,
  validateRegistration,
} from '@agnes/mhs-device'
import { type RawData, WebSocket } from 'ws'

const payload = (data: RawData): Buffer =>
  Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)

import { Clips, clipSpec } from './clips.js'
import { decodeMedia, encodeMedia } from './media.js'
import type { DeviceLink, SouthEvents } from './ports.js'

const peerOwners = new WeakMap<Device, WebSocket>()
export type ExternalHub = { address: string; allowlist: string[] }
/** Exact reviewed endpoints, numeric hosts (no DNS rebinding), TLS except loopback development. */
export function externalHubAddress(config: ExternalHub): string {
  const u = new URL(config.address),
    host = u.hostname.replace(/^\[|\]$/g, '')
  if (
    !isIP(host) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/mhs-peer/v1' ||
    !(u.protocol === 'wss:' || (u.protocol === 'ws:' && (host === '127.0.0.1' || host === '::1'))) ||
    !config.allowlist.includes(u.href) ||
    config.allowlist.length > 16
  )
    throw new MhsError('external-hub-address-denied')
  return u.href
}

/** Federation is a device ingress, never a remote North approval bypass. Each profile owns its
 * socket, links, journal and local admission. Shutdown parks this fleet and leaves the remote
 * service running. The remote endpoint must authenticate its callers at the TLS/VPN boundary. */
export async function connectExternalHub(events: SouthEvents, config: ExternalHub, signal: AbortSignal) {
  signal.throwIfAborted()
  const socket = new WebSocket(externalHubAddress(config), {
    maxPayload: 1 << 20,
    followRedirects: false,
    handshakeTimeout: 5000,
  })
  const links = new Map<string, DeviceLink>(),
    pending = new Map<
      string,
      { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
    >()
  let seq = 0,
    ended = false,
    greeted = false,
    lastPong = Date.now()
  let resolveReady!: () => void, rejectReady!: (e: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const send = (m: Json | Uint8Array) => {
    if (socket.readyState !== 1 || socket.bufferedAmount > 1 << 20)
      throw new MhsError('external-hub-unavailable')
    socket.send(m instanceof Uint8Array ? m : JSON.stringify(m))
  }
  const request = (device: string, method: string, params: Json, timeout = 2000, bytes?: Uint8Array) =>
    new Promise<unknown>((resolve, reject) => {
      if (ended || pending.size >= 128) {
        reject(new MhsError('external-hub-unavailable'))
        return
      }
      const id = String(++seq),
        timer = setTimeout(() => {
          pending.delete(id)
          reject(new MhsError('external-hub-timeout'))
        }, timeout)
      pending.set(id, { resolve, reject, timer })
      try {
        send(
          bytes
            ? encodeMedia({
                device,
                source: 'clip',
                at: Date.now(),
                data: { type: 'request', id, method, params },
                bytes,
              })
            : { type: 'request', id, device, method, params },
        )
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  const close = () => {
    if (ended) return
    ended = true
    clearInterval(heartbeat)
    clearTimeout(startup)
    signal.removeEventListener('abort', close)
    for (const [id, link] of links) events.offline(id, link)
    links.clear()
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new MhsError('external-hub-disconnected'))
    }
    pending.clear()
    rejectReady(new MhsError('external-hub-disconnected'))
    socket.terminate()
  }
  const startup = setTimeout(close, 5000),
    heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 1500) {
        close()
        return
      }
      if (socket.readyState === 1) socket.ping()
    }, 500)
  socket.on('pong', () => {
    lastPong = Date.now()
  })
  socket.on('open', () => send({ type: 'hello', protocol: 'mhs-peer/v1' }))
  socket.on('error', close)
  socket.on('close', close)
  signal.addEventListener('abort', close, { once: true })
  socket.on('message', (raw, binary) => {
    const bytes = payload(raw)
    try {
      if (binary) {
        if (!greeted) throw new MhsError('peer-handshake-required')
        const sample = decodeMedia(new Uint8Array(bytes as Buffer))
        if (!links.has(sample.device)) throw new MhsError('foreign-device')
        events.observation(sample.device, sample.source, sample.data, sample.bytes, sample.mime)
        return
      }
      const m = object(JSON.parse(bytes.toString()))
      if (m.type === 'hello' && !greeted && m.protocol === 'mhs-peer/v1') {
        if (!Array.isArray(m.devices) || m.devices.length > 32) throw new MhsError('invalid-peer')
        for (const raw of m.devices) {
          const row = object(raw),
            registration = validateRegistration(row.registration),
            id = registration.device.id
          if (links.has(id)) throw new MhsError('duplicate-device')
          const link: DeviceLink = {
            registration,
            get available() {
              return !ended && socket.readyState === 1
            },
            request: (method, params, timeout) => request(id, method, params as Json, timeout),
            async call(call, name, args, caller) {
              const acceptance = object(
                await request(id, 'call', { call, name, args, ...(caller ? { caller } : {}) }),
              )
              const rejection = {
                ...(typeof acceptance.reason === 'string' ? { reason: acceptance.reason } : {}),
                ...(acceptance.holder ? { holder: acceptance.holder as ResourceHolder } : {}),
                ...(Array.isArray(acceptance.needs) ? { needs: acceptance.needs as string[] } : {}),
              }
              const result =
                acceptance.accepted === true
                  ? request(
                      id,
                      'outcome',
                      { call },
                      ((registration.tools?.find((t) => t.name === name)?.timeout ?? 1) + 5) * 1000,
                    ).then(
                      (v) => {
                        const o = object(v)
                        if (
                          !['done', 'error', 'interrupted', 'rejected', 'unknown'].includes(String(o.status))
                        )
                          throw new MhsError('invalid-outcome')
                        return o as unknown as Outcome
                      },
                      () => ({ status: 'unknown' as const, reason: 'disconnect' }),
                    )
                  : Promise.resolve({ status: 'rejected' as const, ...rejection })
              return {
                accepted: acceptance.accepted === true,
                ...rejection,
                result,
              }
            },
            async clip(clip, rate, channels, pcm) {
              await request(id, 'mhs/clip-prepare', {
                id: clip,
                rate,
                channels,
                bytes: pcm.length,
                sha256: createHash('sha256').update(pcm).digest('hex'),
              })
              for (let offset = 0; offset < pcm.length; offset += 2048) {
                const chunk = pcm.subarray(offset, offset + 2048)
                const ack = object(await request(id, 'mhs/clip-chunk', { id: clip }, 2000, chunk))
                if (ack.cached !== (offset + chunk.length === pcm.length))
                  throw new MhsError('clip-unconfirmed')
              }
            },
            manual: (axes) => send({ type: 'manual', device: id, axes }),
            close,
          }
          links.set(id, link)
          events.online(link)
          events.state(id, object(row.state) as Record<string, Json>)
        }
        greeted = true
        clearTimeout(startup)
        resolveReady()
        return
      }
      if (!greeted) throw new MhsError('peer-handshake-required')
      if (m.type === 'response') {
        const p = pending.get(String(m.id))
        if (!p) return
        pending.delete(String(m.id))
        clearTimeout(p.timer)
        if (m.error) p.reject(new MhsError('external-device-refused'))
        else p.resolve(m.value)
        return
      }
      const id = String(m.device)
      if (!links.has(id)) throw new MhsError('foreign-device')
      if (m.type === 'state') events.state(id, object(m.values) as Record<string, Json>)
      else if (m.type === 'progress') events.progress(id, String(m.call), (m.data ?? null) as Json)
      else throw new MhsError('invalid-peer-message')
    } catch {
      close()
    }
  })
  try {
    await ready
    signal.throwIfAborted()
  } catch (error) {
    close()
    throw error
  }
  return {
    close,
    get connected() {
      return !ended && socket.readyState === 1
    },
  }
}

/** Attach only a server-authenticated, exclusive socket to an SDK fleet. No listener or auth
 * fallback is opened here. Remote stop/connection loss invokes device-local safety. */
export function serveExternalHubPeer(
  socket: WebSocket,
  devices: readonly Device[],
  signal: AbortSignal,
): () => void {
  if (
    signal.aborted ||
    devices.length > 32 ||
    new Set(devices.map((d) => d.description.device.id)).size !== devices.length ||
    devices.some((d) => peerOwners.has(d))
  ) {
    socket.close(1008, 'fleet-unavailable')
    return () => {}
  }
  for (const d of devices) peerOwners.set(d, socket)
  const fleet = new Map(devices.map((d) => [d.description.device.id, d])),
    outcomes = new Map<string, Promise<Outcome>>(),
    clips = new Clips(() => Date.now())
  let hello = false,
    ended = false,
    lastPong = Date.now()
  const send = (value: Json | Uint8Array) => {
    if (ended) return
    if (socket.bufferedAmount > 1 << 20) {
      close()
      return
    }
    const frame = value instanceof Uint8Array ? value : JSON.stringify(value)
    if ((typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength) > 1 << 20) {
      close()
      return
    }
    socket.send(frame)
  }
  const close = () => {
    if (ended) return
    ended = true
    signal.removeEventListener('abort', close)
    clearInterval(heartbeat)
    for (const d of devices) {
      if (peerOwners.get(d) === socket) peerOwners.delete(d)
      d.onObservation = undefined
      d.onState = undefined
      d.onProgress = undefined
      void d.stop('peer-disconnect')
    }
    socket.close()
    outcomes.clear()
    clips.revoke()
  }
  const heartbeat = setInterval(() => {
    if (Date.now() - lastPong > 1500) {
      close()
      return
    }
    if (socket.readyState === 1) socket.ping()
  }, 500)
  socket.on('pong', () => {
    lastPong = Date.now()
  })
  socket.on('close', close)
  socket.on('error', close)
  signal.addEventListener('abort', close, { once: true })
  socket.on('message', async (raw, binary) => {
    const bytes = payload(raw)
    try {
      if (bytes.length > 65536) throw new MhsError('invalid-peer-message')
      const frame = binary ? decodeMedia(bytes) : undefined
      const m = frame ? { ...object(frame.data), device: frame.device } : object(JSON.parse(bytes.toString()))
      if (binary && (!hello || frame?.source !== 'clip' || m.method !== 'mhs/clip-chunk'))
        throw new MhsError('invalid-peer-message')
      if (!hello) {
        if (m.type !== 'hello' || m.protocol !== 'mhs-peer/v1') throw new MhsError('invalid-peer')
        hello = true
        send({
          type: 'hello',
          protocol: 'mhs-peer/v1',
          devices: devices.map((d) => ({ registration: d.description, state: d.state() })) as unknown as Json,
        })
        for (const d of devices) {
          const id = d.description.device.id
          d.onState = (values) => send({ type: 'state', device: id, values })
          d.onProgress = (call, data) => send({ type: 'progress', device: id, call, data })
          d.onObservation = (o, bytes) => {
            send(
              encodeMedia({
                device: id,
                source: o.source,
                at: Date.now(),
                data: o.data as Json,
                ...(bytes ? { bytes } : {}),
                ...(o.mime ? { mime: o.mime } : {}),
              }),
            )
            return !ended
          }
        }
        return
      }
      const d = fleet.get(String(m.device))
      if (!d) throw new MhsError('foreign-device')
      if (m.type === 'manual') {
        const axes = object(m.axes)
        if (Object.values(axes).every((v) => v === 0)) await d.stop('manual-zero')
        else await d.manual(axes)
        return
      }
      if (m.type !== 'request' || typeof m.id !== 'string') throw new MhsError('invalid-peer-message')
      const params = object(m.params)
      try {
        let value: unknown
        switch (m.method) {
          case 'call': {
            if (outcomes.size >= 128) throw new MhsError('peer-capacity')
            const c = d.call(
              String(params.call),
              String(params.name),
              object(params.args) as Record<string, Json>,
              typeof params.caller === 'string' ? params.caller : undefined,
            )
            if (c.result) outcomes.set(`${m.device}/${params.call}`, c.result)
            value = {
              accepted: c.accepted,
              ...(c.reason ? { reason: c.reason } : {}),
              ...(c.holder ? { holder: c.holder } : {}),
              ...(c.needs ? { needs: c.needs } : {}),
            }
            break
          }
          case 'outcome': {
            const key = `${m.device}/${params.call}`,
              p = outcomes.get(key)
            if (!p) throw new MhsError('unknown-call')
            value = await p
            outcomes.delete(key)
            break
          }
          case 'mhs/stop':
            await d.stop('hub-stop')
            value = {}
            break
          case 'mhs/set':
            value = d.set(object(params.values ?? params) as Record<string, Json>)
            break
          case 'mhs/configure':
            value = await d.configure(params.sources)
            break
          case 'mhs/keyframe':
            await d.onKeyframe?.(String(params.source))
            value = {}
            break
          case 'mhs/clip-prepare': {
            const spec = clipSpec(params as Json)
            clips.grant(`${m.device}/${spec.id}`, String(m.device), 'peer', spec, Date.now() + 30000)
            value = {}
            break
          }
          case 'mhs/clip-chunk': {
            const key = `${m.device}/${params.id}`
            const pcm = clips.append(key, String(m.device), 'peer', frame?.bytes ?? new Uint8Array())
            if (pcm) {
              const spec = clips.consume(key, String(m.device), 'peer', pcm)
              d.receiveClip(spec.id, spec.rate, spec.channels, pcm)
            }
            value = { cached: Boolean(pcm) }
            break
          }
          case 'mhs/pause':
            await d.pause(String(params.call))
            value = {}
            break
          case 'mhs/resume':
            await d.resume(String(params.call))
            value = {}
            break
          case 'mhs/cancel':
            await d.cancel(String(params.call))
            value = {}
            break
          default:
            throw new MhsError('unknown-peer-method')
        }
        send({ type: 'response', id: m.id, value: (value ?? null) as Json })
      } catch {
        send({ type: 'response', id: m.id, error: true })
      }
    } catch {
      close()
    }
  })
  if (signal.aborted) close()
  return close
}
