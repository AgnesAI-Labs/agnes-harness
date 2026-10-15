import { validateCommand } from './commands.js'
import type { Device } from './device.js'
import type { Json, Observation } from './schema.js'
import { object } from './validation.js'

/** Browser-compatible adapter. Each connection owns both sockets; no action survives reconnect. */
export async function connectDevice(device: Device, base: string, signal: AbortSignal): Promise<void> {
  const root = new URL(base)
  if (!['ws:', 'wss:'].includes(root.protocol) || root.username || root.password)
    throw new Error('invalid-hub-url')
  let replaced = false
  let attempt = 0
  while (!signal.aborted && !replaced) {
    device.reconnect()
    const cmd = new WebSocket(new URL('/ws/mhs', root), 'mhs.v1')
    const nerve = new WebSocket(new URL('/ws/nerve', root), 'mhs.v1')
    nerve.binaryType = 'arraybuffer'
    let registered = false
    let nerveHello = false
    let clip: { id: string; rate: number; channels: number } | undefined
    let lastReply = Date.now()
    const hello = () => {
      if (registered && nerve.readyState === WebSocket.OPEN && !nerveHello) {
        nerve.send(JSON.stringify({ type: 'hello', device: device.description.device.id }))
        nerveHello = true
      }
    }
    device.onObservation = (observation, bytes) => nerveHello && publishObservation(nerve, observation, bytes)
    const send = (message: unknown) => {
      if (cmd.readyState === WebSocket.OPEN) cmd.send(JSON.stringify(message))
    }
    const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })
    device.onState = (values) => {
      if (registered) send({ jsonrpc: '2.0', method: 'mhs/state', params: { t: Date.now() / 1000, values } })
    }
    device.onProgress = (call, data) =>
      send({ jsonrpc: '2.0', method: 'mhs/progress', params: { call, data } })
    const ended = new Promise<void>((resolve) => {
      const close = () => {
        cmd.close()
        nerve.close()
        resolve()
      }
      cmd.onopen = () =>
        send({ jsonrpc: '2.0', id: 'register', method: 'mhs/register', params: device.description })
      nerve.onopen = hello
      nerve.onmessage = (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            if (!clip) return close()
            device.receiveClip(clip.id, clip.rate, clip.channels, new Uint8Array(event.data))
            clip = undefined
            return
          }
          if (clip) return close()
          const m = object(JSON.parse(String(event.data)))
          if (m.type === 'clip') {
            if (typeof m.id !== 'string' || typeof m.rate !== 'number' || typeof m.channels !== 'number')
              return close()
            clip = { id: m.id, rate: m.rate, channels: m.channels }
            return
          }
          if (m.type === 'manual') void device.manual(m.axes).catch(close)
        } catch {
          close()
        }
      }
      cmd.onmessage = (event) => {
        let requestId: unknown
        void (async () => {
          const m = object(JSON.parse(String(event.data)))
          validateCommand(m)
          requestId = m.id
          lastReply = Date.now()
          if (m.id === 'register') {
            if (!m.result) return close()
            registered = true
            hello()
            device.onState?.(device.state())
            return
          }
          if (typeof m.method !== 'string') return
          const p = object(m.params ?? {})
          let result: unknown = {}
          switch (m.method) {
            case 'mhs/call': {
              const acceptance = device.call(String(m.id), String(p.name), p.arguments)
              reply(m.id, {
                accepted: acceptance.accepted,
                ...(acceptance.reason ? { reason: acceptance.reason, status: 'rejected' } : {}),
              })
              if (acceptance.result)
                void acceptance.result.then((outcome) =>
                  send({ jsonrpc: '2.0', method: 'mhs/result', params: { call: m.id, ...outcome } }),
                )
              return
            }
            case 'mhs/stop':
              await device.stop()
              break
            case 'mhs/cancel':
              await device.cancel(String(p.call))
              break
            case 'mhs/pause':
              await device.pause(String(p.call))
              break
            case 'mhs/resume':
              device.resume(String(p.call))
              break
            case 'mhs/set':
              result = device.set(object(p.values) as Record<string, Json>)
              break
            case 'mhs/configure':
              result = await device.configure(p.sources ?? {})
              break
            case 'mhs/keyframe':
              await device.onKeyframe?.(String(p.source))
              break
            case 'mhs/time':
              result = { t: Date.now() / 1000 }
              break
            case 'mhs/ping':
              break
            default:
              send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } })
              return
          }
          reply(m.id, result)
        })().catch(() =>
          send({ jsonrpc: '2.0', id: requestId, error: { code: -32602, message: 'invalid-or-unsafe' } }),
        )
      }
      cmd.onclose = (event) => {
        replaced = event.code === 4001 || event.code === 4003
        close()
      }
      nerve.onclose = close
      cmd.onerror = close
      nerve.onerror = close
      signal.addEventListener('abort', close, { once: true })
      void new Promise<void>((r) =>
        cmd.addEventListener(
          'close',
          () => {
            signal.removeEventListener('abort', close)
            r()
          },
          { once: true },
        ),
      )
    })
    const ping = setInterval(() => {
      if (Date.now() - lastReply > 5000) {
        cmd.close()
        nerve.close()
      } else if (registered)
        send({ jsonrpc: '2.0', id: `ping-${Date.now()}`, method: 'mhs/ping', params: {} })
    }, 2000)
    await ended
    clearInterval(ping)
    device.onObservation = undefined
    device.onState = undefined
    device.onProgress = undefined
    await device.disconnect()
    if (signal.aborted || replaced) break
    await new Promise<void>((resolve) => {
      const abort = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(
        () => {
          signal.removeEventListener('abort', abort)
          resolve()
        },
        Math.min(5000, 500 * 2 ** attempt++),
      )
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}
/** Single-socket ordered MOS header+payload writer, bounded before allocating a frame. */
export function publishObservation(
  socket: Pick<WebSocket, 'send' | 'bufferedAmount' | 'readyState'>,
  observation: Observation,
  bytes?: Uint8Array,
): boolean {
  if (
    socket.readyState !== 1 ||
    socket.bufferedAmount > 1 << 20 ||
    (bytes && (bytes.length > 16 << 20 || bytes.length !== observation.bytes))
  )
    return false
  socket.send(JSON.stringify(observation))
  if (bytes) socket.send(new Uint8Array(bytes))
  return true
}
