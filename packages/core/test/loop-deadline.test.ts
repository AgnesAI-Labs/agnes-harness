import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withLoopDeadline } from '../src/step/loop-deadline.js'

const loop = { id: 'test.loop', version: '1.0.0' }
const settleAfter = (ms: number) => new Promise<string>((resolve) => setTimeout(() => resolve('done'), ms))

describe('loop step deadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('does not count time spent waiting on work the platform owns', async () => {
    let waiting = true
    setTimeout(() => {
      waiting = false
    }, 85)
    const result = expect(
      withLoopDeadline({
        loop,
        idleMs: 20,
        progress: () => 0,
        waiting: () => waiting,
        run: () => settleAfter(95),
        expire: () => {
          throw new Error('expired while waiting on a person')
        },
      }),
    ).resolves.toBe('done')
    await vi.advanceTimersByTimeAsync(95)
    await result
  })

  it('keeps waiting while the ledger advances, and expires a silent driver naming the loop', async () => {
    let seq = 0
    const tick = setInterval(() => seq++, 5)
    const progressing = expect(
      withLoopDeadline({
        loop,
        idleMs: 20,
        progress: () => seq,
        waiting: () => false,
        run: () => settleAfter(80),
        expire: () => undefined,
      }),
    ).resolves.toBe('done')
    await vi.advanceTimersByTimeAsync(80)
    await progressing
    clearInterval(tick)
    let expired = false
    const silent = expect(
      withLoopDeadline({
        loop,
        idleMs: 20,
        progress: () => seq,
        waiting: () => false,
        run: () => new Promise<never>(() => undefined),
        expire: () => {
          expired = true
        },
      }),
    ).rejects.toMatchObject({ code: 'E_LOOP_TIMEOUT', message: expect.stringContaining('test.loop@1.0.0') })
    await vi.advanceTimersByTimeAsync(20)
    await silent
    expect(expired).toBe(true)
  })

  it('holds a window longer than one runtime timer can express', async () => {
    const result = expect(
      withLoopDeadline({
        loop,
        idleMs: 2 ** 31 + 5,
        progress: () => 0,
        waiting: () => false,
        run: () => settleAfter(40),
        expire: () => {
          throw new Error('expired inside the window')
        },
      }),
    ).resolves.toBe('done')
    await vi.advanceTimersByTimeAsync(40)
    await result
  })

  it.each([false, true])('bounds cancellation even while platform waiting is %s', async (waiting) => {
    const abort = new AbortController()
    let ended = false
    let revoked = false
    const running = withLoopDeadline({
      loop,
      idleMs: 60_000,
      progress: () => Date.now(),
      waiting: () => waiting,
      signal: abort.signal,
      run: () => new Promise<never>(() => {}),
      expire: () => {
        throw new Error('not an idle timeout')
      },
      cancel: () => {
        revoked = true
      },
    }).catch((error: unknown) => {
      ended = true
      expect(error).toMatchObject({ code: 'E_CLOSED' })
    })
    abort.abort()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ended).toBe(true)
    expect(revoked).toBe(true)
    await running
    expect(vi.getTimerCount()).toBe(0)
  })
})
