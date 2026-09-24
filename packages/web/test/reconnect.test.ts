/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReconnectController } from '../src/reconnect.js'

describe('reconnect controller', () => {
  afterEach(() => vi.useRealTimers())

  it('uses bounded backoff and persists the attempt count', () => {
    vi.useFakeTimers()
    const storage = sessionStorage
    storage.clear()
    const reload = vi.fn()
    const controller = createReconnectController({ reload, storage })
    controller.start()
    vi.advanceTimersByTime(999)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
    controller.start()
    vi.advanceTimersByTime(2000)
    expect(reload).toHaveBeenCalledTimes(2)
    controller.start()
    vi.advanceTimersByTime(4000)
    expect(reload).toHaveBeenCalledTimes(3)
    controller.start()
    vi.runAllTimers()
    expect(reload).toHaveBeenCalledTimes(3)
    expect(controller.attempts()).toBe(3)
  })

  it('does not reload after cancellation', () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    const controller = createReconnectController({ reload, storage: sessionStorage })
    controller.start()
    controller.cancel()
    vi.runAllTimers()
    expect(reload).not.toHaveBeenCalled()
  })
})
