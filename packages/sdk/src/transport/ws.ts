import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { ProtocolViolation, TransportClosed, Unsupported } from '../errors.js'
import { parseMessage } from './jsonl.js'
import type { CloseInfo, Transport, TransportFactory } from './types.js'

export type SocketEvent = { data?: unknown }
export type WebSocketLike = {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', handler: (event: SocketEvent) => void): void
  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    handler: (event: SocketEvent) => void,
  ): void
  ping?(): void
  on?(type: 'pong', handler: () => void): void
  off?(type: 'pong', handler: () => void): void
  terminate?(): void
}
export type SocketOptions = {
  ca?: string
  rejectUnauthorized?: boolean
  headers?: Record<string, string>
  protocols?: string[]
}
export type WsOptions = {
  url: string
  tls?: { ca?: string; rejectUnauthorized?: boolean }
  headers?: Record<string, string>
  protocols?: string[]
  pingIntervalMs?: number
  connectTimeoutMs?: number
  socketFactory?: (url: string, options: SocketOptions) => WebSocketLike
}
const encoder = new TextEncoder()
const timeout = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new TypeError('invalid WebSocket timeout')
  return value
}
function browserSocket(url: string, options: SocketOptions): WebSocketLike {
  const { protocols, ...nodeOnly } = options
  if (Object.keys(nodeOnly).length) throw new Unsupported('browser WebSocket headers/TLS options')
  if (typeof globalThis.WebSocket !== 'function') throw new Unsupported('WebSocket')
  return new globalThis.WebSocket(url, protocols) as unknown as WebSocketLike
}

/** One JSON-RPC message per text message; no Node imports in the shared/browser graph. */
export function wsTransport(options: WsOptions): TransportFactory {
  let url: URL
  try {
    url = new URL(options.url)
  } catch {
    throw new TypeError('invalid WebSocket URL')
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new TypeError('invalid WebSocket URL')
  const address = url.href
  const pingInterval = timeout(options.pingIntervalMs ?? 30_000)
  const connectTimeout = timeout(options.connectTimeoutMs ?? 3_000)
  const socketOptions: SocketOptions = {
    ...options.tls,
    ...(options.headers ? { headers: { ...options.headers } } : {}),
    ...(options.protocols ? { protocols: [...options.protocols] } : {}),
  }
  const factory = options.socketFactory ?? browserSocket
  return async (handlers) => {
    let socket: WebSocketLike
    try {
      socket = factory(address, socketOptions)
    } catch (error) {
      if (factory === browserSocket && error instanceof Unsupported) throw error
      throw new TransportClosed({ reason: 'error', error: new Error('WebSocket connection failed') })
    }
    let closed = false
    let opened = false
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let missed = 0
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const pong = () => {
      missed = 0
    }
    const removeListeners = () => {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      socket.removeEventListener('error', onError)
      socket.off?.('pong', pong)
      if (forceTimer) clearTimeout(forceTimer)
    }
    const finish = (info: CloseInfo, peerClosed = false) => {
      if (closed) return
      closed = true
      if (connectTimer) clearTimeout(connectTimer)
      if (pingTimer) clearInterval(pingTimer)
      if (!opened) rejectReady(new TransportClosed(info))
      if (peerClosed) removeListeners()
      else {
        // Keep the error listener until actual close: ws emits an error when an opening handshake is aborted.
        try {
          socket.close(info.reason === 'closed' ? 1000 : 1002, 'SDK transport closed')
        } catch {
          socket.terminate?.()
        }
        if (socket.readyState === 3) removeListeners()
        else if (socket.terminate) forceTimer = setTimeout(() => socket.terminate?.(), 1_000)
      }
      handlers.onClose(info)
    }
    const onOpen = () => {
      if (closed || opened) return
      opened = true
      if (connectTimer) clearTimeout(connectTimer)
      if (socket.ping && socket.on) {
        socket.on('pong', pong)
        pingTimer = setInterval(() => {
          if (missed >= 2) {
            finish({ reason: 'error', error: new Error('WebSocket ping timeout') })
            return
          }
          missed++
          try {
            socket.ping?.()
          } catch {
            finish({ reason: 'error', error: new Error('WebSocket ping failed') })
          }
        }, pingInterval)
      }
      resolveReady()
    }
    const onMessage = (event: SocketEvent) => {
      if (closed) return
      try {
        if (typeof event.data !== 'string')
          throw new ProtocolViolation('WebSocket requires text messages', 'invalid-envelope')
        if (encoder.encode(event.data).byteLength > MAX_FRAME_BYTES)
          throw new ProtocolViolation('inbound WebSocket frame exceeds limit', 'frame-too-large')
        handlers.onMessage(parseMessage(event.data))
      } catch (error) {
        finish({
          reason: 'error',
          error: error instanceof ProtocolViolation ? error : new Error('WebSocket message failed'),
        })
      }
    }
    const onClose = () => {
      if (closed) removeListeners()
      else finish({ reason: 'eof' }, true)
    }
    const onError = () => finish({ reason: 'error', error: new Error('WebSocket connection failed') })
    socket.addEventListener('open', onOpen)
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    socket.addEventListener('error', onError)
    connectTimer = setTimeout(
      () => finish({ reason: 'error', error: new Error('WebSocket connection timeout') }),
      connectTimeout,
    )
    if (socket.readyState === 1) onOpen()
    else if (socket.readyState >= 2) onClose()
    await ready
    const transport: Transport = {
      kind: 'ws',
      async send(message) {
        if (closed) throw new TransportClosed({ reason: 'closed' })
        let text: string
        try {
          text = JSON.stringify(message)
        } catch {
          throw new ProtocolViolation('invalid outbound WebSocket message', 'invalid-json')
        }
        if (typeof text !== 'string')
          throw new ProtocolViolation('invalid outbound WebSocket message', 'invalid-json')
        const bytes = encoder.encode(text).byteLength
        if (bytes > MAX_FRAME_BYTES || socket.bufferedAmount + bytes > MAX_FRAME_BYTES)
          throw new ProtocolViolation('outbound WebSocket frame or queue exceeds limit', 'frame-too-large')
        try {
          socket.send(text)
        } catch {
          const info: CloseInfo = { reason: 'error', error: new Error('WebSocket send failed') }
          finish(info)
          throw new TransportClosed(info)
        }
      },
      async close() {
        finish({ reason: 'closed' })
      },
    }
    return transport
  }
}
