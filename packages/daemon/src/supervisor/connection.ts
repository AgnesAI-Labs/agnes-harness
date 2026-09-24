import type { Duplex } from 'node:stream'
import { type AgnesErrorName, rpcError } from '@agnes/protocol'
import { DEFAULT_LIMITS } from '../local/attached.js'
import type { RpcEndpoint } from '../local/endpoint.js'
import type { JsonRpcMessage } from '../rpc.js'
import { encodeFrame, FrameTooLarge, JsonlDecoder } from './framing.js'

function message(value: unknown): value is JsonRpcMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const has = (key: string) => Object.hasOwn(v, key)
  const id = typeof v.id === 'string' || (typeof v.id === 'number' && Number.isFinite(v.id))
  if (v.jsonrpc !== '2.0') return false
  if (has('method'))
    return typeof v.method === 'string' && (!has('id') || id) && !has('result') && !has('error')
  if (!id || has('result') === has('error')) return false
  if (!has('error')) return true
  const error = v.error as Record<string, unknown> | null
  return (
    !!error && typeof error === 'object' && Number.isInteger(error.code) && typeof error.message === 'string'
  )
}

/** One endpoint per socket; concurrent dispatch permits replies during a pending permission ask. */
export function bindConnection(
  socket: Duplex,
  ep: RpcEndpoint,
  options: { onClose(): void },
): { closed: Promise<void> } {
  const decoder = new JsonlDecoder()
  let terminal = false
  let cleaned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = 0
  let pendingBytes = 0
  let writes = 0
  let finish!: () => void
  const closed = new Promise<void>((resolve) => {
    finish = resolve
  })
  let endpointClose: Promise<void> | undefined
  const closeEndpoint = () =>
    (endpointClose ??= Promise.resolve()
      .then(() => ep.close())
      .catch(() => {}))
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    terminal = true
    if (timer !== undefined) clearTimeout(timer)
    void closeEndpoint()
      .finally(() => {
        try {
          options.onClose()
        } finally {
          finish()
        }
      })
      .catch(() => {})
  }
  const stop = (name?: AgnesErrorName) => {
    if (terminal) return
    terminal = true
    socket.pause()
    void closeEndpoint()
    if (!name) {
      socket.destroy()
      return
    }
    // Give the small final error a bounded chance to flush; never expose the original error.
    timer = setTimeout(() => socket.destroy(), 1000)
    socket.end(encodeFrame({ jsonrpc: '2.0', id: null, error: rpcError(name) }), () => socket.destroy())
  }
  const send = (value: JsonRpcMessage) => {
    if (terminal) return
    let bytes: Buffer
    try {
      bytes = encodeFrame(value)
    } catch {
      stop('INTERNAL_ERROR')
      return
    }
    if (
      writes >= DEFAULT_LIMITS.subscribeBufferEvents ||
      socket.writableLength + bytes.length > DEFAULT_LIMITS.subscribeBufferBytes
    ) {
      stop('OVERLOADED')
      return
    }
    writes++
    socket.write(bytes, (error) => {
      writes--
      if (error) stop()
    })
  }
  socket.on('data', (chunk: Buffer) => {
    if (terminal) return
    let frames: unknown[]
    try {
      frames = decoder.feed(chunk)
    } catch (error) {
      stop(error instanceof FrameTooLarge ? 'INVALID_REQUEST' : 'PARSE_ERROR')
      return
    }
    for (const frame of frames) {
      if (terminal) break
      if (!message(frame)) {
        stop('INVALID_REQUEST')
        break
      }
      const bytes = Buffer.byteLength(JSON.stringify(frame))
      if (
        pending >= DEFAULT_LIMITS.subscribeBufferEvents ||
        pendingBytes + bytes > DEFAULT_LIMITS.subscribeBufferBytes
      ) {
        stop('OVERLOADED')
        break
      }
      pending++
      pendingBytes += bytes
      void Promise.resolve()
        .then(() => (terminal ? undefined : ep.handle(frame)))
        .then((response) => {
          if (response) send(response)
        })
        .catch(() => stop('INTERNAL_ERROR'))
        .finally(() => {
          pending--
          pendingBytes -= bytes
        })
    }
  })
  socket.on('end', () => {
    if (terminal) return
    try {
      decoder.end()
    } catch {
      stop('PARSE_ERROR')
      return
    }
    stop()
  })
  socket.on('error', () => stop())
  socket.once('close', cleanup)
  void (async () => {
    try {
      for await (const notification of ep.notifications) {
        if (terminal) break
        send(notification)
      }
    } catch {
      stop('INTERNAL_ERROR')
    }
  })()
  return { closed }
}
