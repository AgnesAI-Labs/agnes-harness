import { describe, expect, it } from 'vitest'
import { withLoopDeadline } from '../src/step/loop-deadline.js'

const loop = { id: 'test.loop', version: '1.0.0' }
const settleAfter = (ms: number) => new Promise<string>((resolve) => setTimeout(() => resolve('done'), ms))

describe('loop step deadline', () => {
  it('does not count time spent waiting on a person', async () => {
    let waiting = true
    setTimeout(() => {
      waiting = false
    }, 85)
    await expect(
      withLoopDeadline({
        loop,
        idleMs: 20,
        progress: () => 0,
        waitingOnHuman: () => waiting,
        run: () => settleAfter(95),
        expire: () => {
          throw new Error('expired while waiting on a person')
        },
      }),
    ).resolves.toBe('done')
  })

  it('keeps waiting while the ledger advances, and expires a silent driver naming the loop', async () => {
    let seq = 0
    const tick = setInterval(() => seq++, 5)
    await expect(
      withLoopDeadline({
        loop,
        idleMs: 20,
        progress: () => seq,
        waitingOnHuman: () => false,
        run: () => settleAfter(80),
        expire: () => undefined,
      }),
    ).resolves.toBe('done')
    clearInterval(tick)
    let expired = false
    await expect(
      withLoopDeadline({
        loop,
        idleMs: 20,
        progress: () => seq,
        waitingOnHuman: () => false,
        run: () => new Promise<never>(() => undefined),
        expire: () => {
          expired = true
        },
      }),
    ).rejects.toMatchObject({ code: 'E_LOOP_TIMEOUT', message: expect.stringContaining('test.loop@1.0.0') })
    expect(expired).toBe(true)
  })
})
