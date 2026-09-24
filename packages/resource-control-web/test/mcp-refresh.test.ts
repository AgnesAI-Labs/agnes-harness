/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { watchMcpPanel } from '../src/mcp-refresh.js'

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
    await vi.advanceTimersByTimeAsync(2_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    root.hidden = true
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
