import { expect, it, vi } from 'vitest'
import { startPluginHotReload } from '../src/client-modules/hot-reload.js'

it('serializes finite reload requests, retries failed packages, resets missed hints and aborts on close', async () => {
  vi.useFakeTimers()
  const requests: { url: string; signal: AbortSignal }[] = []
  const seen: string[] = []
  let round = 0
  const onReset = vi.fn()
  const stop = startPluginHotReload({
    intervalMs: 100,
    fetch: async (url, init) => {
      requests.push({ url: String(url), signal: init!.signal! })
      return Response.json({
        epoch: 'one',
        cursor: ++round,
        reset: round === 3,
        events: [{ id: 'a', rev: round === 1 ? 'one' : 'two' }],
      })
    },
    reconciler: {
      reconcileNow: async () => undefined,
      invalidate: async () => undefined,
      subscribe: () => () => undefined,
      snapshot: () => new Map(),
      reload: async (id, rev) => {
        seen.push(`${id}@${rev}`)
        if (rev === 'one') throw new Error('temporary')
      },
    },
    onError: () => undefined,
    onReset,
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(seen).toEqual(['a@one', 'a@two'])
    expect(requests.map((r) => r.url)).toEqual(['/plugins/changes', '/plugins/changes?epoch=one&cursor=1'])
    await vi.advanceTimersByTimeAsync(100)
    expect(onReset).toHaveBeenCalledOnce()
    expect(seen).toEqual(['a@one', 'a@two'])
    stop()
    expect(requests.every((r) => r.signal.aborted)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(3)
  } finally {
    stop()
    vi.useRealTimers()
  }
})
