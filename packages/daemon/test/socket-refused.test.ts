import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { socketRefused } from '../src/supervisor/socket-refused.js'

afterEach(() => vi.useRealTimers())
it('uses the default 1000ms deadline and destroys an unresponsive probe', async () => {
  vi.useFakeTimers()
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  let settled = false
  const outcome = socketRefused('/test', () => socket as unknown as Socket).then((value) => {
    settled = true
    return value
  })
  await vi.advanceTimersByTimeAsync(999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await outcome).toBe(false)
  expect(socket.destroy).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it.each(['ECONNREFUSED', 'EACCES', 'ENOENT'])(
  'only confirmed refusal permits stale reclamation: %s',
  async (code) => {
    vi.useFakeTimers()
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const outcome = socketRefused('/test', () => socket as unknown as Socket)
    socket.emit('error', { code })
    expect(await outcome).toBe(code === 'ECONNREFUSED')
    expect(vi.getTimerCount()).toBe(0)
  },
)
