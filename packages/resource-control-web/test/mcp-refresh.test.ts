/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { resourcePollDelay, watchMcpPanel } from '../src/mcp-refresh.js'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})
it('refreshes external MCP changes without polling hidden panels or surviving disposal', async () => {
  vi.useFakeTimers()
  const root = document.createElement('section')
  document.body.append(root)
  const refresh = vi.fn(async () => {})
  const dispose = watchMcpPanel({ root, visible: () => !root.hidden, refresh })
  try {
    await vi.advanceTimersByTimeAsync(120_000)
    expect(refresh).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    root.hidden = true
    window.dispatchEvent(new Event('agnes:plugins-invalidated'))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    root.hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    dispose()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  } finally {
    dispose()
  }
})

it('backs off active resource reads and waits for visibility or cancellation', async () => {
  vi.useFakeTimers()
  let hidden = false
  const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  const lifetime = new AbortController()
  try {
    // Fast local operations should settle promptly, while slow operations still back off to 30s.
    for (const [attempt, delay] of [
      [0, 50],
      [1, 100],
      [2, 200],
      [3, 500],
      [4, 1000],
      [9, 30_000],
      [119, 30_000],
    ] as const) {
      const ready = vi.fn()
      const waiting = resourcePollDelay(attempt, lifetime.signal).then(ready)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(ready).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(ready).toHaveBeenCalledOnce()
      await waiting
    }
    hidden = true
    const ready = vi.fn()
    const waiting = resourcePollDelay(2, lifetime.signal).then(ready)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ready).not.toHaveBeenCalled()
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await waiting
    expect(ready).toHaveBeenCalledOnce()
    const next = resourcePollDelay(6, lifetime.signal).then(ready)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ready).toHaveBeenCalledOnce()
    lifetime.abort()
    await next
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    lifetime.abort()
    visibility.mockRestore()
  }
})
