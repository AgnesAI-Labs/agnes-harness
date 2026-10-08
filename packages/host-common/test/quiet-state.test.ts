import { describe, expect, it, vi } from 'vitest'
import { HostQuietState } from '../src/quiet-state.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function pending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.finally(() => {
    settled = true
  })
  await Promise.resolve()
  return !settled
}

describe('HostQuietState', () => {
  it('treats an idle worker as an existing turn-safe boundary', async () => {
    const quiet = new HostQuietState()
    for (const point of ['turn', 'step', 'immediate'] as const) {
      const transaction = vi.fn(async (result: string) => result)
      await expect(quiet.withBoundary(point, undefined, transaction)).resolves.toBe('quiet')
      expect(transaction).toHaveBeenCalledWith('quiet')
    }
  })

  it('does not admit at leave and holds the yielding session through the transaction', async () => {
    const quiet = new HostQuietState()
    const transaction = deferred()
    let entered = false
    quiet.enter('session-a')
    const applying = quiet.withBoundary('step', undefined, async () => {
      entered = true
      await transaction.promise
    })
    quiet.leave('session-a')
    await Promise.resolve()
    expect(entered).toBe(false)
    const yielded = quiet.yieldPoint('step', 'session-a')
    await vi.waitFor(() => expect(entered).toBe(true))
    expect(await pending(yielded)).toBe(true)
    transaction.resolve()
    await Promise.all([applying, yielded])
  })

  it('requires a turn boundary for turn policy but accepts turn for step policy', async () => {
    const quiet = new HostQuietState()
    quiet.enter('session-a')
    const entered = vi.fn()
    const applying = quiet.withBoundary('turn', undefined, async () => entered())
    quiet.leave('session-a')
    await quiet.yieldPoint('step', 'session-a')
    expect(entered).not.toHaveBeenCalled()
    const yielded = quiet.yieldPoint('turn', 'session-a')
    await applying
    await yielded
    expect(entered).toHaveBeenCalledOnce()

    await expect(quiet.withBoundary('step', undefined, async (result) => result)).resolves.toBe('quiet')
  })

  it('does not hold a child yield while its parent remains active in the same group', async () => {
    const quiet = new HostQuietState()
    quiet.enter('root')
    quiet.enter('root')
    let entered = false
    const applying = quiet.withBoundary('step', undefined, async () => {
      entered = true
    })
    quiet.leave('root')
    await quiet.yieldPoint('turn', 'root')
    expect(entered).toBe(false)
    quiet.leave('root')
    const parentYield = quiet.yieldPoint('step', 'root')
    await applying
    await parentYield
    expect(entered).toBe(true)
  })

  it('holds every independent session at its boundary until reconcile finishes', async () => {
    const quiet = new HostQuietState()
    quiet.enter('session-a')
    quiet.enter('session-b')
    const transaction = deferred()
    const events: string[] = []
    const applying = quiet.withBoundary('step', undefined, async () => {
      events.push('reconcile')
      expect(quiet.stepping).toBe(0)
      await transaction.promise
    })

    quiet.leave('session-a')
    const aYield = quiet.yieldPoint('step', 'session-a').then(() => events.push('a-resume'))
    expect(await pending(aYield)).toBe(true)
    quiet.leave('session-b')
    const bYield = quiet.yieldPoint('step', 'session-b').then(() => events.push('b-resume'))
    const cEntry = Promise.resolve(quiet.enter('session-c')).then(() => events.push('c-enter'))
    await vi.waitFor(() => expect(events).toEqual(['reconcile']))
    expect(await pending(aYield)).toBe(true)
    expect(await pending(bYield)).toBe(true)
    expect(await pending(cEntry)).toBe(true)
    transaction.resolve()
    await Promise.all([applying, aYield, bYield, cEntry])
    expect(events[0]).toBe('reconcile')
    expect(events.slice(1).sort()).toEqual(['a-resume', 'b-resume', 'c-enter'])
    quiet.leave('session-c')
  })

  it('blocks an existing group from re-entering while its boundary is held', async () => {
    const quiet = new HostQuietState()
    quiet.enter('session-a')
    const transaction = deferred()
    const applying = quiet.withBoundary('step', undefined, () => transaction.promise)
    quiet.leave('session-a')
    const yielded = quiet.yieldPoint('step', 'session-a')
    const reentry = Promise.resolve(quiet.enter('session-a'))
    expect(await pending(reentry)).toBe(true)
    transaction.resolve()
    await Promise.all([applying, yielded, reentry])
    expect(quiet.stepping).toBe(1)
    quiet.leave('session-a')
  })

  it('releases held sessions when maxWait falls back to immediate', async () => {
    const quiet = new HostQuietState()
    quiet.enter('session-a')
    quiet.enter('session-b')
    let result: string | undefined
    const applying = quiet.withBoundary('turn', 1, async (value) => {
      result = value
    })
    quiet.leave('session-a')
    const yielded = quiet.yieldPoint('turn', 'session-a')
    expect(await pending(yielded)).toBe(true)
    await applying
    await yielded
    expect(result).toBe('timeout')
    quiet.leave('session-b')
    await quiet.yieldPoint('turn', 'session-b')
  })

  it('rejects an unbalanced leave per group', () => {
    const quiet = new HostQuietState()
    expect(() => quiet.leave('missing')).toThrow('E_QUIET_GATE_UNBALANCED')
    quiet.enter('session-a')
    expect(() => quiet.leave('session-b')).toThrow('E_QUIET_GATE_UNBALANCED')
  })
})
