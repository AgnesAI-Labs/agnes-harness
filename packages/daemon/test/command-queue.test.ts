import { describe, expect, it } from 'vitest'
import { CommandQueue, CommandQueueError } from '../src/local/command-queue.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
const signal = () => new AbortController().signal

describe('CommandQueue', () => {
  it('runs one session FIFO while another session progresses independently', async () => {
    const queue = new CommandQueue()
    const first = deferred<void>()
    const order: string[] = []
    const a = queue.run('a', signal(), async () => {
      order.push('a1-start')
      await first.promise
      order.push('a1-end')
    })
    const a2 = queue.run('a', signal(), async () => void order.push('a2'))
    await queue.run('b', signal(), async () => void order.push('b1'))
    expect(order).toEqual(['a1-start', 'b1'])
    first.resolve()
    await Promise.all([a, a2])
    expect(order).toEqual(['a1-start', 'b1', 'a1-end', 'a2'])
  })

  it('counts active and waiting items against global and per-session limits', async () => {
    const perSession = new CommandQueue({ maxPending: 3, maxPerSession: 2 })
    const hold = deferred<void>()
    const active = perSession.run('a', signal(), () => hold.promise)
    const waiting = perSession.run('a', signal(), async () => undefined)
    await expect(perSession.run('a', signal(), async () => undefined)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    })
    const other = perSession.run('b', signal(), async () => undefined)
    await expect(perSession.run('c', signal(), async () => undefined)).rejects.toBeInstanceOf(
      CommandQueueError,
    )
    hold.resolve()
    await Promise.all([active, waiting, other])
  })

  it('removes an aborted waiter without running it and retains an aborted active slot until settle', async () => {
    const queue = new CommandQueue({ maxPending: 1, maxPerSession: 1 })
    const settle = deferred<void>()
    const activeAbort = new AbortController()
    let sawAbort = false
    const active = queue.run('a', activeAbort.signal, async (runSignal) => {
      runSignal.addEventListener('abort', () => (sawAbort = true), { once: true })
      await settle.promise
    })
    activeAbort.abort()
    await Promise.resolve()
    expect(sawAbort).toBe(true)
    await expect(queue.run('b', signal(), async () => undefined)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    })
    settle.resolve()
    await active

    const waitingQueue = new CommandQueue()
    const blocker = deferred<void>()
    const first = waitingQueue.run('a', signal(), () => blocker.promise)
    const waitingAbort = new AbortController()
    let called = false
    const waiting = waitingQueue.run('a', waitingAbort.signal, async () => {
      called = true
    })
    waitingAbort.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
    blocker.resolve()
    await first
    expect(called).toBe(false)
  })

  it('checks the fence at admission and immediately before execution', async () => {
    const queue = new CommandQueue()
    let generation = 1
    const guard = () => {
      if (generation !== 1) throw new Error('GENERATION_STALE')
    }
    const hold = deferred<void>()
    const first = queue.run('a', signal(), () => hold.promise)
    const stale = queue.run('a', signal(), async () => undefined, guard)
    generation = 2
    hold.resolve()
    await first
    await expect(stale).rejects.toThrow('GENERATION_STALE')
    expect(() => queue.run('b', signal(), async () => undefined, guard)).toThrow('GENERATION_STALE')
  })

  it('closes idempotently, rejects waiters, aborts active work and waits for settlement', async () => {
    const queue = new CommandQueue()
    const settle = deferred<void>()
    let aborted = false
    const active = queue.run('a', signal(), async (runSignal) => {
      runSignal.addEventListener('abort', () => (aborted = true), { once: true })
      await settle.promise
    })
    const waiting = queue.run('a', signal(), async () => undefined)
    const closing = queue.close()
    expect(queue.close()).toBe(closing)
    await expect(waiting).rejects.toMatchObject({ code: 'CLOSED' })
    expect(aborted).toBe(true)
    let closed = false
    void closing.then(() => (closed = true))
    await Promise.resolve()
    expect(closed).toBe(false)
    await expect(queue.run('b', signal(), async () => undefined)).rejects.toMatchObject({ code: 'CLOSED' })
    settle.resolve()
    await Promise.all([active, closing])
  })
})
