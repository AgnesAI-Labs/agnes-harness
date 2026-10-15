import type { PluginStream, StreamFrame } from '@agnes/extension-api'
import {
  decodePluginStreamBinary,
  encodePluginStreamBinary,
  inspectJsonData,
  type JsonValue,
  type StreamDeclaration,
  validatePluginStreamJsonFrame,
} from '@agnes/protocol'

export interface StreamSocket {
  readonly bufferedAmount: number
  send(data: string | Uint8Array, done: (error?: Error) => void): void
  close(code: number, reason: string): void
}
export type Channel = {
  stream: PluginStream
  signal: AbortSignal
  receive(data: Uint8Array, binary: boolean): void
  disconnect(reason: string, code?: number): void
}
export function createStreamChannel(options: {
  id: number
  declaration: StreamDeclaration
  socket: StreamSocket
  signal: AbortSignal
  assertCurrent(): void
  /** Profile media budget; control never shares a queue or budget with media. */
  mediaBudget(bytes: number): boolean
  profileBuffered(): number
  now(): number
  released(): void
}): Channel {
  const { socket, declaration: d } = options
  const abort = new AbortController()
  const frames = new Set<(frame: StreamFrame) => void>()
  const drops = new Set<(info: { reason: 'backpressure'; count: number }) => void>()
  const disconnects = new Set<(info: { reason: string }) => void | Promise<void>>()
  let stopped = false
  let stopReason = 'closed'
  let outputSequence = 0
  let inputSequence = -1
  let windowStart = options.now()
  let inputBytes = 0,
    outputBytes = 0,
    inputCount = 0,
    outputCount = 0
  function current(): boolean {
    if (stopped) return false
    try {
      options.assertCurrent()
      options.signal.throwIfAborted()
      return true
    } catch {
      disconnect('revoked', 1008)
      return false
    }
  }
  function window(): void {
    const now = options.now()
    if (now - windowStart >= 1000) {
      windowStart = now
      inputBytes = outputBytes = inputCount = outputCount = 0
    }
  }
  function disconnect(reason: string, code = 1000): void {
    if (stopped) return
    stopped = true
    stopReason = reason
    options.signal.removeEventListener('abort', revoke)
    const notifications = [...disconnects]
    disconnects.clear()
    abort.abort(reason)
    frames.clear()
    drops.clear()
    options.released()
    for (const fn of notifications)
      void Promise.resolve()
        .then(() => fn({ reason }))
        .catch(() => undefined)
    // Application close reasons never carry plugin exception text or credentials.
    try {
      socket.close(code, reason)
    } catch {
      /* Already gone. */
    }
  }
  function revoke(): void {
    disconnect('revoked', 1008)
  }
  options.signal.addEventListener('abort', revoke, { once: true })
  function overflow(): 'dropped' | 'closed' {
    if (d.lane !== 'media') {
      disconnect(d.lane === 'events' ? 'reopen' : 'overloaded', 1013)
      return 'closed'
    }
    for (const fn of drops) {
      try {
        fn({ reason: 'backpressure', count: 1 })
      } catch {
        disconnect('unavailable', 1011)
      }
    }
    return stopped ? 'closed' : 'dropped'
  }
  const stream: PluginStream = Object.freeze({
    send(frame: StreamFrame) {
      if (!current()) return 'closed'
      if (!d.directions.includes('outbound')) {
        disconnect('protocol', 1008)
        return 'closed'
      }
      let encoded: string | Uint8Array
      try {
        if (outputSequence > 0xffffffff) {
          disconnect('reopen', 1013)
          return 'closed'
        }
        if (frame instanceof Uint8Array)
          encoded = encodePluginStreamBinary(options.id, outputSequence++, frame)
        else {
          const data = inspectJsonData(frame, 4096)
          if (!data.ok) throw new Error('invalid JSON')
          encoded = JSON.stringify({
            version: 1,
            streamId: options.id,
            sequence: outputSequence++,
            kind: 'json',
            data: data.value,
          })
        }
      } catch {
        disconnect('protocol', 1009)
        return 'closed'
      }
      const bytes = typeof encoded === 'string' ? Buffer.byteLength(encoded) : encoded.byteLength
      if (bytes > d.maxFrameBytes || (typeof encoded === 'string' && bytes > 4096)) {
        disconnect('protocol', 1009)
        return 'closed'
      }
      window()
      if (
        outputBytes + bytes > d.maxBytesPerSecond ||
        (d.lane === 'control' && outputCount >= 30) ||
        socket.bufferedAmount + bytes > d.maxBufferedBytes ||
        (d.lane === 'media' &&
          (options.profileBuffered() + bytes > 16 * 1024 * 1024 || !options.mediaBudget(bytes)))
      )
        return overflow()
      outputBytes += bytes
      outputCount++
      try {
        socket.send(encoded, (error) => {
          if (error) disconnect('unavailable', 1011)
        })
      } catch {
        disconnect('unavailable', 1011)
        return 'closed'
      }
      return stopped ? 'closed' : 'accepted'
    },
    onFrame(fn: (frame: StreamFrame) => void) {
      if (!stopped) frames.add(fn)
      return () => {
        frames.delete(fn)
      }
    },
    onDrop(fn: (info: { reason: 'backpressure'; count: number }) => void) {
      if (!stopped) drops.add(fn)
      return () => {
        drops.delete(fn)
      }
    },
    onDisconnect(fn: (info: { reason: string }) => void | Promise<void>) {
      if (stopped)
        void Promise.resolve()
          .then(() => fn({ reason: stopReason }))
          .catch(() => undefined)
      else disconnects.add(fn)
      return () => {
        disconnects.delete(fn)
      }
    },
    close: () => disconnect('closed'),
  })
  function receive(bytes: Uint8Array, binary: boolean): void {
    if (!current()) return
    if (!d.directions.includes('inbound')) {
      disconnect('protocol', 1008)
      return
    }
    if (bytes.byteLength > d.maxFrameBytes || (!binary && bytes.byteLength > 4096)) {
      disconnect('protocol', 1009)
      return
    }
    window()
    if (
      inputBytes + bytes.byteLength > d.maxBytesPerSecond ||
      inputCount >= (d.lane === 'control' ? 30 : 1024) ||
      (d.lane === 'media' && !options.mediaBudget(bytes.byteLength))
    ) {
      disconnect('overloaded', 1013)
      return
    }
    inputBytes += bytes.byteLength
    inputCount++
    let payload: StreamFrame, id: number, sequence: number
    try {
      if (binary) {
        const frame = decodePluginStreamBinary(bytes)
        payload = frame.payload
        id = frame.streamId
        sequence = frame.sequence
      } else {
        const parsed = validatePluginStreamJsonFrame(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        )
        if (!parsed.ok) throw new Error('invalid frame')
        payload = parsed.value.data as JsonValue
        id = parsed.value.streamId
        sequence = parsed.value.sequence
      }
      if (id !== options.id || sequence !== inputSequence + 1) throw new Error('invalid sequence')
      inputSequence = sequence
      for (const fn of frames) fn(payload)
    } catch {
      disconnect('protocol', 1008)
    }
  }
  if (options.signal.aborted) revoke()
  return { stream, signal: abort.signal, receive, disconnect }
}
