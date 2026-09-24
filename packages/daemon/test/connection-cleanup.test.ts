import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { bindConnection } from '../src/supervisor/connection.js'

afterEach(() => vi.useRealTimers())
it('uses the default 1000ms final-error flush deadline and closes the endpoint exactly once', async () => {
  vi.useFakeTimers()
  const socket = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    writableLength: 0,
  })
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
  const close = vi.spyOn(ep, 'close')
  const onClose = vi.fn()
  const connection = bindConnection(socket as unknown as Socket, ep, { onClose })
  socket.emit('data', Buffer.from('null\n'))
  expect(socket.end).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(999)
  expect(socket.destroy).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(socket.destroy).toHaveBeenCalledOnce()
  socket.emit('close')
  socket.emit('close')
  await connection.closed
  expect(close).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
