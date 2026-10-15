import type { StreamContext } from '@agnes/extension-api'
import { type Json, type Outcome, object, validateRegistration } from '@agnes/mhs-device'
import type { DeviceLink, North } from '@agnes/mhs-hub'

/** Authenticated simulated-device ingress. Only a reviewed backend bridge can stamp producer.
 * Data/media never carry user motion admission; commands originate exclusively in the Hub. */
export function createMhsProducer(north: () => Promise<North>) {
  type Fleet = {
    context: StreamContext
    links: Map<string, DeviceLink>
    receive(frame: Uint8Array | Json): void
    close(): void
  }
  const fleets = new Map<string, Fleet>()
  const key = (input: Json, context: StreamContext) => {
    const token = object(input).fleet
    if (
      !context.producer ||
      context.scope.kind !== 'profile' ||
      typeof token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(token)
    )
      throw new Error('reviewed-producer-required')
    return JSON.stringify([
      context.scope.profileId,
      context.producer.owner,
      context.producer.activationId,
      context.source,
      context.actor.org,
      context.actor.id,
      token,
    ])
  }
  return {
    async devices(input: Json, context: StreamContext) {
      const id = key(input, context),
        hub = (await north()).hub
      context.signal.throwIfAborted()
      if (fleets.has(id) || fleets.size >= 16) throw new Error('duplicate-producer')
      const links = new Map<string, DeviceLink>()
      const pending = new Map<
        string,
        { resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
      >()
      let sequence = 0,
        ended = false
      const send = (value: Json) => {
        context.signal.throwIfAborted()
        if (context.stream.send(value) !== 'accepted') throw new Error('producer-unavailable')
      }
      const request = (device: string, method: string, params: Record<string, unknown>, timeout = 2000) => {
        if (ended || pending.size >= 128) return Promise.reject(new Error('producer-unavailable'))
        const requestId = String(++sequence)
        return new Promise<Json>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId)
            reject(new Error('producer-timeout'))
            context.stream.close('timeout')
          }, timeout)
          pending.set(requestId, { resolve, reject, timer })
          try {
            send({ type: 'request', device, requestId, method, params: params as Json })
          } catch (error) {
            pending.delete(requestId)
            clearTimeout(timer)
            reject(error)
          }
        })
      }
      const close = () => {
        if (ended) return
        ended = true
        fleets.delete(id)
        for (const p of pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error('producer-disconnected'))
        }
        pending.clear()
        for (const [device, link] of links) hub.offline(device, link)
        links.clear()
      }
      const receive = (frame: Uint8Array | Json) => {
        const m = object(
          frame instanceof Uint8Array
            ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame))
            : frame,
        )
        if (m.type === 'ping' && Number.isSafeInteger(m.nonce)) {
          send({ type: 'pong', nonce: m.nonce as number })
          return
        }
        const device = String(m.device)
        if (m.type === 'register') {
          const registration = validateRegistration(m.registration)
          if (
            registration.device.id !== device ||
            links.has(device) ||
            links.size >= 32 ||
            hub.snapshot().some((d) => d.id === device && d.online)
          )
            throw new Error('device-already-owned')
          let parked = false,
            commandEpoch = 0
          const link: DeviceLink = {
            registration,
            get available() {
              return links.get(device) === link && !ended && !context.signal.aborted
            },
            async request(method, params, timeout) {
              if (method === 'mhs/stop' && links.get(device) !== link && parked) return {}
              const epoch = ++commandEpoch
              parked = false
              const result = await request(device, method, params, timeout)
              parked = method === 'mhs/stop' && epoch === commandEpoch
              return result
            },
            async call(call, name, args) {
              commandEpoch++
              parked = false
              // Device acceptance and terminal outcome are distinct responses.
              const acceptance = object(await request(device, 'call', { call, name, args }))
              const result = request(
                device,
                'outcome',
                { call },
                ((registration.tools?.find((t) => t.name === name)?.timeout ?? 1) + 5) * 1000,
              ).then(
                (v) => {
                  const o = object(v)
                  if (!['done', 'error', 'interrupted', 'unknown', 'rejected'].includes(String(o.status)))
                    throw new Error('invalid-outcome')
                  return o as unknown as Outcome
                },
                () => ({ status: 'unknown' as const, reason: 'disconnect' }),
              )
              return {
                accepted: acceptance.accepted === true,
                ...(typeof acceptance.reason === 'string' ? { reason: acceptance.reason } : {}),
                result,
              }
            },
            manual: (axes) => {
              if (links.get(device) !== link && parked) return
              commandEpoch++
              parked = false
              send({ type: 'manual', device, axes })
            },
            close: () => context.stream.close('device-closed'),
          }
          links.set(device, link)
          hub.online(link)
          hub.state(device, object(m.state) as Record<string, Json>)
          send({ type: 'registered', device })
          return
        }
        if (!links.has(device)) throw new Error('foreign-device')
        switch (m.type) {
          case 'response': {
            const p = pending.get(String(m.requestId))
            if (!p) return
            pending.delete(String(m.requestId))
            clearTimeout(p.timer)
            if (m.error) p.reject(new Error('device-refused'))
            else p.resolve((m.value ?? null) as Json)
            return
          }
          case 'state':
            hub.state(device, object(m.values) as Record<string, Json>)
            return
          case 'progress':
            hub.progress(device, String(m.call), (m.data ?? null) as Json)
            return
          case 'detach': {
            const link = links.get(device)!
            void link
              .request('mhs/stop', {})
              .then(() => {
                links.delete(device)
                hub.offline(device, link)
                send({ type: 'detached', device })
              })
              .catch(() => context.stream.close('stop-unconfirmed'))
            return
          }
          default:
            throw new Error('invalid-producer-message')
        }
      }
      const fleet = { context, links, receive, close }
      fleets.set(id, fleet)
      context.stream.onFrame((frame) => {
        try {
          receive(frame)
        } catch {
          context.stream.close('invalid-producer')
        }
      })
      context.stream.onDisconnect(close)
      context.signal.addEventListener('abort', close, { once: true })
    },
    async media(input: Json, context: StreamContext) {
      const fleet = fleets.get(key(input, context))
      if (!fleet) throw new Error('producer-not-connected')
      const hub = (await north()).hub
      context.stream.onFrame((frame) => {
        try {
          if (!(frame instanceof Uint8Array) || frame.length < 4) throw new Error('invalid-media')
          const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0)
          if (size > 4096 || size + 4 > frame.length) throw new Error('invalid-media')
          const m = object(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4, size + 4))),
          )
          const device = String(m.device),
            source = String(m.source)
          if (!fleet.links.has(device) || !fleets.has(key(input, context))) throw new Error('foreign-media')
          hub.observation(
            device,
            source,
            (m.data ?? null) as Json,
            frame.length > size + 4 ? frame.subarray(size + 4) : undefined,
            typeof m.mime === 'string' ? m.mime : undefined,
          )
        } catch {
          context.stream.close('invalid-media')
        }
      })
      fleet.context.stream.onDisconnect(() => context.stream.close('producer-disconnected'))
      context.stream.onDisconnect(() => fleet.context.stream.close('media-disconnected'))
      context.signal.throwIfAborted()
      context.stream.send({ type: 'media-ready' })
    },
  }
}
