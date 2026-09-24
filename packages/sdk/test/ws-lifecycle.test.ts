import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { ProtocolViolation, TransportClosed, Unsupported } from '../src/errors.js'
import { type SocketEvent, type WebSocketLike, wsTransport } from '../src/transport/ws.js'

type Kind = 'open' | 'message' | 'close' | 'error'
class Socket implements WebSocketLike {
  readyState = 0
  bufferedAmount = 0
  readonly listeners = new Map<Kind, Set<(event: SocketEvent) => void>>()
  readonly pongs = new Set<() => void>()
  readonly sent: string[] = []
  ping = vi.fn()
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
  addEventListener(kind: Kind, handler: (event: SocketEvent) => void): void {
    const set = this.listeners.get(kind) ?? new Set()
    set.add(handler)
    this.listeners.set(kind, set)
  }
  removeEventListener(kind: Kind, handler: (event: SocketEvent) => void): void {
    this.listeners.get(kind)?.delete(handler)
  }
  on(_kind: 'pong', handler: () => void): void {
    this.pongs.add(handler)
  }
  off(_kind: 'pong', handler: () => void): void {
    this.pongs.delete(handler)
  }
  emit(kind: Kind, event: SocketEvent = {}): void {
    for (const handler of this.listeners.get(kind) ?? []) handler(event)
  }
  open(): void {
    this.readyState = 1
    this.emit('open')
  }
  pong(): void {
    for (const handler of this.pongs) handler()
  }
  count(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0) + this.pongs.size
  }
}
afterEach(() => vi.useRealTimers())
it('uses the default 3000ms handshake deadline and removes all listeners after closing', async () => {
  vi.useFakeTimers()
  const socket = new Socket()
  const closed = vi.fn()
  const pending = wsTransport({ url: 'ws://127.0.0.1/', socketFactory: () => socket })({
    onMessage() {},
    onClose: closed,
  }).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(2999)
  expect(closed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(closed).toHaveBeenCalledOnce()
  expect(await pending).toBeInstanceOf(TransportClosed)
  expect(socket.count()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
it('uses default 30-second ping intervals, resets on pong, and closes after two unanswered windows', async () => {
  vi.useFakeTimers()
  const socket = new Socket()
  const closed = vi.fn()
  const pending = wsTransport({ url: 'ws://127.0.0.1/', socketFactory: () => socket })({
    onMessage() {},
    onClose: closed,
  })
  socket.open()
  const transport = await pending
  await vi.advanceTimersByTimeAsync(29999)
  expect(socket.ping).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(socket.ping).toHaveBeenCalledTimes(1)
  socket.pong()
  await vi.advanceTimersByTimeAsync(60000)
  expect(socket.ping).toHaveBeenCalledTimes(3)
  expect(closed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(30000)
  expect(closed).toHaveBeenCalledOnce()
  expect(socket.count()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  await transport.close()
  expect(closed).toHaveBeenCalledOnce()
})
it('settles close before open without waiting for a handshake timeout', async () => {
  const socket = new Socket()
  const closed = vi.fn()
  const pending = wsTransport({ url: 'ws://127.0.0.1/', socketFactory: () => socket })({
    onMessage() {},
    onClose: closed,
  }).catch((error: unknown) => error)
  socket.close()
  expect(await pending).toBeInstanceOf(TransportClosed)
  expect(closed).toHaveBeenCalledWith({ reason: 'eof' })
  expect(socket.count()).toBe(0)
})
it('bounds the send queue and redacts arbitrary factory or send errors', async () => {
  const socket = new Socket()
  const closed = vi.fn()
  const pending = wsTransport({ url: 'ws://127.0.0.1/', socketFactory: () => socket })({
    onMessage() {},
    onClose: closed,
  })
  socket.open()
  const transport = await pending
  socket.bufferedAmount = MAX_FRAME_BYTES
  await expect(transport.send({ jsonrpc: '2.0', method: 'x' })).rejects.toBeInstanceOf(ProtocolViolation)
  expect(socket.sent).toEqual([])
  socket.bufferedAmount = 0
  socket.send = () => {
    throw new Error('private send marker')
  }
  const failure = await transport.send({ jsonrpc: '2.0', method: 'x' }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(TransportClosed)
  expect(String(failure)).not.toContain('private send marker')
  expect(closed).toHaveBeenCalledOnce()
  const factoryFailure = await wsTransport({
    url: 'ws://127.0.0.1/',
    socketFactory: () => {
      throw new Unsupported('private factory marker')
    },
  })({ onMessage() {}, onClose() {} }).catch((error: unknown) => error)
  expect(factoryFailure).toBeInstanceOf(TransportClosed)
  expect(String(factoryFailure)).not.toContain('private factory marker')
})
it('rejects unsupported browser socket options and invalid limits without disclosing inputs', async () => {
  await expect(
    wsTransport({ url: 'ws://127.0.0.1/', headers: { Authorization: 'private' } })({
      onMessage() {},
      onClose() {},
    }),
  ).rejects.toBeInstanceOf(Unsupported)
  expect(() => wsTransport({ url: 'https://private.example/' })).toThrow('invalid WebSocket URL')
  expect(() => wsTransport({ url: 'ws://u:private@127.0.0.1/' })).toThrow('invalid WebSocket URL')
  for (const value of [0, -1, Number.NaN, 2147483648])
    expect(() => wsTransport({ url: 'ws://127.0.0.1/', pingIntervalMs: value })).toThrow(
      'invalid WebSocket timeout',
    )
})

it('forces a stalled Node close after the default one-second grace period', async () => {
  vi.useFakeTimers()
  const socket = Object.assign(new Socket(), { terminate: vi.fn() })
  socket.close = () => {
    socket.readyState = 2
  }
  socket.terminate.mockImplementation(() => {
    socket.readyState = 3
    socket.emit('close')
  })
  const pending = wsTransport({ url: 'ws://127.0.0.1/', socketFactory: () => socket })({
    onMessage() {},
    onClose() {},
  })
  socket.open()
  const transport = await pending
  await transport.close()
  await vi.advanceTimersByTimeAsync(999)
  expect(socket.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(socket.terminate).toHaveBeenCalledOnce()
  expect(socket.count()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
