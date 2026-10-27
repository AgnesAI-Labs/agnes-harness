import { afterEach, expect, it, vi } from 'vitest'
import { loadHistory } from '../src/load-history.js'

afterEach(() => vi.useRealTimers())

it.each(['idle', 'hard', 'done', 'disconnect', 'startup'] as const)(
  'bounds a progressing history load at %s and disposes observers',
  async (mode) => {
    vi.useFakeTimers()
    let listener: (method: string, params: unknown) => void = () => {}
    const off = vi.fn()
    let finish!: () => void
    let drop!: (error: Error) => void
    const request = new Promise<void>((resolve, reject) => {
      finish = resolve
      drop = reject
    })
    const onProgress = vi.fn()
    const loading = loadHistory({
      sessionId: 's',
      idleMs: 20,
      hardMs: 50,
      subscribe(fn) {
        listener = fn
        return off
      },
      request(signal) {
        signal.addEventListener('abort', () => drop(signal.reason), { once: true })
        return request
      },
      onProgress,
    })
    const result = loading.then(
      () => 'ok',
      (error: Error) => error.message,
    )
    const progress = (seq: number, id = 's') =>
      listener('_agnes/v1/session.loading', {
        sessionId: id,
        phase: 'verifying',
        verifiedSeq: seq,
        lastSeq: 100,
      })
    if (mode === 'idle') {
      await vi.advanceTimersByTimeAsync(10)
      progress(10, 'other')
      progress(-1)
      await vi.advanceTimersByTimeAsync(11)
      expect(await result).toContain('idle')
      expect(onProgress).not.toHaveBeenCalled()
    } else if (mode === 'hard') {
      for (let seq = 1; seq <= 5; seq++) {
        await vi.advanceTimersByTimeAsync(10)
        progress(seq)
      }
      expect(await result).toContain('hard')
    } else if (mode === 'done') {
      await vi.advanceTimersByTimeAsync(15)
      progress(1)
      await vi.advanceTimersByTimeAsync(15)
      progress(1) // Duplicate notices do not count as forward progress.
      finish()
      expect(await result).toBe('ok')
    } else if (mode === 'startup') {
      // The daemon announces a cold open before any ledger progress exists; verifiedSeq 0 with an
      // empty ledger must still reset the idle deadline.
      await vi.advanceTimersByTimeAsync(10)
      listener('_agnes/v1/session.loading', {
        sessionId: 's',
        phase: 'verifying',
        verifiedSeq: 0,
        lastSeq: 0,
      })
      await vi.advanceTimersByTimeAsync(15)
      finish()
      expect(await result).toBe('ok')
    } else {
      drop(new Error('transport closed'))
      expect(await result).toBe('transport closed')
    }
    expect(off).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  },
)
