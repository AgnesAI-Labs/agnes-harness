import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { TransportClosed } from '../src/errors.js'
import { unixTransport } from '../src/transport/unix.node.js'

const state = vi.hoisted(() => ({ socket: undefined as unknown }))
vi.mock('node:net', () => ({ createConnection: () => state.socket }))
afterEach(() => vi.useRealTimers())
it.skipIf(process.platform === 'win32')(
  'enforces the omitted default 3000ms deadline and tears down a hung POSIX connection once',
  async () => {
    vi.useFakeTimers()
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    state.socket = socket
    const onClose = vi.fn()
    let settled = false
    const result = unixTransport({ path: '/test' })({ onMessage() {}, onClose }).catch((error: unknown) => {
      settled = true
      return error
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await result).toBeInstanceOf(TransportClosed)
    socket.emit('error', new Error('PRIVATE'))
    socket.emit('close')
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  },
)
